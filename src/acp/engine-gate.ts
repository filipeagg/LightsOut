/**
 * One provider, one process entering its credential-refresh window at a time (§6.9).
 *
 * The failure this exists for: every `claude-agent-acp` process in the container shares
 * `~/.claude/.credentials.json`, and the engine renews an expired token behind a lock of its own.
 * With `LO_MAX_PARALLEL` runs plus an advisor session, several processes can start within the
 * same second, all find the token expired, and all reach for that lock at once; the ones that
 * lose it die with *"another Claude Code process is refreshing it or exited mid-refresh"*.
 *
 * This is not a mutex around the run — that would throw away the parallelism the orchestrator
 * exists for. It is a **stagger**: a run waits its turn to *start* on that engine, and the turn
 * is handed on a short while later, once the first seconds (spawn, handshake, and any token
 * renewal they trigger) are behind it. Runs then overlap for all but their first moments, which
 * is the only part that contends.
 *
 * Per engine, because the two engines keep their credentials in different files and have no
 * reason to wait for each other.
 */

type Waiter = () => void;

export class EngineStartGate {
  private readonly busy = new Set<string>();
  private readonly queues = new Map<string, Waiter[]>();

  constructor(private readonly settleMs: number) {}

  /**
   * Wait for this engine's turn to start a session. The returned function hands the turn on and
   * is safe to call more than once; the caller schedules it `settleMs` after the session starts
   * and also calls it when the run ends, whichever comes first.
   */
  async enter(engine: string): Promise<() => void> {
    if (this.settleMs <= 0) return () => undefined;
    if (this.busy.has(engine)) {
      await new Promise<void>((resolve) => {
        const queue = this.queues.get(engine) ?? [];
        queue.push(resolve);
        this.queues.set(engine, queue);
      });
    }
    this.busy.add(engine);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.busy.delete(engine);
      const queue = this.queues.get(engine);
      const next = queue?.shift();
      if (next) next();
      else this.queues.delete(engine);
    };
  }

  /** How long a caller should hold the turn after starting its session. */
  get holdMs(): number {
    return this.settleMs;
  }
}
