/**
 * Block 3 of the prompt: curated knowledge (KB-04, KB-06, DESIGN §17.2).
 *
 * Manifests and every `index.md` go in whatever the budget, because the worst failure mode is
 * an agent not knowing that the answer exists somewhere. Documents then go in full until the
 * budget is spent, ordered by a deliberately dumb score. What did not fit is listed with the
 * exact call that fetches it: the bases are mounted read-only anyway, so this is a pointer,
 * not a gate.
 */
import type { KnowledgeBase, KnowledgeLoader } from "./loader.js";

export type InjectionContext = {
  /** Project tags plus the phase title, lowercased by the scorer. */
  tags?: string[];
  phaseTitle?: string;
  budgetChars: number;
};

export type InjectedDocument = { baseId: string; file: string; chars: number };

export type KnowledgeBlock = {
  text: string;
  included: InjectedDocument[];
  omitted: InjectedDocument[];
  chars: number;
};

function header(base: KnowledgeBase, file: string): string {
  const binding = isHard(base) ? "hard rule · " : "";
  return `--- knowledge: ${base.manifest.id} (${binding}${base.manifest.kind}) — ${file} ---`;
}

export function isHard(base: KnowledgeBase): boolean {
  return base.manifest.enforcement === "hard";
}

/**
 * The preamble to a hard-rule block (KB-11a). It states who decided, what the agent may not do,
 * and the exact shape of the sentinel that raises the question instead — because "ask a human"
 * without the mechanics is an instruction an agent cannot follow.
 */
const HARD_RULE_PREAMBLE = [
  "# Binding rules — you may not decide against these",
  "",
  "These are not context to weigh against the task. They were decided before this task and are",
  "not being reopened here. Follow them even where you would have chosen differently.",
  "",
  "If completing the task would require contradicting one of them, that decision is not yours to",
  "take. Do not do it and note it; do not find a reading of the rule that permits it. Stop, and",
  "end your turn with the result sentinel, carrying `hardRule`:",
  "",
  "  <<<LIGHTSOUT_RESULT",
  "  {",
  '    "status": "doubt",',
  '    "summary": "…",',
  '    "doubt": {',
  '      "hardRule": "<base>/<document>",',
  '      "context": "which rule you would have to break, and why you believe this task needs it",',
  '      "blocks": "what cannot be finished until this is answered",',
  '      "options": [',
  '        { "id": "A", "text": "what breaking the rule would look like" },',
  '        { "id": "B", "text": "the alternative that respects it" }',
  "      ]",
  "    }",
  "  }",
  "  >>>",
  "",
  "A person answers that. No other agent can approve it for you.",
  "",
].join("\n");

/** Tag overlap first, then recency; ties break on size so the budget buys breadth. */
function score(base: KnowledgeBase, wanted: Set<string>): number {
  let hits = 0;
  for (const tag of base.manifest.tags) {
    if (wanted.has(tag.toLowerCase())) hits += 1;
  }
  for (const word of base.manifest.name.toLowerCase().split(/\W+/)) {
    if (word.length > 3 && wanted.has(word)) hits += 1;
  }
  return hits;
}

function words(context: InjectionContext): Set<string> {
  const parts = [...(context.tags ?? []), ...(context.phaseTitle ?? "").split(/\W+/)];
  return new Set(parts.map((p) => p.trim().toLowerCase()).filter((p) => p.length > 2));
}

