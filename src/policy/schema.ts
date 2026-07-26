/** Policy pack schema (PE-01, DESIGN §7.2). */
import { z } from "zod";

export const ACTION_CLASSES = [
  "project_read",
  "project_write",
  "exec_check",
  /**
   * Running code the agent itself supplied: an interpreter over a script file, or inline code
   * (PE-07, DESIGN §7.1). Separate from `exec_check` because `npm test` runs behaviour the project
   * already owns, while a fresh script is whatever the agent wrote a minute ago — a pack must be
   * able to allow one and refuse the other. The class is only reached when the body of the code has
   * been read and carries none of the dangerous families.
   */
  "script_exec",
  "git_local",
  "git_push",
  "deps_install",
  "network",
  "delete",
  "outside_workspace",
  "credentials",
  "publish_external",
  "knowledge_write",
  "other",
] as const;

export type ActionClass = (typeof ACTION_CLASSES)[number];

export const actionClassSchema = z.enum(ACTION_CLASSES);
export const verdictSchema = z.enum(["allow", "deny", "require_human", "provisional"]);
export type Verdict = z.infer<typeof verdictSchema>;

export const policyRuleSchema = z
  .object({
    class: actionClassSchema,
    verdict: verdictSchema,
    /** Optional human-readable justification, surfaced in doubts. */
    reason: z.string().optional(),
  })
  .strict();

export const policyPackSchema = z
  .object({
    id: z.string().min(1),
    /** First match wins, evaluated top-down (DESIGN §7.2). */
    rules: z.array(policyRuleSchema).default([]),
    /**
     * Project-relative path prefixes a write may touch (§19: `read-only` writes only under
     * `doc/`, `probe` only under `probes/`, `test` only in the test directories). Empty means
     * unconfined. A write outside every prefix is denied whatever the class rule says, which is
     * how BA-05 is enforced by the engine instead of by instructions.
     */
    write_scopes: z.array(z.string().min(1)).default([]),
    /** Vault behaviour for runs on this pack (VT-06, DESIGN §18). */
    vault: z
      .object({
        /** Only entries flagged test_only may be resolved; the rest are refused and audited. */
        test_only_required: z.boolean().default(false),
      })
      .strict()
      .default({ test_only_required: false }),
    /**
     * Extra regexes per class, merged on top of the built-in matcher table.
     * Keys are action classes; unknown keys are rejected explicitly so a typo in a pack
     * cannot silently disable a matcher.
     */
    matchers: z
      .record(z.string(), z.array(z.string().min(1)))
      .default({})
      .refine(
        (value: Record<string, string[]>) =>
          Object.keys(value).every((key) => (ACTION_CLASSES as readonly string[]).includes(key)),
        { message: "matchers contains a key that is not an action class" },
      ),
  })
  .strict();

export type PolicyRule = z.infer<typeof policyRuleSchema>;
export type PolicyPack = z.infer<typeof policyPackSchema>;

/**
 * Hard floor (PE-03), not overridable by any pack:
 * - `outside_workspace` never resolves to allow or provisional.
 * - `credentials` and `publish_external` never resolve below require_human.
 * Force-push is classified as `credentials`-grade elsewhere (classify.ts).
 */
export const NEVER_ALLOW: ReadonlySet<ActionClass> = new Set<ActionClass>([
  "outside_workspace",
]);
export const NEVER_BELOW_HUMAN: ReadonlySet<ActionClass> = new Set<ActionClass>([
  "credentials",
  "publish_external",
]);
