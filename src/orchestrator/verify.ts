/**
 * Verify gate (OR-04, DESIGN §5.2).
 * The command runs inside the container with the project as cwd. A non-zero exit sets the
 * task to `verify_failed` and pauses the chain; the tail of the output is persisted so the
 * failure is diagnosable from the database alone (OB-02).
 */
import { spawn } from "node:child_process";
import type { Repos } from "../db/repos/index.js";

export type VerifyResult = {
  ran: boolean;
  exitCode: number;
  /** Last lines of combined output, capped. */
  tailOutput: string;
  timedOut: boolean;
};

const TAIL_LINES = 40;
const TAIL_CHARS = 4000;

function tail(text: string): string {
  const lines = text.split("\n").slice(-TAIL_LINES).join("\n");
  return lines.length > TAIL_CHARS ? lines.slice(-TAIL_CHARS) : lines;
}

export async function runVerify(input: {
  repos: Repos;
  runId: string;
  cwd: string;
  command: string | null | undefined;
  timeoutMs?: number;
}): Promise<VerifyResult> {
  const command = (input.command ?? "").trim();
  if (!command) return { ran: false, exitCode: 0, tailOutput: "", timedOut: false };

  input.repos.events.append({
    runId: input.runId,
    type: "verify.start",
    payload: { cmd: command },
  });

  const result = await new Promise<VerifyResult>((resolve) => {
    // detached: the command gets its own process group, so a timeout can kill the whole
    // tree. Killing only the shell leaves grandchildren holding the pipes open and the
    // gate would hang instead of failing.
    const child = spawn("/bin/sh", ["-lc", command], {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let output = "";
    let timedOut = false;

    const killTree = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    const timer = setTimeout(
      () => {
        timedOut = true;
        killTree();
      },
      input.timeoutMs ?? 15 * 60_000,
    );
    timer.unref?.();

    const collect = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 200_000) output = output.slice(-100_000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ran: true, exitCode: 127, tailOutput: tail(`${output}\n${err.message}`), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ran: true,
        exitCode: timedOut ? 124 : (code ?? 1),
        tailOutput: tail(output),
        timedOut,
      });
    });
  });

  input.repos.events.append({
    runId: input.runId,
    type: "verify.result",
    payload: {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      tailOutput: result.tailOutput,
    },
  });
  return result;
}
