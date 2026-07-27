/**
 * One task, one run: the seam the orchestrator will call in phase 4 (SR-01..07).
 * Everything that outlives the ACP turn happens here: run row lifecycle, task status,
 * doubt creation from the sentinel, and the policy layers for the run.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.js";
import type { Bus } from "../bus.js";
import type { Repos } from "../db/repos/index.js";
import type { AgentsLoader } from "../agents/loader.js";
import { isOverridden, resolveProfile } from "../agents/effective.js";
import { PolicyEngine } from "../policy/engine.js";
import type { PolicyPack } from "../policy/schema.js";
import type { ProjectRow, TaskRow } from "../db/types.js";
import { RunSession, type HumanGate, type RunOutcome } from "./session.js";
import { LiveRuns } from "./live.js";
import { compactionBlock, deliverablePath, lintDocument } from "../projects/deliverable.js";
import { grantPack, isCapability, type Capability } from "../policy/capabilities.js";

/** The capability list stored on a task, tolerant of anything that is not one (PE-12). */
function parseCapabilities(raw: string | null): Capability[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is Capability => typeof v === "string" && isCapability(v)) : [];
  } catch {
    return [];
  }
}
import { DoubtService } from "../orchestrator/doubts.js";
import type { KnowledgeLoader } from "../knowledge/loader.js";
import { buildKnowledgeBlock } from "../knowledge/inject.js";
import { renderVaultIndex, vaultHosts, type Vault } from "../vault/vault.js";

export type RunTaskInput = {
  project: ProjectRow;
  task: TaskRow;
  /** Per-project override pack from lightsout.yaml (PE-05); phase 4 loads it. */
  projectPack?: PolicyPack | undefined;
  humanGate?: HumanGate | undefined;
  onStderr?: ((line: string) => void) | undefined;
};

export type RunTaskResult = {
  runId: string;
  outcome: RunOutcome;
  /** Human-friendly ref of the doubt opened, when the agent raised one. */
  doubtRef?: string;
  /** Set when the advisor settled the doubt and the task should run again (DO-02). */
  autoContinued?: { choice: string; decisionId: string };
  checkpointTag?: string;
};

/** Only the part of the health probe the runner needs, so a test can pass a stub (§11.3). */
export type HealthInvalidator = {
  noteAuthFailure: (engine: "claude" | "codex", detail: string) => void;
  clearAuthFailure: (engine: "claude" | "codex") => void;
};

export class TaskRunner {
  private readonly doubts: DoubtService;

  constructor(
    private readonly config: Config,
    private readonly repos: Repos,
    private readonly bus: Bus,
    private readonly agents: AgentsLoader,
    doubts?: DoubtService,
    /** Optional: when present, an auth failure mid-run flips engine health (§11.3). */
    private readonly health?: HealthInvalidator,
    /** Phase 9 material; absent in the phase 3 CLI, which runs a task with neither. */
    private readonly context?: {
      knowledge?: KnowledgeLoader;
      vault?: Vault;
    },
    /**
     * The registry of live sessions (OR-06). Shared with the orchestrator so a stop from the
     * panel or from MCP can reach the session that is actually running.
     */
    readonly live: LiveRuns = new LiveRuns(),
  ) {
    this.doubts = doubts ?? new DoubtService(config, repos, bus, agents);
  }

