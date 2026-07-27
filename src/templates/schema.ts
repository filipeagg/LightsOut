/** Project template and phase schema (TP-01, TP-03, DESIGN §16.1). */
import { z } from "zod";

export const phaseGateSchema = z.enum(["auto", "human"]);

/** A deliverable outside the project, resolved against /workspace instead (§16.3). */
export const WORKSPACE_PREFIX = "workspace:";

export const templatePhaseSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "phase id must be lowercase alphanumeric with -"),
    title: z.string().min(1),
    /** Must resolve to a loaded, enabled agent profile; checked by the loader (AP-07). */
    agent: z.string().min(1),
    instructions: z.string().min(1),
    /**
     * A project-relative path, a `workspace:`-prefixed path, or a description of what the
     * phase must produce. A path containing `*` is a glob: the check is "at least one
     * match", not "this file exists" (§16.1).
     */
    deliverable: z.string().min(1).optional(),
    verify: z.string().min(1).optional(),
    gate: phaseGateSchema.default("auto"),
    optional: z.boolean().default(false),
    repeatable: z.boolean().default(false),
  })
  .strict();

export const projectTemplateSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "template id must be lowercase alphanumeric with -"),
    name: z.string().min(1),
    description: z.string().default(""),
    /**
     * The selection criteria (TP-10, §16.4). Separate from `description` on purpose: a
     * description says what the template is, and a caller comparing six of them needs to know
     * when it applies. Empty by default so files written before this stay valid.
     */
    when_to_use: z.string().default(""),
    not_for: z.string().default(""),
    /**
     * Only a template that declares this may carry `workspace:` deliverables, and
     * create_project refuses it without a writable base (KB-05, §16.3).
     */
    requires_writable_knowledge: z.boolean().default(false),
    phases: z.array(templatePhaseSchema).min(1),
  })
  .strict()
  .superRefine((template, ctx) => {
    const seen = new Set<string>();
    for (const phase of template.phases) {
      if (seen.has(phase.id)) {
        ctx.addIssue({ code: "custom", message: `duplicate phase id: ${phase.id}` });
      }
      seen.add(phase.id);
      if (phase.id.startsWith("adhoc-")) {
        ctx.addIssue({
          code: "custom",
          message: `phase id ${phase.id} is reserved for ad-hoc phases (TP-08)`,
        });
      }
      const deliverable = phase.deliverable;
      if (!deliverable) continue;
      if (deliverable.startsWith(WORKSPACE_PREFIX)) {
        if (!template.requires_writable_knowledge) {
          ctx.addIssue({
            code: "custom",
            message: `phase ${phase.id} writes outside the project but the template does not require a writable knowledge base (§16.3)`,
          });
        }
        const target = deliverable.slice(WORKSPACE_PREFIX.length);
        if (!target.startsWith("knowledge/")) {
          ctx.addIssue({
            code: "custom",
            message: `phase ${phase.id}: a workspace: deliverable may only live under knowledge/`,
          });
        }
      } else if (path_is_absolute(deliverable) || deliverable.includes("..")) {
        ctx.addIssue({
          code: "custom",
          message: `phase ${phase.id}: deliverable must be project-relative`,
        });
      }
    }
  });

/** No node:path here: the same check must hold whatever separator the file used. */
function path_is_absolute(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

export type TemplatePhase = z.infer<typeof templatePhaseSchema>;
export type ProjectTemplate = z.infer<typeof projectTemplateSchema>;

/** A template file that failed validation: listed with its reason, never selectable (TP-03). */
export type RejectedTemplate = { file: string; id?: string; error: string };
