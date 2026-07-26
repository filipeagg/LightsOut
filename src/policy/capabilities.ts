/**
 * What a task needs, checked before it starts (PE-12, DESIGN §7.5).
 *
 * The failure this exists for: a task that had to call an API, install `openpyxl` and write an
 * `.xlsx` was launched on `builder`, whose pack denies the network. Twenty minutes later the agent
 * worked out that it could not do the job and explained why. Nothing was wrong with the policy or
 * with the agent — the mismatch was knowable at launch and nobody looked.
 *
 * So a launch declares what it needs, the pack is asked whether it grants it, and a launch that
 * cannot succeed is refused in a second, naming which agent could and what to pass to grant it.
 */
import type { PolicyPack, ActionClass, Verdict } from "./schema.js";

/** The capabilities a caller can ask for. Deliberately few: these are the ones that stop work. */
export const CAPABILITIES = [
  "network",
  "deps_install",
  /** Installing into this project's durable toolchain (ST-07); authorised once, per manager. */
  "toolchain_install",
  /** Starting a preview server for a person to look at (PV-05); only via `preview_start`. */
  "serve",
  "execute",
  "write",
  "git",
  "delete",
  "knowledge_write",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** The action class each capability is really about. */
const CLASS_OF: Record<Capability, ActionClass> = {
  network: "network",
  deps_install: "deps_install",
  toolchain_install: "toolchain_install",
  serve: "serve",
  execute: "exec_check",
  write: "project_write",
  git: "git_local",
  delete: "delete",
  knowledge_write: "knowledge_write",
};

export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

/** What a pack answers for a class, following the layers the engine follows. */
function verdictFor(packs: (PolicyPack | undefined)[], cls: ActionClass): Verdict | undefined {
  for (const pack of packs) {
    const rule = pack?.rules.find((r) => r.class === cls);
    if (rule) return rule.verdict;
  }
  return undefined;
}

export type CapabilityCheck = {
  capability: Capability;
  verdict: Verdict | "unset";
  /** True when the run can use it without a human in the way. */
  granted: boolean;
};

export function checkCapabilities(
  needs: Capability[],
  packs: { project?: PolicyPack | undefined; agent?: PolicyPack | undefined; default?: PolicyPack | undefined },
): CapabilityCheck[] {
  const layers = [packs.project, packs.agent, packs.default];
  return needs.map((capability) => {
    const verdict = verdictFor(layers, CLASS_OF[capability]) ?? "unset";
    return {
      capability,
      verdict,
      // `require_human` is not a grant: it is a run that stops in the middle, which is the whole
      // thing being avoided. `provisional` is, because it proceeds.
      granted: verdict === "allow" || verdict === "provisional",
    };
  });
}

/**
 * The refusal, written so the person reading it can act on it: what is missing, which builtin
 * agent has it, and the exact way to grant it for this launch (PE-12).
 */
export function explainMismatch(input: {
  agentId: string;
  missing: CapabilityCheck[];
  alternatives: { agentId: string; policy: string }[];
}): string {
  const names = input.missing.map((m) => `${m.capability} (${m.verdict})`).join(", ");
  const others = input.alternatives.length
    ? `Agents whose pack already grants them: ${input.alternatives
        .map((a) => `${a.agentId} (${a.policy})`)
        .join(", ")}. `
    : "";
  const grants = input.missing.map((m) => `"${m.capability}"`).join(", ");
  return (
    `agent ${input.agentId} cannot do what this task declares it needs: ${names} (PE-12). ` +
    `${others}` +
    `To let this one run do it anyway, relaunch with grants: [${grants}] — recorded on the run ` +
    `and gone when it ends. To change it for the whole project, add the rules to policy in ` +
    `lightsout.yaml.`
  );
}

/**
 * A pack that adds the granted capabilities on top of the agent's, for one run only (PE-12).
 * Nothing is taken away, the hard floor of PE-03 is untouched, and the grant is recorded on the
 * run so a widened boundary is never invisible.
 */
export function grantPack(grants: Capability[], forRun: string): PolicyPack {
  return {
    id: `grant:${forRun}`,
    rules: grants.map((capability) => ({
      class: CLASS_OF[capability],
      verdict: "allow" as Verdict,
      reason: `granted for this run (PE-12)`,
    })),
    write_scopes: [],
    vault: { test_only_required: false },
    matchers: {},
  };
}
