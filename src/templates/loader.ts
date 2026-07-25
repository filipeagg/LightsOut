/**
 * Project template loading (TP-01, TP-03, DESIGN §16.1).
 *
 * Same two layers as the agents loader: `builtin/templates/` first, `$WORKSPACE/templates/`
 * second, an id in the second replacing the first wholesale (§2). A template whose agents do
 * not resolve is kept in the report with its reason and cannot be selected — the AP-02
 * behaviour, applied to templates.
 */
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
import { builtinDir } from "../agents/loader.js";
import {
  projectTemplateSchema,
  type ProjectTemplate,
  type RejectedTemplate,
} from "./schema.js";

export type TemplatesSnapshot = {
  templates: Map<string, ProjectTemplate>;
  rejected: RejectedTemplate[];
};

export type TemplateLoadReport = {
  loaded: number;
  fromWorkspace: number;
  rejected: RejectedTemplate[];
};

const YAML_EXT = new Set([".yaml", ".yml"]);

async function listYaml(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && YAML_EXT.has(path.extname(e.name).toLowerCase()))
      .map((e) => path.join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

/** Resolves an agent id to a loaded, enabled profile (AP-07). */
export type AgentResolver = (id: string) => boolean;

export class TemplatesLoader {
  private snapshot: TemplatesSnapshot = { templates: new Map(), rejected: [] };
  private fingerprint = "";
  private pollTimer: NodeJS.Timeout | undefined;
  private polling = false;

  constructor(
    private readonly workspace: string,
    private readonly agentExists: AgentResolver,
    private readonly onReload?: (report: TemplateLoadReport) => void,
  ) {}

  get templatesDir(): string {
    return path.join(this.workspace, "templates");
  }

  current(): TemplatesSnapshot {
    return this.snapshot;
  }

  list(): ProjectTemplate[] {
    return [...this.snapshot.templates.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): ProjectTemplate | undefined {
    return this.snapshot.templates.get(id);
  }

  getOrThrow(id: string): ProjectTemplate {
    const found = this.get(id);
    if (found) return found;
    const rejected = this.snapshot.rejected.find((r) => r.id === id);
    if (rejected) throw new Error(`template ${id} is not usable: ${rejected.error}`);
    const known = this.list().map((t) => t.id).join(", ") || "none";
    throw new Error(`unknown template: ${id} (available: ${known})`);
  }

  async load(): Promise<TemplateLoadReport> {
    await mkdir(this.templatesDir, { recursive: true });

    const templates = new Map<string, ProjectTemplate>();
    const rejected: RejectedTemplate[] = [];
    let fromWorkspace = 0;

    for (const [layer, dir] of [
      ["builtin", builtinDir("templates")],
      ["workspace", this.templatesDir],
    ] as const) {
      for (const file of await listYaml(dir)) {
        const label =
          layer === "builtin"
            ? path.join("builtin/templates", path.basename(file))
            : path.basename(file);
        const fallbackId = path.basename(file).replace(/\.(ya?ml)$/i, "");
        try {
          const raw = loadYaml(await readFile(file, "utf8"));
          if (raw === null || typeof raw !== "object") {
            throw new Error("file is empty or not a YAML mapping");
          }
          const parsed = projectTemplateSchema.parse({
            id: fallbackId,
            ...(raw as Record<string, unknown>),
          });
          const missing = parsed.phases
            .map((phase) => phase.agent)
            .filter((agent, index, all) => all.indexOf(agent) === index)
            .filter((agent) => !this.agentExists(agent));
          if (missing.length > 0) {
            throw new Error(`unknown or disabled agent(s): ${missing.join(", ")}`);
          }
          if (layer === "workspace") fromWorkspace += 1;
          templates.set(parsed.id, parsed);
        } catch (err) {
          rejected.push({
            file: label,
            id: fallbackId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    this.snapshot = { templates, rejected };
    this.fingerprint = await this.treeFingerprint();
    return { loaded: templates.size, fromWorkspace, rejected };
  }

  /** Same poll-a-fingerprint approach as the agents loader: bind mounts drop inotify events. */
  private async treeFingerprint(): Promise<string> {
    const parts: string[] = [];
    for (const dir of [builtinDir("templates"), this.templatesDir]) {
      for (const file of await listYaml(dir)) {
        try {
          const info = await stat(file);
          parts.push(`${file}:${info.size}:${info.mtimeMs}`);
        } catch {
          // vanished between listing and stat: the next poll sees the final state
        }
      }
    }
    return parts.join("\n");
  }

  startWatching(pollMs = 2000): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, pollMs);
    this.pollTimer.unref?.();
  }

  async pollOnce(): Promise<boolean> {
    if (this.polling) return false;
    this.polling = true;
    try {
      const next = await this.treeFingerprint();
      if (next === this.fingerprint) return false;
      const report = await this.load();
      this.onReload?.(report);
      return true;
    } catch {
      return false;
    } finally {
      this.polling = false;
    }
  }

  stopWatching(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }
}
