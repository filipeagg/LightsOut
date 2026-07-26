/**
 * Live runs (SR-06, OR-06, DESIGN §5.4).
 *
 * `RunSession.abort()` has existed since phase 3, but nothing outside the runner could reach it:
 * the session object lived in a local variable, so "abort" could only drop the queue and had to
 * let the running agent finish. This registry is the missing handle — one entry per session
 * currently driving an adapter, keyed by run id — and it is what makes a full stop possible from
 * the panel and from MCP.
 *
 * Memory only, and deliberately so: a process restart kills every adapter with it, and the boot
 * recovery pass (§11.2) is what reconciles the rows.
 */

export type LiveRunHandle = {
  runId: string;
  taskId: string;
  projectId: string;
  chainId: string;
  /** Cancel the ACP turn, then stop the adapter process (SIGTERM, then SIGKILL). */
  abort: () => Promise<void>;
  /** The ACP session id, when the adapter has given one; recorded so a resume is possible. */
  acpSession: () => string | undefined;
  startedAt: number;
};

export class LiveRuns {
  private readonly runs = new Map<string, LiveRunHandle>();

  register(handle: LiveRunHandle): void {
    this.runs.set(handle.runId, handle);
  }

  unregister(runId: string): void {
    this.runs.delete(runId);
  }

  get(runId: string): LiveRunHandle | undefined {
    return this.runs.get(runId);
  }

  /** Every live run of one project; there is at most one, but the lock is not this map. */
  forProject(projectId: string): LiveRunHandle[] {
    return [...this.runs.values()].filter((handle) => handle.projectId === projectId);
  }

  forChain(chainId: string): LiveRunHandle[] {
    return [...this.runs.values()].filter((handle) => handle.chainId === chainId);
  }

  list(): LiveRunHandle[] {
    return [...this.runs.values()];
  }

  get size(): number {
    return this.runs.size;
  }
}
