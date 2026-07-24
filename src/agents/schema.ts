/** Agent profile schema (AP-01, AP-04, AP-05). */
import { z } from "zod";

export const engineSchema = z.enum(["claude", "codex"]);

export const agentProfileSchema = z
  .object({
    /** Stable id used by tasks; defaults to the file name when omitted. */
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9_-]*$/, "id must be lowercase alphanumeric with - or _"),
    name: z.string().min(1),
    engine: engineSchema,
    model: z.string().min(1).optional(),
    /** Engine-specific reasoning effort; passed through untouched. */
    reasoning: z.enum(["minimal", "low", "medium", "high"]).optional(),
    instructions: z.string().default(""),
    /** Shared fragments included before instructions (AP-04). */
    include: z.array(z.string().min(1)).default([]),
    /** Default policy pack id (PE-05). */
    policy: z.string().min(1).default("default"),
    tags: z.array(z.string().min(1)).default([]),
    /** Read-only advisory profile used for second opinions (SR-08). */
    advisor: z.boolean().default(false),
  })
  .strict();

export type AgentProfile = z.infer<typeof agentProfileSchema>;

/** A profile file that failed validation: reported, never silently dropped (AP-02). */
export type RejectedProfile = { file: string; error: string };
