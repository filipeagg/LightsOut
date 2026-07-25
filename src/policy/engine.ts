/**
 * Policy evaluation (PE-01..05, DESIGN §7.3).
 *
 * evaluate(): classify → look up the class in the project pack, then the agent pack, then
 * `default` → first hit wins, recording where it came from. The hard floor of PE-03 is applied
 * afterwards and cannot be overridden by any pack. Pure in-memory work; the caller writes the
 * audit row so the latency measured includes only the decision (PE-04).
 */
import path from "node:path";
import { Classifier, pathsInCommand, type ClassifyInput } from "./classify.js";
import {
  NEVER_ALLOW,
  NEVER_BELOW_HUMAN,
  type ActionClass,
  type PolicyPack,
  type Verdict,
} from "./schema.js";
import type { RuleSource } from "../db/types.js";

export type EvaluateInput = ClassifyInput;

export type Decision = {
  class: ActionClass;
  verdict: Verdict;
  ruleSource: RuleSource;
  reason: string;
  /** True when the hard floor overrode what the packs said (PE-03). */
  floored: boolean;
  latencyMs: number;
};

export type PolicyLayers = {
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

  constructor(private readonly layers: PolicyLayers) {
    this.classifier = new Classifier({
      ...(layers.default?.matchers ?? {}),
      ...(layers.agent?.matchers ?? {}),
      ...(layers.project?.matchers ?? {}),
    });
  }

  private lookup(
    cls: ActionClass,
  ): { verdict: Verdict; source: RuleSource; reason?: string } | undefined {
    const order: [RuleSource, PolicyPack | undefined][] = [
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
  private outOfScopeWrite(input: EvaluateInput, cls: ActionClass): string | undefined {
    if (cls !== "project_write" && cls !== "delete") return undefined;
    const confined = this.writeScopes();
    if (!confined) return undefined;
    const targets = [
      ...(input.paths ?? []),
      ...[input.command, ...(input.commands ?? [])]
        .filter((c): c is string => Boolean(c))
        .flatMap((c) => pathsInCommand(c)),
    ];
    // A confined pack cannot approve a write whose target it cannot see.
    if (targets.length === 0) return "(the request declares no path)";
    for (const target of targets) {
      const resolved = path.resolve(input.projectPath, target);
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

    const outOfScope = this.outOfScopeWrite(input, classification.class);
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
