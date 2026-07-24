/**
 * Adapter process management (SR-01, DESIGN §6.1).
 * One child process per active run, spawned with the project directory as cwd and a scrubbed
 * environment: only what the adapter needs, never LightsOut secrets (NF-02).
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

export type SpawnAdapterInput = {
  /** Command line from LO_ADAPTER_*; may carry arguments. */
  command: string;
  cwd: string;
  /** Extra environment for the engine (config dirs, proxy vars). */
  env?: Record<string, string>;
  /** Called for each stderr line: adapter diagnostics (OB-04). */
  onStderr?: (line: string) => void;
};

export type AdapterProcess = {
  child: ChildProcessWithoutNullStreams;
  stream: acp.Stream;
  /** Cancel-friendly shutdown: SIGTERM, then SIGKILL after the grace period. */
  stop: (graceMs?: number) => Promise<void>;
};

/** Variables an engine adapter legitimately needs. Everything else is dropped (NF-02). */
const PASSTHROUGH_ENV = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "NODE_ENV",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

export function scrubEnv(
  source: NodeJS.ProcessEnv = process.env,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

export function spawnAdapter(input: SpawnAdapterInput): AdapterProcess {
  const [bin, ...args] = input.command.trim().split(/\s+/);
  if (!bin) throw new Error(`invalid adapter command: ${JSON.stringify(input.command)}`);

  const child = spawn(bin, args, {
    cwd: input.cwd,
    env: scrubEnv(process.env, input.env ?? {}),
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  if (input.onStderr) {
    let buffer = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) input.onStderr?.(line.trim());
    });
  }

  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );

  const stop = async (graceMs = 10_000): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      child.once("exit", done);
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, graceMs).unref?.();
    });
  };

  return { child, stream, stop };
}
