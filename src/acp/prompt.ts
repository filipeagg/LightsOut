/**
 * Prompt composition (PM-03, DESIGN §6.2).
 * Five blocks in order: agent instructions, the LightsOut protocol block, project context
 * from doc/, the task spec, and optional knowledge-base excerpts.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { SENTINEL_CLOSE, SENTINEL_OPEN } from "./result.js";

export const PROTOCOL_VERSION = 1;

/** Constant, versioned protocol block (DESIGN §6.2 block 2). */
export const PROTOCOL_BLOCK = `# LightsOut protocol v${PROTOCOL_VERSION}

You are running unattended inside LightsOut. No human is watching this turn.

Permissions are mediated by policy, not by a person. A denial is not a failure and not a
reason to retry the same action: adapt, or finish by raising a doubt that explains what you
needed. Never work outside the project directory.

End your final message with this block, and nothing after it:

${SENTINEL_OPEN}
{"status":"ok","summary":"one paragraph, plain language, what changed and why"}
${SENTINEL_CLOSE}

If the task cannot be finished because a decision is genuinely ambiguous and the answer
changes the result, end with:

${SENTINEL_OPEN}
{"status":"doubt","summary":"what you did and where you stopped",
 "doubt":{"context":"the ambiguity, in one paragraph","blocks":"what this blocks",
          "options":[{"id":"A","text":"…"},{"id":"B","text":"…"}],"recommendation":"A"}}
${SENTINEL_CLOSE}

Raise a doubt only for decisions a human must own. Do not use it for questions you can
answer by reading the repository.`;

export type DocContext = {
  state?: string;
  plan?: string;
  decisions?: string;
};

export type ComposeInput = {
  instructions: string;
  projectPath: string;
  taskTitle: string;
  taskSpec: string;
  verifyCmd?: string | null;
  /** Number of trailing DECISIONS.md entries to include (DESIGN §6.2, N=10). */
  decisionsLimit?: number;
  knowledgeBase?: string | undefined;
  /**
   * Decisions already settled for this task, prepended when a task is re-run after a doubt
   * was resolved (DESIGN §8.2, §8.4). Binding: the agent must not reopen them.
   */
  decisionContext?: string | undefined;
};

const MANAGED_BEGIN = "<!-- lightsout:begin -->";
const MANAGED_END = "<!-- lightsout:end -->";

/** The machine-owned block of STATE.md, or the whole file when the markers are absent. */
export function managedSection(content: string): string {
  const start = content.indexOf(MANAGED_BEGIN);
  const end = content.indexOf(MANAGED_END);
  if (start === -1 || end === -1 || end < start) return content.trim();
  return content.slice(start + MANAGED_BEGIN.length, end).trim();
}

/** Unchecked checkbox lines of PLAN.md: what is still open. */
export function openPlanItems(content: string, limit = 20): string {
  const lines = content
    .split("\n")
    .filter((line) => /^\s*[-*]\s*\[ \]/.test(line))
    .slice(0, limit);
  return lines.join("\n").trim();
}

/** Last N entries of an append-only doc, newest last. Entries start with '## '. */
export function lastEntries(content: string, limit: number): string {
  const parts = content.split(/^##\s+/m).filter((p) => p.trim());
  if (parts.length === 0) return content.trim();
  return parts
    .slice(-limit)
    .map((p) => `## ${p.trim()}`)
    .join("\n\n")
    .trim();
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

export async function readDocContext(projectPath: string): Promise<DocContext> {
  const docDir = path.join(projectPath, "doc");
  const [state, plan, decisions] = await Promise.all([
    readOptional(path.join(docDir, "STATE.md")),
    readOptional(path.join(docDir, "PLAN.md")),
    readOptional(path.join(docDir, "DECISIONS.md")),
  ]);
  const context: DocContext = {};
  if (state !== undefined) context.state = state;
  if (plan !== undefined) context.plan = plan;
  if (decisions !== undefined) context.decisions = decisions;
  return context;
}

export function composePrompt(input: ComposeInput, docs: DocContext): string {
  const blocks: string[] = [];

  if (input.instructions.trim()) blocks.push(input.instructions.trim());
  blocks.push(PROTOCOL_BLOCK);

  const contextParts: string[] = [];
  if (docs.state) {
    const section = managedSection(docs.state);
    if (section) contextParts.push(`## Project state\n\n${section}`);
  }
  if (docs.plan) {
    const open = openPlanItems(docs.plan);
    if (open) contextParts.push(`## Open plan items\n\n${open}`);
  }
  if (docs.decisions) {
    const recent = lastEntries(docs.decisions, input.decisionsLimit ?? 10);
    if (recent) contextParts.push(`## Recent decisions (binding)\n\n${recent}`);
  }
  if (contextParts.length > 0) {
    blocks.push(`# Project context\n\n${contextParts.join("\n\n")}`);
  }

  if (input.decisionContext?.trim()) blocks.push(input.decisionContext.trim());

  const taskParts = [`# Task: ${input.taskTitle}`, input.taskSpec.trim()];
  if (input.verifyCmd) {
    taskParts.push(
      `## Acceptance\n\nThis command must pass when you are done; it will be run for you:\n\n\`${input.verifyCmd}\``,
    );
  }
  taskParts.push(`Project directory: ${input.projectPath}`);
  blocks.push(taskParts.join("\n\n"));

  if (input.knowledgeBase?.trim()) {
    blocks.push(`# Knowledge base\n\n${input.knowledgeBase.trim()}`);
  }

  return blocks.join("\n\n---\n\n");
}
