/**
 * Doubt lifecycle (DO-01..05, PE-06, DESIGN §8).
 *
 * A doubt arrives from two places: a `status:"doubt"` result sentinel (functional) or a
 * `require_human` permission verdict (permission). Before opening it, and only when the action
 * class is reversible, the other engine is asked for a second opinion. If it agrees with the
 * recommendation above the confidence threshold, the decision is recorded as provisional, a git
 * checkpoint tag is set and work continues. Otherwise the doubt opens with both positions
 * attached, so the human sees the disagreement. Anything that fails fails toward the human.
 */
import type { Config } from "../config.js";
import type { Bus } from "../bus.js";
import type { Repos } from "../db/repos/index.js";
import type { AgentsLoader } from "../agents/loader.js";
import type { DoubtOption, DoubtRow, Engine, ProjectRow, TaskRow } from "../db/types.js";
import type { ActionClass } from "../policy/schema.js";
import type { PermissionOption } from "@agentclientprotocol/sdk";
import { consultAdvisor, otherEngine, type AdvisorResult } from "../acp/advisor.js";
import { ProjectDocs } from "../projects/docs.js";
import { ProjectGit } from "../projects/git.js";
import { commandShape } from "../policy/classify.js";
import { consultJudge, judgeAllows, judgeable, JUDGE_AGENT_ID } from "./judge.js";

/** Irreversible or sensitive classes never auto-continue: they skip the advisor (DO-03). */
const IRREVERSIBLE: ReadonlySet<ActionClass> = new Set<ActionClass>([
  "delete",
  "git_push",
  "credentials",
  "publish_external",
  "outside_workspace",
]);

export function isReversible(actionClass?: string): boolean {
  if (!actionClass) return true; // functional doubts are about decisions, not actions
  return !IRREVERSIBLE.has(actionClass as ActionClass);
}

/**
 * Classes a permission gate may not settle on the advisor's word alone, even though they are
 * reversible (DESIGN §8.2). A dependency rewrites the lockfile and the build environment for
 * every later run (ST-03), so it stays a human call regardless of how confident the advisor is.
 * `network` is here for the same reason in reverse: undoing the fetch does not undo what left
 * the machine, so "reversible" is the wrong test for it.
 */
const NEVER_AUTO_ALLOWED: ReadonlySet<ActionClass> = new Set<ActionClass>([
  "deps_install",
  "network",
]);

/**
 * Confidence a derived allow must clear. Higher than the functional threshold on purpose: a
 * functional doubt has a recommendation from the agent doing the work, whereas here the allow
 * was proposed by nobody and the advisor is the only voice for it.
 */
export const DERIVED_ALLOW_CONFIDENCE = 0.8;

/**
 * Whether a permission gate can be settled by the advisor instead of by a human. A gate exists
 * because the policy had no answer, so nothing recommends allowing it — but for a reversible,
 * non-dependency action, "allow" is the option worth asking the other engine about, and a
 * confident agreement is a better answer than blocking an unattended chain on a read of the
 * repository.
 */
export function derivedPermissionRecommendation(actionClass: string): string | null {
  if (!isReversible(actionClass)) return null;
  if (NEVER_AUTO_ALLOWED.has(actionClass as ActionClass)) return null;
  return "A";
}

export type RaiseDoubtInput = {
  project: ProjectRow;
  task: TaskRow;
  runId: string;
  /** `hard_rule` is the one kind that never sees the advisor and never auto-continues (KB-11b). */
  kind: "functional" | "permission" | "hard_rule";
  context: string;
  blocks: string;
  options: DoubtOption[];
  recommendation?: string | null;
  /**
   * True when the recommendation was derived by the gate rather than proposed by the agent
   * (DESIGN §8.2). Such a recommendation must clear DERIVED_ALLOW_CONFIDENCE.
   */
  derivedRecommendation?: boolean;
  /** Action class for permission doubts; decides whether the advisor is consulted. */
  actionClass?: string;
  /** The command's shape, so an allow can be remembered (PE-10). */
  actionShape?: string;
  /** Engine that raised it, so the advisor is the other one. */
  engine: Engine;
};

export type RaiseDoubtResult =
  | {
      outcome: "auto_continue";
      choice: string;
      advisor: AdvisorResult;
      decisionId: string;
      checkpointTag?: string;
    }
  | { outcome: "opened"; doubt: DoubtRow; advisor?: AdvisorResult };

