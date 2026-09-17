/**
 * Git per task (PM-04, PM-05, DESIGN §9.3).
 *
 * Agents never push: `git_push` is denied by policy and the orchestrator owns the remote.
 * `--force` is not implemented at all, so there is no code path that can rewrite history.
 */
import { simpleGit, type SimpleGit } from "simple-git";

export type CommitResult = { sha: string; created: boolean };

const AUTHOR = { name: "LightsOut", email: "lightsout@localhost" };

export class ProjectGit {
  private readonly git: SimpleGit;

  constructor(private readonly projectPath: string) {
    this.git = simpleGit({ baseDir: projectPath, maxConcurrentProcesses: 1 });
  }

  private async withIdentity(): Promise<SimpleGit> {
    // Configured per repository so nothing depends on a global git identity.
    await this.git.addConfig("user.name", AUTHOR.name, false, "local");
    await this.git.addConfig("user.email", AUTHOR.email, false, "local");
    return this.git;
  }

  /**
   * Clone a remote into an empty directory (PM-12).
   *
   * Static because there is no project yet: the directory this class is normally constructed
   * around is what the clone creates. Depth is deliberately full — the checkpoint tags a
   * provisional decision leaves behind (PM-04) are history the second machine needs.
   */
  static async clone(remote: string, target: string): Promise<void> {
    await simpleGit({ maxConcurrentProcesses: 1 }).clone(remote, target);
  }

  async isRepo(): Promise<boolean> {
    try {
      return await this.git.checkIsRepo();
    } catch {
      return false;
    }
  }

  /** `git init` plus the scaffold commit; idempotent (PM-01). */
  async init(defaultBranch = "main"): Promise<CommitResult> {
    if (!(await this.isRepo())) {
      await this.git.init(["--initial-branch", defaultBranch]);
    }
    await this.withIdentity();
    return this.commitAll("chore: scaffold project [lo:init]");
  }

  async isDirty(): Promise<boolean> {
    const status = await this.git.status();
    return !status.isClean();
  }

  async head(): Promise<string | undefined> {
    try {
      return await this.git.revparse(["HEAD"]);
    } catch {
      return undefined; // no commits yet
    }
  }

  /** Stage everything and commit; returns created:false when there was nothing to commit. */
  async commitAll(message: string): Promise<CommitResult> {
    await this.withIdentity();
    await this.git.add(["-A"]);
    if (!(await this.isDirty())) {
      const sha = await this.head();
      return { sha: sha ?? "", created: false };
    }
    const result = await this.git.commit(message, undefined, { "--no-verify": null });
    return { sha: result.commit || (await this.head()) || "", created: true };
  }

  /** Untracked files, project-relative. Used by the end-of-run hygiene report (PE-08). */
  async untracked(): Promise<string[]> {
    const status = await this.git.status();
    return status.not_added;
  }

  /** Work-in-progress commit during a run (DESIGN §9.3). */
  wip(taskId: string): Promise<CommitResult> {
    return this.commitAll(`wip(lightsout): ${taskId} ${new Date().toISOString()}`);
  }

  /** Consolidated commit when a task ends ok. */
  consolidate(taskId: string, title: string): Promise<CommitResult> {
    return this.commitAll(`feat: ${title} [lo:${taskId}]`);
  }

  /** Annotated checkpoint tag for a provisional decision (PE-06, the v2 rewind target). */
  async checkpoint(taskId: string, n: number, message: string): Promise<string | undefined> {
    const sha = await this.head();
    if (!sha) return undefined;
    const tag = `lightsout/cp/${taskId}-${n}`;
    await this.git.addAnnotatedTag(tag, message);
    return tag;
  }

  async currentBranch(): Promise<string> {
    const status = await this.git.status();
    return status.current ?? "main";
  }

  async hasRemote(name = "origin"): Promise<boolean> {
    const remotes = await this.git.getRemotes(true);
    return remotes.some((r) => r.name === name);
  }

  /**
   * The push URL of a remote, or undefined (§9.7.1b).
   *
   * The omission this fills: the class could say *whether* an origin existed and could *set* one,
   * and could not say what it was — so `projects.repo_remote` stayed null on every project that
   * acquired its origin after being created here, the declaration said `remote: ''`, and a bundle
   * exported from a project with a perfectly good remote claimed it had none.
   */
  async getRemote(name = "origin"): Promise<string | undefined> {
    if (!(await this.isRepo())) return undefined;
    const remotes = await this.git.getRemotes(true);
    const found = remotes.find((r) => r.name === name);
    const url = found?.refs.push || found?.refs.fetch;
    return url?.trim() || undefined;
  }

  async setRemote(url: string, name = "origin"): Promise<void> {
    if (await this.hasRemote(name)) {
      await this.git.remote(["set-url", name, url]);
    } else {
      await this.git.addRemote(name, url);
    }
  }

  /**
   * Push the current branch. Never forced. The caller is responsible for the policy
   * (push only after a green verify, PM-05).
   */
  async push(remote = "origin"): Promise<void> {
    const branch = await this.currentBranch();
    await this.git.push(remote, branch, { "--set-upstream": null });
  }
}
