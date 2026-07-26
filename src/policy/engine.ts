/**
 * Policy evaluation (PE-01..05, DESIGN §7.3).
 *
 * evaluate(): classify → look up the class in the project pack, then the agent pack, then
 * `default` → first hit wins, recording where it came from. The hard floor of PE-03 is applied
 * afterwards and cannot be overridden by any pack. Pure in-memory work; the caller writes the
 * audit row so the latency measured includes only the decision (PE-04).
 */
import path from "node:path";
import {
  Classifier,
  commandShape,
  pathsInCommand,
  scratchRoot,
  type ClassifyInput,
} from "./classify.js";
import {
  NEVER_ALLOW,
  NEVER_BELOW_HUMAN,
  NEVER_LEARNED,
  type ActionClass,
  type PolicyPack,
  type Verdict,
} from "./schema.js";
import type { RuleSource } from "../db/types.js";
import { managerOf } from "../projects/toolchain.js";

export type EvaluateInput = ClassifyInput;

export type Decision = {
  class: ActionClass;
  verdict: Verdict;
  ruleSource: RuleSource;
  reason: string;
  /** True when the hard floor overrode what the packs said (PE-03). */
  floored: boolean;
  /** Set when a remembered human allow decided this (PE-10); the caller records the use. */
  learnedShape?: string;
  /** Set when a per-project toolchain grant decided this (ST-07); the caller records the use. */
  toolchainManager?: string;
  latencyMs: number;
};

export type PolicyLayers = {
  /**
   * Capabilities granted for this one run (PE-12). The most specific layer there is: someone
   * asked for it at launch, it is recorded on the task, and it dies with the run. The hard floor
   * of PE-03 still applies on top.
   */
  grant?: PolicyPack | undefined;
  /** Per-project override pack from lightsout.yaml (PE-05). */
  project?: PolicyPack | undefined;
  /** The agent profile's pack. */
  agent?: PolicyPack | undefined;
  /** The `default` pack; the last resort before the built-in fallback. */
  default?: PolicyPack | undefined;
};

/** Used when no pack declares a class: the safe answer is to ask a human. */
const FALLBACK_VERDICT: Verdict = "require_human";

export class PolicyEngine {
  private readonly classifier: Classifier;

  /**
   * Command shapes a human has already allowed at a gate (PE-10). Consulted only for `other`:
   * a class the classifier understood is decided by the packs, as before.
   */
  private readonly learned: ((shape: string) => boolean) | undefined;

  /**
   * Package managers this project has been authorised to install into its own toolchain with
   * (ST-07, §7.6). Separate from `learned` because the memory is per project, not system-wide.
   */
  private readonly toolchainGrant: ((manager: string) => boolean) | undefined;

  constructor(
    private readonly layers: PolicyLayers,
    options: {
      scriptScanBytes?: number;
      learnedAllow?: (shape: string) => boolean;
      toolchainGrant?: (manager: string) => boolean;
    } = {},
  ) {
    this.learned = options.learnedAllow;
    this.toolchainGrant = options.toolchainGrant;
    this.classifier = new Classifier(
      {
        ...(layers.default?.matchers ?? {}),
        ...(layers.agent?.matchers ?? {}),
        ...(layers.project?.matchers ?? {}),
      },
      options,
    );
  }

  private lookup(
    cls: ActionClass,
  ): { verdict: Verdict; source: RuleSource; reason?: string } | undefined {
    const order: [RuleSource, PolicyPack | undefined][] = [
      // A per-run grant is the most specific thing anyone said about this run (PE-12).
      ["project", this.layers.grant],
      ["project", this.layers.project],
      ["agent", this.layers.agent],
      ["default", this.layers.default],
    ];
    for (const [source, pack] of order) {
      const rule = pack?.rules.find((r) => r.class === cls);
      if (rule) {
        return rule.reason !== undefined
          ? { verdict: rule.verdict, source, reason: rule.reason }
          : { verdict: rule.verdict, source };
      }
    }
    return undefined;
  }

  /** Apply PE-03. Returns the possibly tightened verdict. */
  private static floor(cls: ActionClass, verdict: Verdict): Verdict {
    if (NEVER_ALLOW.has(cls) && (verdict === "allow" || verdict === "provisional")) {
      return "deny";
    }
    if (NEVER_BELOW_HUMAN.has(cls) && verdict !== "deny" && verdict !== "require_human") {
      return "require_human";
    }
    return verdict;
  }

  /**
   * The first pack in the layer order that confines writes, and the paths it allows
   * (§19, BA-05). A pack with no `write_scopes` leaves writes unconfined.
   */
  private writeScopes(): { scopes: string[]; source: RuleSource } | undefined {
    const order: [RuleSource, PolicyPack | undefined][] = [
      // A per-run grant is the most specific thing anyone said about this run (PE-12).
      ["project", this.layers.grant],
      ["project", this.layers.project],
      ["agent", this.layers.agent],
      ["default", this.layers.default],
    ];
    for (const [source, pack] of order) {
      if (pack?.write_scopes?.length) return { scopes: pack.write_scopes, source };
    }
    return undefined;
  }