export type AnswerDoubtResult = {
  doubt: DoubtRow;
  decisionId: string;
  /** True when a task was requeued so the chain can carry on (DO-04). */
  resumed: boolean;
};

export class DoubtService {
  /** Permission doubts waiting on a human: doubt id → resolver of the held ACP response. */
  private readonly pending = new Map<string, (choice: string) => void>();

  constructor(
    private readonly config: Config,
    private readonly repos: Repos,
    private readonly bus: Bus,
    private readonly agents: AgentsLoader,
  ) {}

  private adapterCommand(engine: Engine): string {
    return engine === "claude" ? this.config.adapterClaude : this.config.adapterCodex;
  }

  /** Ask the other engine. Returns undefined when the advisor must be skipped. */
  private async secondOpinion(input: RaiseDoubtInput): Promise<AdvisorResult | undefined> {
    // A hard rule exists because a person decided something (KB-11b). Asking the other engine
    // whether breaking it is reasonable would be exactly the failure the flag prevents, so the
    // advisor is not consulted at all — not consulted and overridden, not consulted for the
    // record. This is the only doubt kind that gets no second opinion.
    if (input.kind === "hard_rule") return undefined;
    if (!isReversible(input.actionClass)) return undefined;
    if (input.options.length < 2) return undefined;

    const engine = otherEngine(input.engine);
    const result = await consultAdvisor({
      engine,
      adapterCommand: this.adapterCommand(engine),
      cwd: input.project.path,
      question: [
        `Task: ${input.task.title}`,
        "",
        input.context,
        "",
        `What it blocks: ${input.blocks}`,
        // Never attribute a derived recommendation to the agent: it proposed nothing, and an
        // advisor told otherwise would be anchored on an opinion that does not exist.
        input.derivedRecommendation
          ? "Nobody has recommended an option. The policy had no rule for this action, so judge it on its own merits: answer A only if the action is safe and clearly within what the task needs."
          : input.recommendation
            ? `The other agent recommends option ${input.recommendation}.`
            : "",
      ]
        .filter(Boolean)
        .join("\n"),
      options: input.options,
    });

    this.repos.events.append({
      runId: input.runId,
      type: "advisor.consulted",
      payload: result.ok
        ? {
            engine: result.engine,
            agrees: result.answer.choice === input.recommendation,
            confidence: result.answer.confidence,
            choice: result.answer.choice,
          }
        : { engine: result.engine, agrees: false, error: result.error },
    });
    return result;
  }

  /**
   * The auto-continue rule (DO-02): the advisor must pick the same option as the
   * recommendation and be confident enough. Everything else opens the doubt.
   */
  private agrees(input: RaiseDoubtInput, advisor: AdvisorResult | undefined): boolean {
    // Belt as well as braces: `secondOpinion` already refuses to consult on a hard rule, and this
    // makes the guarantee independent of that — a hard-rule doubt cannot auto-continue even if
    // some future caller hands one an advisor result.
    if (input.kind === "hard_rule") return false;
    if (!advisor?.ok) return false;
    if (!input.recommendation) return false;
    const threshold = input.derivedRecommendation
      ? Math.max(this.config.advisorConfidence, DERIVED_ALLOW_CONFIDENCE)
      : this.config.advisorConfidence;
    return (
      advisor.answer.choice === input.recommendation && advisor.answer.confidence >= threshold
    );
  }

  /**
   * How many times one task may auto-continue before a human must look at it. Without this
   * cap an agent that keeps raising the same doubt, with an advisor that keeps agreeing, would
   * loop forever spending tokens.
   */
  static readonly MAX_AUTO_CONTINUE = 3;

  private autoContinuesSoFar(projectId: string, taskId: string): number {
    return this.repos.decisions
      .listByProject(projectId, 500)
      .filter((d) => d.task_id === taskId && d.kind === "provisional").length;
  }