  /**
   * Curated knowledge and credentials for this run (KB-04, §18). The vault is resolved only
   * when the run's pack grants network access: a run that cannot reach anything has no use for
   * a token, and not putting it in the environment is cheaper than trusting it not to look.
   */
  private async runContext(
    project: ProjectRow,
    task: TaskRow,
    pack: PolicyPack | undefined,
  ): Promise<{
    knowledgeBlock?: string;
    vaultIndex?: string;
    vaultEnv?: Record<string, string>;
    vaultReads: { entryId: string; fields: string[] }[];
    /** Hosts this run holds credentials for (VT-07); they carry a network grant with them. */
    vaultHosts?: string[];
    writableKnowledgeBase?: string;
  }> {
    const attachments = this.repos.projectKnowledge.list(project.id);
    const declaredWritable = attachments.find((row) => row.writable === 1)?.base_id;

    // A hard-rule base is never writable, whatever the template declared at launch (KB-11c). An
    // agent that can edit the rules binding it is not bound by them. Dropped rather than refused
    // later, so the grant never reaches the policy engine at all.
    let writable = declaredWritable;
    if (declaredWritable && this.context?.knowledge) {
      const base = this.context.knowledge.get(declaredWritable);
      if (base?.manifest.enforcement === "hard") {
        writable = undefined;
        this.repos.events.append({
          type: "system",
          payload: {
            reason: "writable knowledge base refused: it holds hard rules",
            baseId: declaredWritable,
            projectId: project.id,
          },
        });
      }
    }

    let knowledgeBlock: string | undefined;
    if (this.context?.knowledge && attachments.length > 0) {
      const phase = this.repos.phases.getByTask(task.id);
      const block = await buildKnowledgeBlock(
        this.context.knowledge,
        attachments.map((row) => row.base_id),
        {
          budgetChars: this.config.knowledgeBudgetChars,
          tags: attachments.map((row) => row.kind),
          phaseTitle: phase?.title ?? task.title,
        },
      );
      if (block.text) knowledgeBlock = block.text;
    }

    if (!this.context?.vault) {
      return {
        ...(knowledgeBlock ? { knowledgeBlock } : {}),
        vaultReads: [],
        ...(writable ? { writableKnowledgeBase: writable } : {}),
      };
    }

    // VT-07: a project holding credentials for an API is a project meant to call that API.
    // Resolving the token and then denying the call is the contradiction the vault exists to
    // remove — the exact shape of "the only agent with network is contract-prober". So the entries
    // are resolved first, and if any of them names a host, the run gets the network for it.
    const resolved = await this.context.vault.resolveForRun({
      projectId: project.id,
      testOnlyRequired: pack?.vault?.test_only_required ?? false,
    });
    const hosts = resolved.reads.length ? vaultHosts(resolved) : [];
    const packGrantsNetwork = pack?.rules.some(
      (rule) => rule.class === "network" && rule.verdict !== "deny",
    );
    if (!packGrantsNetwork && hosts.length === 0) {
      // Nothing to call and no grant: behave as before and keep the values out of the process.
      return {
        ...(knowledgeBlock ? { knowledgeBlock } : {}),
        vaultReads: [],
        ...(writable ? { writableKnowledgeBase: writable } : {}),
      };
    }

    const index = renderVaultIndex(resolved);
    return {
      ...(knowledgeBlock ? { knowledgeBlock } : {}),
      ...(index ? { vaultIndex: index } : {}),
      ...(Object.keys(resolved.env).length > 0 ? { vaultEnv: resolved.env } : {}),
      vaultReads: resolved.reads,
      ...(hosts.length ? { vaultHosts: hosts } : {}),
      ...(writable ? { writableKnowledgeBase: writable } : {}),
    };
  }

  /**
   * "Compact your deliverable first", when the deliverable this phase will write already fails the
   * machine-first check (BA-08, DESIGN §20.4). Measured at prompt time rather than remembered:
   * the file on disk is the only thing that matters, and the agent that has to live with it is the
   * one told to fix it. Silent when there is nothing to say.
   */
  private async formatFeedback(
    project: ProjectRow,
    task: TaskRow,
  ): Promise<string | undefined> {
    const phase = this.repos.phases.getByTask(task.id);
    const target = deliverablePath(this.config.workspace, project.path, phase?.deliverable);
    if (!target || !phase?.deliverable) return undefined;
    try {
      const lint = lintDocument(await readFile(target, "utf8"));
      if (lint.ok) return undefined;
      return compactionBlock(phase.deliverable, lint);
    } catch {
      return undefined; // no deliverable yet, which is the normal first pass
    }
  }

  private adapterCommand(engine: "claude" | "codex"): string {
    return engine === "claude" ? this.config.adapterClaude : this.config.adapterCodex;
  }

