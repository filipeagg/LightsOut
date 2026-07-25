/**
 * Browser-driven engine login (SU-04, DESIGN §14.4).
 *
 * The panel cannot hand the user a terminal, so the container runs the engine CLI's own login
 * with piped stdio, parses the verification URL and code out of its output, and streams both to
 * the browser. The loopback forwarder of `src/net/forwarder.ts` is armed for the lifetime of the
 * flow so the OAuth callback published on 127.0.0.1:1455 reaches the CLI's listener.
 *
 * Nothing here interprets credentials: the CLI writes them into its own volume and the health
 * probe reports the outcome. That keeps the "never read a secret" promise (NF-02) literal.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { startForwarder, type Forwarder } from "../net/forwarder.js";
import type { EngineHealth, EngineName } from "../health.js";

export const CALLBACK_PORT = Number(process.env.LO_CALLBACK_PORT ?? 1455);

/** Kill a flow that the user abandoned rather than leaving a CLI waiting forever. */
const FLOW_TIMEOUT_MS = 10 * 60 * 1000;

export type FlowEvent =
  | { type: "log"; line: string }
  | { type: "url"; url: string }
  | { type: "code"; code: string }
  | { type: "done"; exitCode: number; auth: boolean; authSource: string | null }
  | { type: "error"; message: string };

export type FlowState = {
  id: string;
  engine: EngineName;
  startedAt: string;
  finished: boolean;
  events: FlowEvent[];
};

/** Login commands, one per engine. Mirrors `dist/cli/login.js` so both paths behave alike. */
const LOGIN_COMMAND: Record<EngineName, string[]> = {
  claude: ["claude", "auth", "login", "--claudeai"],
  codex: ["codex", "login"],
};

/** Key ingestion through the engine's own CLI; the key arrives on stdin, never in argv (NF-03). */
const KEY_COMMAND: Record<EngineName, string[]> = {
  claude: ["claude", "auth", "login", "--api-key"],
  codex: ["codex", "login", "--with-api-key"],
};

/**
 * What this needs from the health probe. Narrow on purpose: the unit tests drive the flow
 * machinery with a stub, because a real `codex login` deletes the existing credentials the
 * moment it starts, so exercising it for real would log the machine out.
 */
export type AuthProbe = {
  invalidate: () => void;
  engines: (force?: boolean) => Promise<EngineHealth[]>;
};

export type LoginCommands = {
  login?: Partial<Record<EngineName, string[]>>;
  key?: Partial<Record<EngineName, string[]>>;
};