  async raise(input: RaiseDoubtInput): Promise<RaiseDoubtResult> {
    const docs = new ProjectDocs(this.repos, input.project);
    // The budget counts provisional decisions, and a hard rule can never produce one, so counting
    // it would only let earlier auto-continues change what this doubt reports (KB-11b).
    const exhausted =
      input.kind !== "hard_rule" &&
      this.autoContinuesSoFar(input.project.id, input.task.id) >= DoubtService.MAX_AUTO_CONTINUE;
    if (exhausted) {
      this.repos.events.append({
        runId: input.runId,
        type: "system",
        payload: {
          reason: "auto-continue budget exhausted",
          limit: DoubtService.MAX_AUTO_CONTINUE,
        },
      });
    }
    const advisor = exhausted ? undefined : await this.secondOpinion(input);

    if (this.agrees(input, advisor) && advisor?.ok && input.recommendation) {
      const chosen = input.options.find((o) => o.id === input.recommendation);
      const question = input.context.split("\n")[0]?.slice(0, 200) ?? input.context.slice(0, 200);
      const rationale =
        `advisor ${advisor.engine} agreed with confidence ${advisor.answer.confidence.toFixed(2)}: ` +
        advisor.answer.rationale;

      // Checkpoint first: the tag must point at the pre-decision commit (PE-06).
      let checkpointTag: string | undefined;
      const git = new ProjectGit(input.project.path);
      if (await git.isRepo()) {
        const existing = this.repos.decisions
          .listByProject(input.project.id, 500)
          .filter((d) => d.task_id === input.task.id).length;
        checkpointTag =
          (await git.checkpoint(
            input.task.id,
            existing + 1,
            `provisional decision: ${input.recommendation}`,
          )) ?? undefined;
        if (checkpointTag) {
          this.repos.events.append({
            runId: input.runId,
            type: "git.tag",
            payload: { tag: checkpointTag, message: `provisional: ${input.recommendation}` },
          });
        }
      }

      const decision = this.repos.decisions.record({
        projectId: input.project.id,
        taskId: input.task.id,
        kind: "provisional",
        question,
        choice: chosen ? `${chosen.id}: ${chosen.text}` : input.recommendation,
        rationale,
        checkpointTag: checkpointTag ?? null,
      });
      await docs.appendDecision({
        kind: "provisional",
        question,
        choice: chosen ? `${chosen.id}: ${chosen.text}` : input.recommendation,
        rationale,
      });
      this.bus.emit("overview");

      const result: RaiseDoubtResult = {
        outcome: "auto_continue",
        choice: input.recommendation,
        advisor,
        decisionId: decision.id,
      };
      if (checkpointTag) result.checkpointTag = checkpointTag;
      return result;
    }

    // Open the doubt, attaching the second opinion so the human sees both positions (DO-03).
    const doubt = this.repos.doubts.open({
      projectId: input.project.id,
      taskId: input.task.id,
      runId: input.runId,
      kind: input.kind,
      context: input.context,
      blocks: input.blocks,
      options: input.options,
      recommendation: input.recommendation ?? null,
      // PE-10: what the answer will be teaching, when it is an allow.
      actionClass: input.actionClass ?? null,
      actionShape: input.actionShape ?? null,
    });
    if (advisor) {
      this.repos.doubts.setSecondOpinion(
        doubt.id,
        advisor.ok
          ? {
              engine: advisor.engine,
              agrees: advisor.answer.choice === input.recommendation,
              confidence: advisor.answer.confidence,
              reasoning: advisor.answer.rationale,
            }
          : { engine: advisor.engine, agrees: false, confidence: 0, reasoning: advisor.error },
      );
    }
    this.repos.events.append({
      runId: input.runId,
      type: "doubt.opened",
      payload: { doubtId: doubt.id, ref: doubt.ref, kind: doubt.kind },
    });

    const fresh = this.repos.doubts.getOrThrow(doubt.id);
    await this.mirror(input.project, fresh);
    this.bus.emit("doubt", { doubtId: doubt.id });
    this.bus.emit("overview");
    return { outcome: "opened", doubt: fresh, ...(advisor ? { advisor } : {}) };
  }

  /** Regenerate the QUESTIONS.md mirror from the database (never parsed back, DO-01). */
  private async mirror(project: ProjectRow, doubt: DoubtRow): Promise<void> {
    const docs = new ProjectDocs(this.repos, project);
    const opinion = this.repos.doubts.secondOpinion(doubt);
    await docs.appendQuestion({
      ref: doubt.ref,
      context: doubt.context,
      blocks: doubt.blocks,
      options: this.repos.doubts.options(doubt),
      recommendation: doubt.recommendation,
      ...(opinion
        ? {
            secondOpinion: `${opinion.engine} → ${opinion.agrees ? "agrees" : "disagrees"} (${opinion.confidence.toFixed(2)})`,
          }
        : {}),
      status: doubt.status,
      ...(doubt.answer ? { answer: doubt.answer } : {}),
    });
  }

