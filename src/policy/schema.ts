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
  /**
   * Installing into this project's durable toolchain volume (ST-07, DESIGN §7.6). Its own class
   * because it sits between the two that already exist: unlike `.lightsout/tmp/deps` it outlives
   * the run, and unlike `deps_install` it touches nothing outside one project's own directory.
   * Every pack asks a human for it, and the answer is remembered per project and per manager —
   * which is why it cannot simply be `deps_install` with a nicer target.
   */
  "toolchain_install",
  /**
   * Starting a long-lived server (PV-05, DESIGN §21.4). Its own class because it is the one
   * command that does not end: run in the agent's terminal it holds the run open until the
   * inactivity watchdog kills it, so inline it is denied and `preview_start` is the way. A pack
   * grants the capability; the class exists so the refusal can say what to do instead.
   */
  "serve",
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

/**
 * Classes whose allows are never remembered (PE-10). Everything else is: a person who read the
 * command and said yes should not be asked the same thing again — the second identical question is
 * a defect, not diligence. These two are the exception because a wrong memory leaks a secret or
 * publishes something, and neither can be taken back. `outside_workspace` is here for a different
 * reason: it can never be allowed at all (PE-03).
 */
export const NEVER_LEARNED: ReadonlySet<ActionClass> = new Set<ActionClass>([
  "credentials",
  "publish_external",
  "outside_workspace",
  // ST-07: a toolchain install *is* remembered, but per project and per package manager, not by
  // command shape. A shape is system-wide, and `npm install <str>` allowed for one project would
  // silently authorise every other one. The grant table is the memory here (§7.6).
  "toolchain_install",
]);