export async function buildKnowledgeBlock(
  loader: KnowledgeLoader,
  baseIds: string[],
  context: InjectionContext,
): Promise<KnowledgeBlock> {
  const bases = baseIds
    .map((id) => loader.get(id))
    .filter((base): base is KnowledgeBase => Boolean(base));
  if (bases.length === 0) {
    return { text: "", included: [], omitted: [], chars: 0 };
  }

  const wanted = words(context);
  const hard = bases.filter(isHard);
  const advisory = bases.filter((base) => !isHard(base));
  const lines: string[] = [];
  const included: InjectedDocument[] = [];
  const omitted: InjectedDocument[] = [];

  // Hard rules go first and go in whole, budget or no budget (KB-11a). A binding rule dropped to
  // save characters is worse than no rule at all: the agent would be bound by something it was
  // never shown, and would break it in good faith.
  if (hard.length > 0) {
    lines.push(HARD_RULE_PREAMBLE);
    for (const base of hard) {
      lines.push(header(base, "manifest"));
      lines.push(`name: ${base.manifest.name}`);
      lines.push(`kind: ${base.manifest.kind}`);
      if (base.manifest.description) lines.push(`description: ${base.manifest.description}`);
      lines.push("");
      if (base.index) {
        lines.push(header(base, "index.md"));
        lines.push(base.index.trim());
        lines.push("");
      }
      for (const doc of base.documents) {
        let body: string;
        try {
          body = await loader.readDocument(base.manifest.id, doc.file);
        } catch {
          // A binding rule that cannot be read is stated as missing rather than passed over: the
          // agent must know a rule exists that it has not seen.
          lines.push(
            `${header(base, doc.file)}\n(this rule could not be read; treat it as binding and ` +
              `ask before acting in the area it covers)\n`,
          );
          omitted.push({ baseId: base.manifest.id, file: doc.file, chars: doc.bytes });
          continue;
        }
        const chunk = `${header(base, doc.file)}\n${body.trim()}\n`;
        lines.push(chunk);
        included.push({ baseId: base.manifest.id, file: doc.file, chars: chunk.length });
      }
    }
    lines.push("# Attached knowledge — context, not rules");
    lines.push("");
  }

  if (advisory.length === 0) {
    const text = lines.join("\n");
    return { text, included, omitted, chars: text.length };
  }

  lines.push(
    "The following knowledge bases are attached to this project. Each document is labelled",
    "with the base it came from and what kind of fact it holds: a technical constraint and an",
    "organisational preference are not the same thing and must not be treated as one.",
    "",
  );

  for (const base of advisory) {
    const { manifest } = base;
    lines.push(header(base, "manifest"));
    lines.push(`name: ${manifest.name}`);
    lines.push(`kind: ${manifest.kind}`);
    if (manifest.description) lines.push(`description: ${manifest.description}`);
    if (manifest.tags.length > 0) lines.push(`tags: ${manifest.tags.join(", ")}`);
    if (manifest.updated) lines.push(`updated: ${manifest.updated}`);
    lines.push("");
    if (base.index) {
      lines.push(header(base, "index.md"));
      lines.push(base.index.trim());
      lines.push("");
    }
  }

  // Ranking across every advisory base at once: relevance, then recency, then smallest first.
  // Hard rules are not in here — they are already in, in full, and are not ranked or budgeted.
  const ranked = advisory
    .flatMap((base) =>
      base.documents.map((doc) => ({
        base,
        doc,
        relevance: score(base, wanted) + (wanted.has(doc.file.replace(/\.md$/, "")) ? 1 : 0),
      })),
    )
    .sort((a, b) => {
      if (b.relevance !== a.relevance) return b.relevance - a.relevance;
      const updatedA = a.base.manifest.updated ?? a.doc.updated;
      const updatedB = b.base.manifest.updated ?? b.doc.updated;
      if (updatedA !== updatedB) return updatedA < updatedB ? 1 : -1;
      return a.doc.bytes - b.doc.bytes;
    });

  let spent = lines.join("\n").length;

  for (const entry of ranked) {
    const record = {
      baseId: entry.base.manifest.id,
      file: entry.doc.file,
      chars: entry.doc.bytes,
    };
    if (spent + entry.doc.bytes > context.budgetChars) {
      omitted.push(record);
      continue;
    }
    let body: string;
    try {
      body = await loader.readDocument(entry.base.manifest.id, entry.doc.file);
    } catch {
      omitted.push(record);
      continue;
    }
    const chunk = `${header(entry.base, entry.doc.file)}\n${body.trim()}\n`;
    lines.push(chunk);
    spent += chunk.length;
    included.push({ ...record, chars: chunk.length });
  }

  if (omitted.length > 0) {
    lines.push("Not injected, available on request:");
    for (const doc of omitted) {
      lines.push(`- ${doc.baseId}/${doc.file} — read_knowledge("${doc.baseId}", "${doc.file}")`);
    }
    lines.push("");
  }

  const text = lines.join("\n");
  return { text, included, omitted, chars: text.length };
}