const URL_RE = /https?:\/\/[^\s"'<>)]+/;
/** Device codes are printed in several shapes; these are the two both CLIs have used. */
const CODE_RE = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b|(?:code|Code)[:\s]+([A-Za-z0-9-]{6,})/;

/** Strip ANSI so a spinner does not end up in the browser. */
function clean(text: string): string {
  return text.replace(/\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "\n");
}

export class LoginFlows {
  private readonly flows = new Map<string, FlowState>();
  private readonly listeners = new Map<string, Set<(event: FlowEvent) => void>>();
  private readonly children = new Map<string, ChildProcessWithoutNullStreams>();

  constructor(
    private readonly health: AuthProbe,
    private readonly commands: LoginCommands = {},
  ) {}

  private loginCommand(engine: EngineName): string[] {
    return this.commands.login?.[engine] ?? LOGIN_COMMAND[engine];
  }

  private keyCommand(engine: EngineName): string[] {
    return this.commands.key?.[engine] ?? KEY_COMMAND[engine];
  }

  get(flowId: string): FlowState | undefined {
    return this.flows.get(flowId);
  }

  /** Subscribe to a flow; buffered events are replayed first so a late browser misses nothing. */
  subscribe(flowId: string, listener: (event: FlowEvent) => void): () => void {
    const flow = this.flows.get(flowId);
    if (!flow) throw new Error(`unknown login flow: ${flowId}`);
    for (const event of flow.events) listener(event);
    let set = this.listeners.get(flowId);
    if (!set) {
      set = new Set();
      this.listeners.set(flowId, set);
    }
    const registered = set;
    registered.add(listener);
    return () => {
      registered.delete(listener);
    };
  }

  private emit(flowId: string, event: FlowEvent): void {
    const flow = this.flows.get(flowId);
    if (!flow) return;
    flow.events.push(event);
    for (const listener of this.listeners.get(flowId) ?? []) listener(event);
  }

  /** Start an interactive login; returns the flow id the panel subscribes to. */
  async start(engine: EngineName): Promise<string> {
    const id = randomUUID();
    this.flows.set(id, {
      id,
      engine,
      startedAt: new Date().toISOString(),
      finished: false,
      events: [],
    });

    let forwarder: Forwarder | null = null;
    try {
      forwarder = await startForwarder(CALLBACK_PORT, (line) =>
        this.emit(id, { type: "log", line }),
      );
      if (forwarder.addresses.length === 0) {
        this.emit(id, {
          type: "log",
          line: "no external address to forward from; the browser callback may not arrive",
        });
      }
    } catch (err) {
      this.emit(id, {
        type: "log",
        line: `forwarder unavailable: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    const [bin, ...args] = this.loginCommand(engine);
    const child = spawn(bin as string, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.children.set(id, child);

    let sawUrl = false;
    let sawCode = false;
    const consume = (chunk: Buffer) => {
      for (const line of clean(chunk.toString("utf8")).split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        this.emit(id, { type: "log", line: trimmed });
        if (!sawUrl) {
          const url = URL_RE.exec(trimmed)?.[0];
          if (url) {
            sawUrl = true;
            this.emit(id, { type: "url", url });
          }
        }
        if (!sawCode) {
          const match = CODE_RE.exec(trimmed);
          const code = match?.[1] ?? match?.[2];
          if (code) {
            sawCode = true;
            this.emit(id, { type: "code", code });
          }
        }
      }
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.on("error", (err) => this.emit(id, { type: "error", message: err.message }));

    const timer = setTimeout(() => {
      if (!child.killed) child.kill("SIGTERM");
      this.emit(id, { type: "error", message: "login timed out after 10 minutes" });
    }, FLOW_TIMEOUT_MS);
    timer.unref();

    child.on("close", (code) => {
      clearTimeout(timer);
      void this.finish(id, code ?? 1, forwarder);
    });

    return id;
  }

  /**
   * Store an API key through the engine's own CLI (NF-03). The key goes in on stdin, never in
   * argv, so it cannot appear in a process listing. Returns the CLI's exit code and the auth
   * state that follows, so a CLI without key ingestion reports itself instead of being guessed.
   */
  async storeApiKey(
    engine: EngineName,
    key: string,
  ): Promise<{ exitCode: number; auth: boolean; authSource: string | null; output: string }> {
    const [bin, ...args] = this.keyCommand(engine);
    return await new Promise((resolve) => {
      const child = spawn(bin as string, args, { stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      const collect = (chunk: Buffer) => {
        output += clean(chunk.toString("utf8"));
        if (output.length > 8192) output = output.slice(-8192);
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.on("error", (err) => {
        resolve({ exitCode: 127, auth: false, authSource: null, output: err.message });
      });
      child.on("close", (code) => {
        void (async () => {
          this.health.invalidate();
          const probe = (await this.health.engines(true)).find((e) => e.engine === engine);
          resolve({
            exitCode: code ?? 1,
            auth: probe?.auth ?? false,
            authSource: probe?.authSource ?? null,
            output: output.trim().split("\n").slice(-6).join("\n"),
          });
        })();
      });
      child.stdin.end(`${key.trim()}\n`);
    });
  }

  /** Abandon a running flow (the user closed the wizard, or restarted the step). */
  cancel(flowId: string): boolean {
    const child = this.children.get(flowId);
    if (!child || child.killed) return false;
    child.kill("SIGTERM");
    return true;
  }

  private async finish(id: string, exitCode: number, forwarder: Forwarder | null): Promise<void> {
    this.children.delete(id);
    if (forwarder) await forwarder.close();
    this.health.invalidate();
    const flow = this.flows.get(id);
    const probe = flow
      ? (await this.health.engines(true)).find((e) => e.engine === flow.engine)
      : undefined;
    this.emit(id, {
      type: "done",
      exitCode,
      auth: probe?.auth ?? false,
      authSource: probe?.authSource ?? null,
    });
    if (flow) flow.finished = true;
  }

  /** Terminate every live flow (graceful shutdown, RT-07). */
  closeAll(): void {
    for (const child of this.children.values()) {
      if (!child.killed) child.kill("SIGTERM");
    }
    this.children.clear();
  }
}
