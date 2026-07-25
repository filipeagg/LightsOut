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
  return `--- knowledge: ${base.manifest.id} (${base.manifest.kind}) — ${file} ---`;
}

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
  const lines: string[] = [
    "The following knowledge bases are attached to this project. Each document is labelled",
    "with the base it came from and what kind of fact it holds: a technical constraint and an",
    "organisational preference are not the same thing and must not be treated as one.",
    "",
  ];

  for (const base of bases) {
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

  // Ranking across every attached base at once: relevance, then recency, then smallest first.
  const ranked = bases
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

  const included: InjectedDocument[] = [];
  const omitted: InjectedDocument[] = [];
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
