/**
 * The manual, served over MCP (MC-09, DESIGN §10.0).
 *
 * The client of this server is a model with no memory of this repository: it can call the tools
 * and has no way to learn what a phase is or why a template is not an agent. The sections live in
 * `builtin/guide/*.md`, shipped in the image, machine-first like everything else the system writes.
 * They are read from disk on demand and cached, so editing one and restarting is enough.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The order they are listed in: the order someone learning the system needs them. */
export const TOPIC_ORDER = [
  "overview",
  "launching",
  "agents",
  "templates",
  "phases",
  "triggers",
  "knowledge",
  "areas",
  "previews",
  "vault",
  "doubts",
  "policies",
  "documents",
  "troubleshooting",
];

const here = path.dirname(fileURLToPath(import.meta.url));

/** `builtin/guide` next to the compiled code, or in the repository when running from source. */
function guideDir(): string {
  const candidates = [
    path.resolve(here, "..", "..", "builtin", "guide"),
    path.resolve(here, "..", "..", "..", "builtin", "guide"),
  ];
  for (const dir of candidates) {
    try {
      readdirSync(dir);
      return dir;
    } catch {
      continue;
    }
  }
  return candidates[0]!;
}

const cache = new Map<string, string>();

export function availableTopics(): string[] {
  let files: string[] = [];
  try {
    files = readdirSync(guideDir()).filter((file) => file.endsWith(".md"));
  } catch {
    return [];
  }
  const found = files.map((file) => file.replace(/\.md$/, ""));
  // Known topics first, in learning order; anything added later follows, alphabetically.
  const known = TOPIC_ORDER.filter((topic) => found.includes(topic));
  const extra = found.filter((topic) => !TOPIC_ORDER.includes(topic)).sort();
  return [...known, ...extra];
}

/** The first line of a section after its heading: what it is about, for the topic list. */
function summarise(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("meta.topic:"));
  const rest = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("what:") || l.startsWith("definition:") || l.startsWith("meta.rule:"));
  return rest ?? line ?? "";
}

export function readTopic(topic: string): string {
  const clean = topic.trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(clean)) throw new Error(`unknown topic: ${topic}`);
  const cached = cache.get(clean);
  if (cached) return cached;
  let text: string;
  try {
    text = readFileSync(path.join(guideDir(), `${clean}.md`), "utf8");
  } catch {
    throw new Error(
      `unknown topic: ${topic}. Available: ${availableTopics().join(", ") || "(none installed)"}`,
    );
  }
  cache.set(clean, text);
  return text;
}

export type GuideAnswer =
  | { topics: { topic: string; about: string }[]; hint: string }
  | { topic: string; content: string };

export function guide(topic?: string): GuideAnswer {
  if (!topic?.trim()) {
    return {
      topics: availableTopics().map((name) => ({
        topic: name,
        about: summarise(readTopic(name)),
      })),
      hint: "guide{topic:'overview'} first if you have not driven this system before.",
    };
  }
  return { topic: topic.trim().toLowerCase(), content: readTopic(topic) };
}