  /** Poll interval for a held permission doubt; a human answer is never urgent. */
  static readonly ANSWER_POLL_MS = 3000;

  /**
   * Wait until a doubt stops being open, or until the slow clock expires. The answer may be
   * written by this process (in-memory resolver, immediate) or by another one (the maintenance
   * CLI, or a future MCP call in a different process), which is why the database is polled as
   * well: an in-memory-only wait cannot be released from outside.
   */
  private async waitForAnswer(
    doubtId: string,
    waitMs: number,
    pollMs = DoubtService.ANSWER_POLL_MS,
  ): Promise<string | undefined> {
    const deadline = Date.now() + waitMs;
    let resolveInMemory: ((choice: string) => void) | undefined;
    const inMemory = new Promise<string>((resolve) => {
      resolveInMemory = resolve;
    });
    if (resolveInMemory) this.pending.set(doubtId, resolveInMemory);

    try {
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return undefined;

        const tick = new Promise<undefined>((resolve) => {
          const timer = setTimeout(() => resolve(undefined), Math.min(pollMs, remaining));
          timer.unref?.();
        });
        const winner = await Promise.race([inMemory, tick]);
        if (typeof winner === "string") return winner;

        const row = this.repos.doubts.get(doubtId);
        if (row && row.status !== "open") {
          // Recover the chosen option id from the stored answer ("A: text — note").
          const optionId = row.answer?.split(":")[0]?.trim();
          return optionId || "B";
        }
      }
    } finally {
      this.pending.delete(doubtId);
    }
  }

  /**
   * The permission judge (PE-11, DESIGN §6.5b): does this command risk the system or the user's
   * work? Only `other` and a deletion confined to the project are its to decide, and only an
   * explicit low-risk allow counts. Returns true when the action may proceed without a human.
   *
   * An allow is recorded three ways: a provisional decision (so it is in DECISIONS.md like every
   * other automatic call), an event, and a learned shape (PE-10) so the second time is free.
   */
  private async judge(input: {
    project: ProjectRow;
    task: TaskRow;
    runId: string;
    actionClass: string;
    title: string;
    reason: string;
    paths?: string[];
    readAreas?: string[];
    writeScopes?: string[];
  }): Promise<boolean> {
    // Nothing here may break the gate: a judge that throws is a judge that abstains.
    let profile;
    try {
      profile = this.agents.profile?.(JUDGE_AGENT_ID);
    } catch {
      return false;
    }
    if (!profile?.enabled) return false;
    if (
      !judgeable({
        actionClass: input.actionClass as ActionClass,
        projectPath: input.project.path,
        command: input.title,
        paths: input.paths,
      })
    ) {
      return false;
    }

    const result = await consultJudge({
      actionClass: input.actionClass as ActionClass,
      title: input.title,
      reason: input.reason,
      projectPath: input.project.path,
      ...(input.readAreas?.length ? { readAreas: input.readAreas } : {}),
      ...(input.writeScopes?.length ? { writeScopes: input.writeScopes } : {}),
      adapterCommand: this.adapterCommand(profile.engine),
    });

    const allowed = judgeAllows(result);
    this.repos.events.append({
      runId: input.runId,
      type: "judge.verdict",
      payload: {
        class: input.actionClass,
        allowed,
        ...(result.ok
          ? { risk: result.answer.risk, reason: result.answer.reason.slice(0, 200) }
          : { error: result.error.slice(0, 200) }),
        durationMs: result.durationMs,
      },
    });
    if (!allowed || !result.ok) return false;

    const shape = commandShape(input.title);
    this.repos.decisions.record({
      projectId: input.project.id,
      taskId: input.task.id,
      kind: "provisional",
      question: `${input.actionClass}: ${input.title.slice(0, 200)}`,
      choice: "allowed by the permission judge",
      rationale: `${result.answer.reason} (risk: ${result.answer.risk})`,
    });
    if (shape) {
      this.repos.learned.add({
        shape,
        sample: input.title.slice(0, 300),
        actionClass: input.actionClass,
        learnedFrom: `judge:${input.runId}`,
        addedBy: "judge",
      });
    }
    return true;
  }

  /**
   * Permission gate (DESIGN §6.5, §8.4): a `require_human` verdict opens a permission doubt
   * and holds the ACP response until someone answers or the slow clock expires. The waiting
   * promise is registered so `answer()` can resolve it from another call.
   */
  async gatePermission(input: {
    project: ProjectRow;
    task: TaskRow;
    runId: string;
    engine: Engine;
    actionClass: string;
    title: string;
    reason: string;
    options: PermissionOption[];
    /** Paths the request named, when it named any: the judge needs them for a deletion (PE-11). */
    paths?: string[];
    /** Directories this project may read outside itself (PE-09), for the judge's context. */
    readAreas?: string[];
    /** Where this pack confines writes (§19), for the judge's context. */
    writeScopes?: string[];
    /** Override the slow clock; only tests use this. */
    waitMs?: number;
    /** Override the database poll interval; only tests use this. */
    pollMs?: number;
  }): Promise<{ optionId: string } | { reject: true; explanation: string }> {
    // Offer the human the same shape as any other doubt: allow or refuse, with the reason.
    const allowOption = input.options.find(
      (o) => o.kind === "allow_once" || o.kind === "allow_always",
    );

    // PE-11: one cheap closed question before a person is woken. It can only shorten the path to
    // allow — every failure, doubt or high risk falls through to the doubt below.
    if (allowOption) {
      const settled = await this.judge(input).catch(() => false);
      if (settled) return { optionId: allowOption.optionId };
    }
    const doubtOptions: DoubtOption[] = [
      { id: "A", text: `Allow: ${input.title}` },
      { id: "B", text: "Refuse and let the agent adapt or stop" },
    ];

    // Nobody proposed allowing this — the gate exists because the policy had no answer. But for
    // a reversible, non-dependency action, "allow" is the option worth a second opinion, so the
    // advisor can settle it instead of waking a human for a read of the repository (§8.2).
    const derived = derivedPermissionRecommendation(input.actionClass);

    const raised = await this.raise({
      project: input.project,
      task: input.task,
      runId: input.runId,
      kind: "permission",
      engine: input.engine,
      actionClass: input.actionClass,
      // The title of a permission request is the command itself (§7.1), which is what makes an
      // allow teachable (PE-10).
      actionShape: commandShape(input.title),
      context: `The agent asked to do something the policy sends to a human: ${input.title}\n\nPolicy said: ${input.reason}`,
      blocks: `Task "${input.task.title}" cannot continue past this action.`,
      options: doubtOptions,
      recommendation: derived,
      ...(derived ? { derivedRecommendation: true } : {}),
    });

    if (raised.outcome === "auto_continue") {
      if (allowOption) return { optionId: allowOption.optionId };
      // The adapter offered no allow option: there is nothing to authorize, so refuse rather
      // than pretend the provisional decision was carried out.
      return {
        reject: true,
        explanation: "No allow option was offered for this action. Adapt, or stop and report it.",
      };
    }

    const doubt = raised.doubt;
    const waitMs = input.waitMs ?? this.config.permissionWaitHours * 3_600_000;
    const answer = await this.waitForAnswer(doubt.id, waitMs, input.pollMs);

    if (answer === undefined) {
      this.repos.events.append({
        runId: input.runId,
        type: "system",
        payload: {
          reason: "permission wait expired",
          hours: this.config.permissionWaitHours,
          doubtRef: doubt.ref,
        },
      });
      return {
        reject: true,
        explanation: `No human answered within ${this.config.permissionWaitHours} h. The action stays refused; stop and report what you needed.`,
      };
    }

    if (answer === "A" && allowOption) return { optionId: allowOption.optionId };
    return {
      reject: true,
      explanation: "A human refused this action. Adapt, or finish with a doubt explaining why you cannot.",
    };
  }

  /**
   * Answer a doubt (DO-04): record the human decision, mirror it, and hand the task back to
   * the chain. Resuming the ACP session itself is the caller's business: functional doubts
   * requeue the task with the decision in its context.
   */
  async answer(input: {
    doubtId: string;
    choice: string;
    note?: string;
    projectId?: string;
  }): Promise<AnswerDoubtResult> {
    const doubt = this.repos.doubts.resolve(input.doubtId, input.projectId);
    if (!doubt) throw new Error(`doubt not found: ${input.doubtId}`);
    if (doubt.status !== "open") {
      throw new Error(`doubt ${doubt.ref} is already ${doubt.status}`);
    }

    const options = this.repos.doubts.options(doubt);
    const chosen = options.find((o) => o.id === input.choice);
    const choiceText = chosen ? `${chosen.id}: ${chosen.text}` : input.choice;
    const project = this.repos.projects.getOrThrow(doubt.project_id);
    const question = doubt.context.split("\n")[0]?.slice(0, 200) ?? doubt.context.slice(0, 200);

    const answered = this.repos.doubts.answer(
      doubt.id,
      input.note ? `${choiceText} — ${input.note}` : choiceText,
    );
    const decision = this.repos.decisions.record({
      projectId: project.id,
      taskId: doubt.task_id,
      doubtId: doubt.id,
      kind: "human",
      question,
      choice: choiceText,
      rationale: input.note ?? null,
    });

    const docs = new ProjectDocs(this.repos, project);
    await docs.appendDecision({
      ref: doubt.ref,
      kind: "human",
      question,
      choice: choiceText,
      rationale: input.note ?? null,
    });
    await this.mirror(project, answered);

    this.repos.events.append({
      runId: doubt.run_id,
      type: "doubt.answered",
      payload: { doubtId: doubt.id, ref: doubt.ref, choice: input.choice },
    });
    this.bus.emit("doubt", { doubtId: doubt.id });
    this.bus.emit("overview");

    // PE-10: a human allowing an unmatched command is teaching, not just answering. The shape is
    // remembered so the same kind of command never stops a chain again; anything the classifier
    // did understand is the packs' business and is not learned here.
    if (
      doubt.kind === "permission" &&
      input.choice === "A" &&
      doubt.action_class === "other" &&
      doubt.action_shape
    ) {
      const learned = this.repos.learned.add({
        shape: doubt.action_shape,
        sample: doubt.context.slice(0, 300),
        actionClass: doubt.action_class,
        learnedFrom: doubt.ref,
        addedBy: "human",
      });
      this.repos.events.append({
        runId: doubt.run_id,
        type: "config.changed",
        payload: { kind: "learned_allow", id: learned.shape, op: "add", actor: "human" },
      });
    }

    // A permission doubt has a run holding the ACP response: release it now.
    const release = this.pending.get(doubt.id);
    if (release) {
      release(input.choice);
      return { doubt: answered, decisionId: decision.id, resumed: true };
    }

    return { doubt: answered, decisionId: decision.id, resumed: false };
  }

  /**
   * Release every permission gate a run is holding, because the run is being stopped
   * (OR-06, DESIGN §5.4). The held ACP request is answered as refused and the doubt is closed
   * with the reason, so a gate nobody will ever answer does not sit open in the attention strip.
   * Returns the refs it closed. Never throws: a stop must not fail on tidying up.
   */
  async cancelForRun(runId: string, reason = "the run was stopped"): Promise<string[]> {
    const closed: string[] = [];
    for (const doubt of this.repos.doubts.listOpen()) {
      if (doubt.run_id !== runId) continue;
      try {
        // "B" is the refusing option by construction in gatePermission; releasing with it makes
        // the held request answer "reject" instead of hanging until the slow clock.
        this.pending.get(doubt.id)?.("B");
        const answered = this.repos.doubts.answer(doubt.id, `cancelled: ${reason}`);
        this.repos.doubts.close(doubt.id);
        const project = this.repos.projects.get(doubt.project_id);
        if (project) await this.mirror(project, { ...answered, status: "closed" });
        this.repos.events.append({
          runId,
          type: "doubt.answered",
          payload: { doubtId: doubt.id, ref: doubt.ref, choice: "cancelled", reason },
        });
        closed.push(doubt.ref);
      } catch (err) {
        this.repos.events.append({
          runId,
          type: "system",
          payload: {
            reason: "could not cancel a doubt while stopping the run",
            doubtId: doubt.id,
            detail: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }
    if (closed.length > 0) {
      this.bus.emit("overview");
    }
    return closed;
  }

  /**
   * The decision context prepended to a resumed task, so a new run knows what was settled
   * even when the adapter cannot reload the original session (DESIGN §8.4).
   */
  decisionContext(taskId: string): string {
    const decisions = this.repos.decisions
      .listByProject(this.repos.tasks.getOrThrow(taskId).project_id, 50)
      .filter((d) => d.task_id === taskId)
      .slice(0, 5)
      .reverse();
    if (decisions.length === 0) return "";
    const lines = decisions.map(
      (d) => `- ${d.question} → ${d.choice}${d.rationale ? ` (${d.rationale})` : ""}`,
    );
    return [
      "# Decisions already taken for this task",
      "",
      "These are settled. Do not reopen them; continue from here.",
      "",
      ...lines,
    ].join("\n");
  }
}