  async run(input: RunTaskInput): Promise<RunTaskResult> {
    const { project, task } = input;
    const declaredProfile = this.agents.profileOrThrow(task.agent_id);
    // AP-09: the profile is the default; the launch may have chosen another engine or model for
    // this run alone. Resolved once, here, so the adapter, the run row and the prompt agree.
    const profile = resolveProfile(declaredProfile, task);
    const instructions = this.agents.instructionsFor(profile);

    const decisionContext = this.doubts.decisionContext(task.id);
    const formatFeedback = await this.formatFeedback(project, task);
    // The directories this project may read outside itself (PE-09). Resolved here so the policy
    // and the prompt agree: an area the agent is not told about is an area it will not use.
    const readAreas = this.repos.areas.list(project.id).map((row) => ({
      relative: row.path,
      absolute: path.resolve(this.config.workspace, row.path),
      access: row.access ?? "read",
    }));
    // The subset that may also be written to (PE-09 amended). Kept separate rather than inferred
    // in the classifier, so "may read" and "may write" can never drift apart.
    const writeAreas = readAreas.filter((a) => a.access === "write").map((a) => a.absolute);

    const agentPack = this.agents.packFor(profile);
    const context = await this.runContext(project, task, input.projectPack ?? agentPack);

    // PE-12: what this launch was granted, as the most specific policy layer. VT-07 adds the
    // network when the run holds credentials for a host — asking for the token and then denying
    // the call is the contradiction the vault exists to remove.
    const granted = parseCapabilities(task.grants);
    if (context.vaultHosts?.length && !granted.includes("network")) {
      granted.push("network");
      this.repos.events.append({
        type: "config.changed",
        payload: {
          kind: "grant",
          id: `${task.id}:network`,
          op: "vault",
          hosts: context.vaultHosts,
          actor: "system",
        },
      });
    }
    const policy = new PolicyEngine(
      {
        ...(granted.length ? { grant: grantPack(granted, task.id) } : {}),
        project: input.projectPack,
        agent: this.agents.packFor(profile),
        default: this.agents.pack("build") ?? this.agents.pack("default"),
      },
      {
        scriptScanBytes: this.config.scriptScanBytes,
        // PE-10: what a person already allowed at a gate, so the same shape does not ask again.
        learnedAllow: (shape) => this.repos.learned.shapes().has(shape),
        // ST-07: which package managers this project is authorised to install into its own
        // durable toolchain with. Read per evaluation, so a revocation takes effect mid-run.
        toolchainGrant: (manager) =>
          this.repos.toolchainGrants.managers(project.id).has(manager),
      },
    );

    const run = this.repos.runs.start({
      taskId: task.id,
      engine: profile.engine,
      model: profile.model ?? null,
    });
    this.repos.tasks.setStatus(task.id, "running");

    // AP-09: a run whose model nobody can account for is a cost nobody can explain. When the
    // launch chose it rather than the profile, the trail says so, and says who asked.
    if (isOverridden(declaredProfile, task)) {
      this.repos.events.append({
        runId: run.id,
        type: "config.changed",
        payload: {
          kind: "override",
          id: task.id,
          op: "launch",
          actor: "launch",
          from: {
            engine: declaredProfile.engine,
            model: declaredProfile.model ?? null,
            reasoning: declaredProfile.reasoning ?? null,
          },
          to: {
            engine: profile.engine,
            model: profile.model ?? null,
            reasoning: profile.reasoning ?? null,
          },
        },
      });
    }

    // Field names only, never values (VT-05).
    for (const read of context.vaultReads) {
      this.repos.vaultAudit.record(run.id, read.entryId, read.fields);
      this.repos.events.append({
        runId: run.id,
        type: "vault.read",
        payload: { entryId: read.entryId, fields: read.fields },
      });
    }
    this.bus.emit("overview");

    const session = new RunSession({
      repos: this.repos,
      bus: this.bus,
      policy,
      project,
      task,
      run,
      profile,
      instructions,
      adapterCommand: this.adapterCommand(profile.engine),
      limits: {
        timeoutMin:
          task.level === "quick" ? this.config.timeoutQuickMin : this.config.timeoutFullMin,
        inactivityMin: this.config.inactivityMin,
      },
      workspacePath: this.config.workspace,
      // On a re-run after a resolved doubt the agent must see what was settled (§8.2, §8.4).
      ...(decisionContext ? { decisionContext } : {}),
      ...(formatFeedback ? { formatFeedback } : {}),
      ...(context.knowledgeBlock ? { knowledgeBlock: context.knowledgeBlock } : {}),
      ...(context.vaultIndex ? { vaultIndex: context.vaultIndex } : {}),
      ...(context.vaultEnv ? { vaultEnv: context.vaultEnv } : {}),
      ...(context.writableKnowledgeBase
        ? { writableKnowledgeBase: context.writableKnowledgeBase }
        : {}),
      // PE-09: what this project may read outside itself, resolved once before the session.
      ...(readAreas.length ? { readAreas: readAreas.map((area) => area.absolute) } : {}),
      ...(writeAreas.length ? { writeAreas } : {}),
      // require_human opens a permission doubt and holds the ACP response until it is
      // answered or the slow clock runs out (DESIGN §6.5, §8.4).
      humanGate:
        input.humanGate ??
        ((request) =>
          this.doubts.gatePermission({
            project,
            task,
            runId: run.id,
            engine: profile.engine,
            actionClass: request.actionClass,
            title: request.title,
            reason: request.reason,
            options: request.options,
            // Context for the judge (PE-11): what it may read, and where it may write.
            ...(request.paths?.length ? { paths: request.paths } : {}),
            ...(readAreas.length ? { readAreas: readAreas.map((a) => a.relative) } : {}),
            ...(agentPack?.write_scopes?.length
              ? { writeScopes: agentPack.write_scopes }
              : {}),
            // PE-13 and OR-12: whether the judge may look at this credentials gate, and whether
            // an unresolved gate refuses instead of waiting (§7.1d, §7.7).
            ...(request.judgeEligible ? { judgeEligible: true } : {}),
            ...(project.unattended ? { unattended: true } : {}),
          })),
      ...(input.onStderr ? { onStderr: input.onStderr } : {}),
    });

    // `session.start()` contains its own failures, but the ACP SDK can also reject a promise
    // this code never awaits — a transport that closes mid-request rejects everything pending —
    // and an unhandled rejection is fatal to the whole process by default. So the call is
    // wrapped: whatever escapes becomes an `error` outcome and travels down the ordinary failure
    // path, which finishes the run, fails the task, pauses the chain and records recovery info.
    // A dead adapter must cost one run, never the orchestrator (OR-05, RT-07).
    // Registered before the turn starts and removed when it ends: this handle is the only way a
    // stop from the panel or from MCP can reach the session that is running (OR-06, §5.4).
    this.live.register({
      runId: run.id,
      taskId: task.id,
      projectId: project.id,
      chainId: task.chain_id,
      abort: () => session.abort(),
      acpSession: () => session.acpSession,
      startedAt: Date.now(),
    });

    let outcome: RunOutcome;
    try {
      outcome = await session.start();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.repos.events.append({
        runId: run.id,
        type: "system",
        payload: { reason: "adapter failure", detail },
      });
      outcome = {
        status: "error",
        summary: "",
        exitReason: `adapter failure: ${detail}`,
        sentinelMissing: true,
        ...(session.acpSession ? { acpSession: session.acpSession } : {}),
      };
    } finally {
      this.live.unregister(run.id);
      // DO-08: the per-run permission memory dies with the run, which is what makes it safe for
      // classes that must never be remembered across runs.
      this.doubts.forgetRun(run.id);
    }

    this.repos.runs.finish(run.id, {
      status: outcome.status,
      exitReason: outcome.exitReason,
      summary: outcome.summary || null,
      error: outcome.status === "error" ? outcome.exitReason : null,
      tokensIn: outcome.tokensIn ?? null,
      tokensOut: outcome.tokensOut ?? null,
      costUsd: outcome.costUsd ?? null,
    });
    this.repos.events.append({
      runId: run.id,
      type: "run.state",
      payload: { status: outcome.status, reason: outcome.exitReason },
    });

    // Credentials died mid-run (§11.3): drop the cached probe so the next read reports the
    // engine as unauthenticated, and record it as a system.auth event so the panel's attention
    // strip and the history both say "reconnect the engine" instead of "the task failed".
    if (outcome.authRequired) {
      this.health?.noteAuthFailure(profile.engine, outcome.exitReason);
      this.repos.events.append({
        runId: run.id,
        type: "system.auth",
        payload: { engine: profile.engine, reason: "AUTH_REQUIRED", detail: outcome.exitReason },
      });
      this.bus.emit("health");
    } else if (outcome.status === "ok") {
      // The engine demonstrably works; clear any failure remembered from an earlier run.
      this.health?.clearAuthFailure(profile.engine);
    }

    const result: RunTaskResult = { runId: run.id, outcome };

    if (outcome.status === "doubt" && outcome.doubt) {
      // A second opinion may settle it and let the chain continue (DO-02); otherwise the
      // doubt opens with both positions attached (DO-03).
      // A doubt naming a binding rule is a different kind of question: only the user can answer
      // it, so no advisor is consulted and it can never auto-continue (KB-11b, §17.4).
      const hardRule = outcome.doubt.hardRule;
      const raised = await this.doubts.raise({
        project,
        task,
        runId: run.id,
        kind: hardRule ? "hard_rule" : "functional",
        engine: profile.engine,
        context: hardRule
          ? `Binding rule in the way: ${hardRule}\n\n${outcome.doubt.context}`
          : outcome.doubt.context,
        blocks: outcome.doubt.blocks,
        options: outcome.doubt.options,
        // A recommendation on a hard rule would be the agent proposing which way to break it.
        recommendation: hardRule ? null : (outcome.doubt.recommendation ?? null),
      });
      if (hardRule) {
        this.repos.events.append({
          runId: run.id,
          type: "system",
          payload: { reason: "hard rule blocked a decision", rule: hardRule },
        });
      }

      if (raised.outcome === "auto_continue") {
        result.autoContinued = { choice: raised.choice, decisionId: raised.decisionId };
        if (raised.checkpointTag) result.checkpointTag = raised.checkpointTag;
        // The caller re-runs the task with the decision in its context (DESIGN §8.2).
        this.repos.tasks.setStatus(task.id, "queued");
        this.bus.emit("overview");
        return result;
      }
      result.doubtRef = raised.doubt.ref;
    }

    this.repos.tasks.setStatus(task.id, outcome.status);
    this.bus.emit("overview");
    return result;
  }
}
