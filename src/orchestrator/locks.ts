/**
 * Project locks and the global concurrency cap (SR-07, OR-08, DESIGN §5.3).
 * Memory-only and therefore always consistent: there is exactly one process, and boot
 * recovery marks orphaned runs interrupted before any lock is rebuilt, so a stale lock
 * cannot survive a restart.
 */
export class RunLocks {
  private readonly byProject = new Map<string, string>();

  constructor(private readonly maxParallel: number) {}

  get active(): number {
    return this.byProject.size;
  }

  runIdFor(projectId: string): string | undefined {
    return this.byProject.get(projectId);
  }

  isLocked(projectId: string): boolean {
    return this.byProject.has(projectId);
  }

  get atCapacity(): boolean {
    return this.byProject.size >= this.maxParallel;
  }

  /** Take the lock, or return false when the project is busy or the cap is reached. */
  tryAcquire(projectId: string, runId: string): boolean {
    if (this.isLocked(projectId) || this.atCapacity) return false;
    this.byProject.set(projectId, runId);
    return true;
  }

  release(projectId: string): void {
    this.byProject.delete(projectId);
  }

  snapshot(): { projectId: string; runId: string }[] {
    return [...this.byProject.entries()].map(([projectId, runId]) => ({ projectId, runId }));
  }
}