  /** Reject a write that lands outside the pack's scopes; undefined means it is allowed. */
  private outOfScopeWrite(
    input: EvaluateInput,
    cls: ActionClass,
    scriptPaths?: string[],
  ): string | undefined {
    const scriptRun = cls === "script_exec";
    if (cls !== "project_write" && cls !== "delete" && !scriptRun) return undefined;
    const confined = this.writeScopes();
    if (!confined) return undefined;
    const targets = scriptRun
      ? (scriptPaths ?? [])
      : [
          ...(input.paths ?? []),
          ...[input.command, ...(input.commands ?? [])]
            .filter((c): c is string => Boolean(c))
            .flatMap((c) => pathsInCommand(c)),
        ];
    // A confined pack cannot approve a write whose target it cannot see. A script is the
    // exception: its body has been inspected and confined to the project (PE-07), and a body
    // that names no path may well only be reading, so an invisible target is not a refusal —
    // it is the limit of what static inspection can promise, and DESIGN §7.1 says so.
    if (targets.length === 0) return scriptRun ? undefined : "(the request declares no path)";
    const scratch = scratchRoot(input.projectPath);
    for (const target of targets) {
      const resolved = path.resolve(input.projectPath, target);
      // The scratch directory is writable under every pack (PE-08): a confined agent still needs
      // somewhere to put its tooling, and everything there is removed when the run ends.
      if (Classifier.isInside(scratch, resolved)) continue;
      const allowed = confined.scopes.some((scope) =>
        Classifier.isInside(path.resolve(input.projectPath, scope), resolved),
      );
      if (!allowed) return target;
    }
    return undefined;
  }

  evaluate(input: EvaluateInput): Decision {
    const startedAt = performance.now();
    const classification = this.classifier.classify(input);
    const hit = this.lookup(classification.class);

    const outOfScope = this.outOfScopeWrite(
      input,
      classification.class,
      classification.scriptPaths,
    );
    if (outOfScope) {
      const confined = this.writeScopes()!;
      return {
        class: classification.class,
        verdict: "deny",
        ruleSource: confined.source,
        reason: `${classification.reason}; write outside this pack's scopes (${confined.scopes.join(", ")}): ${outOfScope}`,
        floored: true,
        latencyMs: performance.now() - startedAt,
      };
    }

    // PE-10: a command whose shape a person has already allowed does not ask again. Every class
    // except the two where a wrong memory cannot be taken back — a credential and a publication
    // are asked every time — and except `outside_workspace`, which can never be allowed at all.
    if (!NEVER_LEARNED.has(classification.class) && this.learned) {
      const command = [input.command, ...(input.commands ?? [])].find((c) => c?.trim());
      const shape = command ? commandShape(command) : "";
      if (shape && this.learned(shape)) {
        return {
          class: classification.class,
          verdict: "allow",
          ruleSource: "default",
          reason: `${classification.reason}; allowed by a human before, remembered as: ${shape}`,
          floored: false,
          learnedShape: shape,
          latencyMs: performance.now() - startedAt,
        };
      }
    }

    // ST-07: the user authorised this project to install with this package manager, so the same
    // project does not ask again. Scoped to the project and to the manager, and revocable on its
    // own — the whole reason this is not a learned shape.
    if (classification.class === "toolchain_install" && this.toolchainGrant) {
      const command = [input.command, ...(input.commands ?? [])].find((c) => c?.trim());
      const manager = command ? managerOf(command.trim()) : undefined;
      if (manager && this.toolchainGrant(manager)) {
        return {
          class: classification.class,
          verdict: "allow",
          ruleSource: "project",
          reason: `${classification.reason}; ${manager} is authorised for this project's toolchain (ST-07)`,
          floored: false,
          toolchainManager: manager,
          latencyMs: performance.now() - startedAt,
        };
      }
    }

    const rawVerdict = hit?.verdict ?? FALLBACK_VERDICT;
    const verdict = PolicyEngine.floor(classification.class, rawVerdict);
    const floored = verdict !== rawVerdict;

    const reasonParts = [classification.reason];
    if (hit?.reason) reasonParts.push(hit.reason);
    if (!hit) reasonParts.push("no rule for this class, defaulting to require_human");
    if (floored) reasonParts.push(`hard floor applied (was ${rawVerdict})`);

    return {
      class: classification.class,
      verdict,
      ruleSource: hit?.source ?? "default",
      reason: reasonParts.join("; "),
      floored,
      latencyMs: performance.now() - startedAt,
    };
  }
}
