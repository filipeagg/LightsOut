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
    /** Default policy pack id (PE-05). One of the three of PE-14, or a retired id still loading. */
    policy: z.string().min(1).default("build"),
    /**
     * Where this agent may write, project-relative (PE-14, §7.2b). Overrides the pack's own
     * scopes. It lives here because it describes *this agent* — a prober writes into `probes/`,
     * a planner into `doc/` — and putting it on the pack is why confining an agent used to mean
     * inventing a pack for it. Empty means unconfined, which is what `build` alone gives.
     */
    writeScopes: z.array(z.string().min(1)).default([]),
    /**
     * Extra permissions this agent has beyond its pack (PE-14). Deliberately a short list: these
     * are properties of a job, not degrees of trust, which is what the pack is for. Anything that
     * leaves the machine is a pack, not a capability.
     */
    capabilities: z.array(z.enum(["knowledge_write", "serve"])).default([]),
    tags: z.array(z.string().min(1)).default([]),
    /** Read-only advisory profile used for second opinions (SR-08). */
    advisor: z.boolean().default(false),
    /**
     * A disabled profile stays in the library, and in the templates that name it, but cannot
     * be launched and makes those templates unusable until it comes back (AP-07).
     */
    enabled: z.boolean().default(true),
    /** What a task run on this profile is expected to leave behind (BA-04). */
    deliverable: z.string().min(1).optional(),
  })
  .strict();

export type AgentProfile = z.infer<typeof agentProfileSchema>;

/** A profile file that failed validation: reported, never silently dropped (AP-02). */
export type RejectedProfile = { file: string; error: string };
