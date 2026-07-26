/**
 * Machine-first documents (BA-07, BA-08, DESIGN §20).
 *
 * Every Markdown file the system writes and reads back is written for the machine that reads it
 * next: `key: value` lines, tables, stable ids, no prose and no chronicle of attempts. This module
 * measures whether a document still looks like that. It is a heuristic and says so: nothing here
 * fails a phase, and there is no size limit — `bytes` and `lines` are reported, never judged.
 */

import path from "node:path";
import { WORKSPACE_PREFIX } from "../templates/schema.js";

/** A document that declares itself prose is exempt from every check (DESIGN §20.2). */
export const HUMAN_MARKER = "<!-- lightsout:audience=human -->";

/**
 * The Markdown file a phase's `deliverable` points at, or undefined when there is nothing this
 * module may judge: no deliverable, a prose description rather than a path, a glob, or a file
 * that is not Markdown — another format is the user's business, not ours (§20.2).
 */
export function deliverablePath(
  workspace: string,
  projectPath: string,
  declared: string | null | undefined,
): string | undefined {
  const value = declared?.trim();
  if (!value) return undefined;
  if (/\s/.test(value) || value.includes("*")) return undefined;
  if (!/\.(md|markdown)$/i.test(value)) return undefined;
  const workspaceScoped = value.startsWith(WORKSPACE_PREFIX);
  const relative = workspaceScoped ? value.slice(WORKSPACE_PREFIX.length) : value;
  return path.resolve(workspaceScoped ? workspace : projectPath, relative);
}

export type DocumentMetrics = {
  bytes: number;
  lines: number;
  /** Keyed, table, heading or fenced lines ÷ non-empty lines. */
  structureRatio: number;
  /** Non-keyed lines carrying more than PROSE_WORDS words. */
  proseLines: number;
  /** Longest run of consecutive non-keyed, non-empty lines. */
  longestParagraph: number;
  /** Repeated normalised three-line windows ÷ windows. */
  duplicationRatio: number;
};

export type DocumentLint = {
  ok: boolean;
  /** True when the document declared itself human prose; every threshold is skipped. */
  exempt: boolean;
  metrics: DocumentMetrics;
  /** One line per failed threshold, in the words the prompt will use. */
  reasons: string[];
};

/** Thresholds (DESIGN §20.4). Named constants because they are a heuristic, not a truth. */
export const THRESHOLDS = {
  structureRatio: 0.7,
  proseLineShare: 0.05,
  longestParagraph: 3,
  duplicationRatio: 0.15,
  /** A non-keyed line longer than this counts as prose. */
  proseWords: 12,
  /** Below this many non-empty lines a document is too small to judge. */
  minLines: 12,
} as const;

/** `key: value`, and `key:` alone — a key introducing a fenced block or a table below it. */
const KEYED = /^[A-Za-z0-9_][A-Za-z0-9_.[\]-]*\s*:(\s|$)/;
const TABLE = /^\|/;
const HEADING = /^#{1,6}\s/;
const LIST_KEYED = /^\s*[-*]\s+[A-Za-z0-9_][A-Za-z0-9_.[\]-]*\s*:\s*\S/;
/** `- [x] Title <!-- lo:… -->`: the managed PLAN.md line, machine-parsed by design (PM-02). */
const CHECKBOX = /^\s*[-*]\s*\[[ xX]\]/;
const FENCE = /^\s*(```|~~~)/;
const COMMENT = /^\s*<!--/;

function normalise(line: string): string {
  return line.toLowerCase().replace(/\s+/g, " ").replace(/[`*_>|]/g, "").trim();
}

function isStructured(line: string): boolean {
  return (
    KEYED.test(line) ||
    LIST_KEYED.test(line) ||
    CHECKBOX.test(line) ||
    TABLE.test(line) ||
    HEADING.test(line) ||
    COMMENT.test(line)
  );
}

