/** Knowledge base manifest schema (KB-01, KB-02, DESIGN §17.1). */
import { resolve as pathResolve, sep } from "node:path";
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
     * A folder inside the workspace that holds the documents instead of this directory (KB-08).
     * Relative to the workspace root, forward slashes. The manifest and `index.md` still live
     * here; the documents are read from there on every load, so the folder stays the source of
     * truth. Validated by `resolveSource` — the container only sees the workspace (RT-02) and
     * this value arrives from a browser.
     */
    source: z.string().min(1).optional(),
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

/** The document extensions a base may hold. A base is text that goes into a prompt (KB-08). */
export const DOCUMENT_EXTENSIONS = [".md", ".markdown", ".txt"] as const;

export function isDocumentFile(file: string): boolean {
  const dot = file.lastIndexOf(".");
  if (dot < 1) return false;
  return (DOCUMENT_EXTENSIONS as readonly string[]).includes(file.slice(dot).toLowerCase());
}

/**
 * Turn a manifest `source` into an absolute directory inside the workspace, or explain why it
 * cannot be one. Refused: an absolute path, anything that climbs out of the workspace, the
 * workspace root itself, and `knowledge/` — a base pointing into the knowledge tree would either
 * be its own source or shadow another base's documents.
 */
export function resolveSource(
  workspace: string,
  source: string,
): { dir: string } | { error: string } {
  const cleaned = source.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (cleaned === "") return { error: "source is empty" };
  if (cleaned.startsWith("/") || /^[a-zA-Z]:/.test(cleaned)) {
    return {
      error: `source must be relative to the workspace, not an absolute path: ${source}`,
    };
  }
  const root = pathResolve(workspace);
  const dir = pathResolve(workspace, cleaned);
  if (dir === root) return { error: "source cannot be the workspace root itself" };
  if (!dir.startsWith(root + sep)) {
    return { error: `source escapes the workspace: ${source}` };
  }
  const knowledge = pathResolve(workspace, "knowledge");
  if (dir === knowledge || dir.startsWith(knowledge + sep)) {
    return { error: "source cannot point inside knowledge/; that is where the bases live" };
  }
  return { dir };
}
