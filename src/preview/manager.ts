/**
 * Preview servers: LightsOut owns the process, not the agent (PV-01..03, DESIGN §21).
 *
 * The failure this replaces: a dev server run as an ordinary terminal command never ends, so it
 * holds the run's terminal open, produces no further events, and the inactivity watchdog kills the
 * run that started it. The agent did nothing wrong and the run failed anyway.
 *
 * Here it is detached, in its own process group, with its output to a log file, and it deliberately
 * outlives the run — the user looks at the result after the agent has finished. What keeps that
 * from becoming a pile of orphaned processes is that four separate things reap it: the TTL, an
 * explicit stop, the project going away, and the boot pass after a restart.
 */
import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.js";
import type { Repos } from "../db/repos/index.js";
import type { PreviewRow } from "../db/repos/previews.js";
import type { Bus } from "../bus.js";
import { SCRATCH_REL } from "../policy/classify.js";
import { normalisePreviewCommand } from "./normalise.js";
import { packageScripts } from "./detect.js";

export type StartPreviewInput = {
  projectId: string;
  command: string;
  /** Preferred port; refused when it is outside the pool or already taken. */
  port?: number;
  /** Directory to run in, relative to the project. Defaults to the project root. */
  cwd?: string;
  startedBy: string;
  ttlMinutes?: number;
};

export type PreviewView = {
  id: string;
  projectId: string;
  port: number;
  url: string;
  command: string;
  normalised: string | null;
  status: PreviewRow["status"];
  pid: number | null;
  startedAt: string;
  expiresAt: string | null;
  logPath: string;
  /** False when the row says running but the process is gone: a dead link is worse than none. */
  alive: boolean;
};

/** How often the reaper looks for expired previews. A minute is well under the shortest TTL. */
const SWEEP_MS = 60_000;

