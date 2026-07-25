/** Knowledge base manifest schema (KB-01, KB-02, DESIGN §17.1). */
import { z } from "zod";

/**
 * What kind of fact the base holds. It is injected next to every document because an agent
 * that cannot tell "the organisation prefers X" from "the database enforces X" will treat a
 * preference as a constraint, or worse, the reverse (KB-02).
 */
export const knowledgeKindSchema = z.enum([
  "technical",
  "functional",
  "organisational",
  "market",
  "other",
]);

export const knowledgeManifestSchema = z
  .object({
    /** Must equal the directory name; the loader checks it. */
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "base id must be lowercase alphanumeric with -"),
    name: z.string().min(1),
    kind: knowledgeKindSchema,
    description: z.string().default(""),
    tags: z.array(z.string().min(1)).default([]),
    owner: z.string().optional(),
    /**
     * ISO date or datetime, used to break relevance ties newest first (KB-06). YAML turns an
     * unquoted `2026-07-25` into a Date, so both shapes are accepted and normalised.
     */
    updated: z
      .union([z.string(), z.date()])
      .transform((value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value))
      .optional(),
  })
  .strict();

export type KnowledgeKind = z.infer<typeof knowledgeKindSchema>;
export type KnowledgeManifest = z.infer<typeof knowledgeManifestSchema>;

export type RejectedBase = { dir: string; error: string };