export function measureDocument(text: string): DocumentMetrics {
  const rawLines = text.split("\n");
  const bytes = Buffer.byteLength(text, "utf8");

  let inFence = false;
  const considered: { line: string; structured: boolean }[] = [];
  for (const raw of rawLines) {
    const line = raw.trimEnd();
    if (FENCE.test(line)) {
      inFence = !inFence;
      considered.push({ line, structured: true });
      continue;
    }
    if (!line.trim()) continue;
    // Fenced content is data, not prose: counted as structure without being read.
    considered.push({ line, structured: inFence || isStructured(line) });
  }

  const nonEmpty = considered.length;
  const structured = considered.filter((entry) => entry.structured).length;

  let proseLines = 0;
  let longestParagraph = 0;
  let run = 0;
  for (const entry of considered) {
    if (entry.structured) {
      run = 0;
      continue;
    }
    run += 1;
    longestParagraph = Math.max(longestParagraph, run);
    if (entry.line.trim().split(/\s+/).length > THRESHOLDS.proseWords) proseLines += 1;
  }

  // Repetition: identical three-line windows, which is what a document rewritten pass after pass
  // accumulates. Single repeated lines (a table separator, a recurring key) are not interesting.
  const windows: string[] = [];
  for (let i = 0; i + 2 < considered.length; i += 1) {
    windows.push(
      [considered[i]!.line, considered[i + 1]!.line, considered[i + 2]!.line]
        .map(normalise)
        .join("|"),
    );
  }
  const seen = new Set<string>();
  let repeated = 0;
  for (const window of windows) {
    if (seen.has(window)) repeated += 1;
    else seen.add(window);
  }

  return {
    bytes,
    lines: nonEmpty,
    structureRatio: nonEmpty === 0 ? 1 : structured / nonEmpty,
    proseLines,
    longestParagraph,
    duplicationRatio: windows.length === 0 ? 0 : repeated / windows.length,
  };
}

/** Measure a document and say, in the words the prompt will use, what is wrong with it. */
export function lintDocument(text: string): DocumentLint {
  const metrics = measureDocument(text);
  if (text.includes(HUMAN_MARKER)) {
    return { ok: true, exempt: true, metrics, reasons: [] };
  }
  // Too short to judge: a five-line document has no shape to speak of.
  if (metrics.lines < THRESHOLDS.minLines) {
    return { ok: true, exempt: false, metrics, reasons: [] };
  }

  const reasons: string[] = [];
  if (metrics.structureRatio < THRESHOLDS.structureRatio) {
    reasons.push(
      `only ${Math.round(metrics.structureRatio * 100)}% of the lines are key: value, tables or headings (want ${Math.round(THRESHOLDS.structureRatio * 100)}%)`,
    );
  }
  if (metrics.proseLines > Math.ceil(metrics.lines * THRESHOLDS.proseLineShare)) {
    reasons.push(
      `${metrics.proseLines} prose lines longer than ${THRESHOLDS.proseWords} words; each should be one fact as key: value`,
    );
  }
  if (metrics.longestParagraph > THRESHOLDS.longestParagraph) {
    reasons.push(
      `a paragraph of ${metrics.longestParagraph} consecutive prose lines; paragraphs do not belong in this document`,
    );
  }
  if (metrics.duplicationRatio > THRESHOLDS.duplicationRatio) {
    reasons.push(
      `${Math.round(metrics.duplicationRatio * 100)}% of the content repeats itself; supersede in place instead of appending another pass`,
    );
  }

  return { ok: reasons.length === 0, exempt: false, metrics, reasons };
}

/**
 * The block a prompt carries when the deliverable that already exists fails the check
 * (BA-08, DESIGN §20.4). Compacting comes first: an agent that adds to a bloated document makes
 * it worse, however good the addition is.
 */
export function compactionBlock(deliverable: string, lint: DocumentLint): string {
  return [
    `# Your deliverable needs compacting first`,
    "",
    `file: ${deliverable}`,
    `bytes: ${lint.metrics.bytes}`,
    `lines: ${lint.metrics.lines}`,
    ...lint.reasons.map((reason, i) => `problem.${i + 1}: ${reason}`),
    "",
    "Rewrite it in the machine-first format before adding anything new: one fact per line as",
    "`key: value`, tables for repeated shapes, stable ids, a `source:` on every claim, and the",
    "current state superseding the previous one — no history of passes, no paragraphs, no",
    "repetition. Keep every fact; drop every sentence that carries none.",
  ].join("\n");
}