export class PreviewManager {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly config: Config,
    private readonly repos: Repos,
    private readonly bus: Bus,
  ) {}

  /** The URL the user's browser can open. The port is published on the host's loopback (PV-01). */
  private url(port: number): string {
    return `http://127.0.0.1:${port}`;
  }

  /**
   * Is the process still there? `kill(pid, 0)` asks without signalling. A row claiming to run with
   * nothing behind it is reconciled rather than reported, because the whole value of the URL is
   * that it loads.
   */
  private static alive(pid: number | null): boolean {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  view(row: PreviewRow): PreviewView {
    return {
      id: row.id,
      projectId: row.project_id,
      port: row.port,
      url: this.url(row.port),
      command: row.command,
      normalised: row.normalised,
      status: row.status,
      pid: row.pid,
      startedAt: row.started_at,
      expiresAt: row.expires_at,
      logPath: row.log_path,
      alive: row.status === "running" && PreviewManager.alive(row.pid),
    };
  }

  /**
   * The lowest free port in the pool. Free means: not claimed by a live row. The pool and the
   * `ports:` line in compose must agree — a port published there but not offered here is wasted,
   * one offered here but not published is a preview the browser cannot reach, and §21.2 says so.
   */
  private allocate(preferred?: number): number {
    const taken = this.repos.previews.portsInUse();
    const { previewPortFrom: from, previewPortTo: to } = this.config;
    if (preferred !== undefined) {
      if (preferred < from || preferred > to) {
        throw new Error(
          `port ${preferred} is outside the published preview pool (${from}-${to}); a port ` +
            `outside it is not reachable from the browser, so it is refused rather than opened`,
        );
      }
      if (taken.has(preferred)) throw new Error(`port ${preferred} is already serving a preview`);
      return preferred;
    }
    for (let port = from; port <= to; port += 1) {
      if (!taken.has(port)) return port;
    }
    throw new Error(
      `every preview port (${from}-${to}) is in use; stop one with preview_stop, or list them ` +
        `with list_previews to see what is still running`,
    );
  }

  async start(input: StartPreviewInput): Promise<PreviewView> {
    const project = this.repos.projects.getOrThrow(input.projectId);
    const port = this.allocate(input.port);

    const cwd = input.cwd ? path.resolve(project.path, input.cwd) : project.path;
    if (cwd !== project.path && !cwd.startsWith(project.path + path.sep)) {
      throw new Error(`cwd must be inside ${project.id}; ${input.cwd} escapes it`);
    }

    // PV-04: bind 0.0.0.0, take the allocated port, do not wander — and only add flags to a
    // program that has been identified, which means reading what `npm run dev` actually runs.
    const { command, notes } = normalisePreviewCommand(input.command, port, {
      scripts: packageScripts(cwd),
    });

    const logDir = path.join(project.path, SCRATCH_REL);
    await mkdir(logDir, { recursive: true });
    const logPath = path.join(logDir, `preview-${port}.log`);
    const fd = openSync(logPath, "a");

    const ttl = input.ttlMinutes ?? this.config.previewTtlMin;
    const expiresAt = new Date(Date.now() + ttl * 60_000).toISOString();

    // detached + its own process group: killing the preview must kill the whole tree a package
    // script spawns, and the preview must not die with whatever started it.
    const child = spawn("/bin/sh", ["-lc", command], {
      cwd,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...process.env, PORT: String(port), HOST: "0.0.0.0" },
    });
    child.unref();
    closeSync(fd);

    const row = this.repos.previews.start({
      projectId: project.id,
      port,
      command: input.command,
      normalised: command === input.command ? null : command,
      cwd,
      pid: child.pid ?? null,
      logPath,
      startedBy: input.startedBy,
      expiresAt,
    });

    this.repos.events.append({
      type: "preview.started",
      payload: {
        previewId: row.id,
        projectId: project.id,
        port,
        url: this.url(port),
        command,
        ...(notes.length ? { normalised: notes } : {}),
        actor: input.startedBy,
      },
    });
    this.bus.emit("overview");
    return this.view(row);
  }

  /**
   * Stop one, or every preview of a project. SIGTERM to the whole process group, then SIGKILL:
   * a dev server that ignores the first is common enough that hoping is not a plan.
   */
  async stop(
    selector: { previewId?: string; projectId?: string },
    reason = "stopped",
  ): Promise<{ stopped: number }> {
    const rows = selector.previewId
      ? [this.repos.previews.getOrThrow(selector.previewId)]
      : this.repos.previews.listRunning(selector.projectId);

    let stopped = 0;
    for (const row of rows) {
      if (row.status !== "running") continue;
      const killed = PreviewManager.killGroup(row.pid);
      this.repos.previews.finish(row.id, killed ? "stopped" : "exited", reason);
      if (killed) stopped += 1;
      this.repos.events.append({
        type: "preview.stopped",
        payload: {
          previewId: row.id,
          projectId: row.project_id,
          port: row.port,
          reason: killed ? reason : `${reason} (the process was already gone)`,
        },
      });
    }
    if (rows.length) this.bus.emit("overview");
    return { stopped };
  }

  /** SIGTERM the group, SIGKILL a moment later. Never throws: a stop must not fail on tidying. */
  private static killGroup(pid: number | null): boolean {
    if (!pid || !PreviewManager.alive(pid)) return false;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        return false;
      }
    }
    setTimeout(() => {
      try {
        if (PreviewManager.alive(pid)) process.kill(-pid, "SIGKILL");
      } catch {
        /* already gone, which is the outcome asked for */
      }
    }, 3000).unref();
    return true;
  }

  list(projectId?: string): PreviewView[] {
    return this.repos.previews.listRunning(projectId).map((row) => this.view(row));
  }

  /** The live preview of a project, for `project_status` and `status_card`. */
  current(projectId: string): PreviewView | null {
    const live = this.list(projectId).find((p) => p.alive);
    return live ?? null;
  }

  /** The last lines of a preview's log: where a misconfiguration actually shows up (§21.3). */
  async log(previewId: string, lines = 40): Promise<string[]> {
    const row = this.repos.previews.getOrThrow(previewId);
    try {
      const text = await readFile(row.log_path, "utf8");
      return text.split("\n").filter(Boolean).slice(-lines);
    } catch {
      return [];
    }
  }

  /**
   * One pass of the reaper: expire what has outlived its TTL, and reconcile rows whose process is
   * gone. Both are the same guarantee from two directions — what the table says is running is
   * running.
   */
  sweep(): { expired: number; reconciled: number } {
    const now = Date.now();
    let expired = 0;
    let reconciled = 0;
    for (const row of this.repos.previews.listRunning()) {
      if (!PreviewManager.alive(row.pid)) {
        this.repos.previews.finish(row.id, "exited", "the process is no longer running");
        reconciled += 1;
        continue;
      }
      if (row.expires_at && Date.parse(row.expires_at) <= now) {
        PreviewManager.killGroup(row.pid);
        this.repos.previews.finish(row.id, "expired", `outlived its TTL`);
        this.repos.events.append({
          type: "preview.stopped",
          payload: { previewId: row.id, projectId: row.project_id, port: row.port, reason: "TTL" },
        });
        expired += 1;
      }
    }
    if (expired || reconciled) this.bus.emit("overview");
    return { expired, reconciled };
  }

  startReaper(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.sweep();
      } catch {
        /* a sweep that throws must not take the process with it (§11.2b) */
      }
    }, SWEEP_MS);
    this.timer.unref();
  }

  stopReaper(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * At boot: every row claiming to run describes a process the restart already killed. They are
   * closed rather than left as links that do not load.
   */
  reconcileAtBoot(): number {
    let closed = 0;
    for (const row of this.repos.previews.listRunning()) {
      this.repos.previews.finish(row.id, "exited", "the container restarted");
      closed += 1;
    }
    return closed;
  }
}
