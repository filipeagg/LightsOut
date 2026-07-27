/**
 * Prompt composition (PM-03, DESIGN §6.2).
 * Five blocks in order: agent instructions, the LightsOut protocol block, project context
 * from doc/, the task spec, and optional knowledge-base excerpts.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { SENTINEL_CLOSE, SENTINEL_OPEN } from "./result.js";
import { SCRATCH_REL } from "../policy/classify.js";
import { HUMAN_MARKER } from "../projects/deliverable.js";

/**
 * 7: the inbox — the user can correct this run without killing it (SR-09, §6.8).
 * 6: there is no browser in this container, and none can be installed (MC-11). A qa run spent
 * three permission gates hunting for chromium and playwright before working that out.
 * 5: where files go, how credentials are used, and how to publish something (PM-11, MC-11).
 * 4: where to install a library, and what never to try (ST-03b). 3: machine-first documents
 * (BA-07). 2: the tooling licence and the scratch directory (PE-07, PE-08).
 */
export const PROTOCOL_VERSION = 7;

/** Where a note left for this run lands, project-relative (SR-09, §6.8). */
export const INBOX_REL = ".lightsout/inbox.md";

/** Constant, versioned protocol block (DESIGN §6.2 block 2). */
export const PROTOCOL_BLOCK = `# LightsOut protocol v${PROTOCOL_VERSION}

You are running unattended inside LightsOut. No human is watching this turn.

Permissions are mediated by policy, not by a person. A denial is not a failure and not a
reason to retry the same action: adapt, or finish by raising a doubt that explains what you
needed. Never work outside the project directory.

## Your inbox

The person who launched this run can correct it while it runs. Their notes land in
\`${INBOX_REL}\`. Read that file before each significant step — before you start building, before
you commit, before you write your report. It usually does not exist, and that costs you nothing.

A note there outranks the task spec on the point it makes, and nothing else changes. Say in your
report which notes you acted on. You will be handed anything you missed before this run is allowed
to finish, so ignoring the file only makes the correction arrive later.

## Where things go

Put what you make in the right place. This is fixed by the system, not a preference, and the
project brief is the only thing that overrides it:

- \`src/\` — the code you write. **A single-page deliverable is \`src/index.html\`.**
- \`doc/\` — documents this system reads back. Never code.
- \`probes/\` — throwaway scripts that prove something about an external system.
- \`sources/\` — material imported from elsewhere, such as an unpacked archive.
- \`output/\` — generated artefacts that are not code: a spreadsheet, an export, a report.
- \`${SCRATCH_REL}\` — scratch, emptied when this run ends.

A deliverable nobody can find has not been delivered: code in \`doc/\` is invisible to the
preview, and a page called anything other than \`index.html\` cannot be served without someone
being told its name.

## Using a credential

Credentials reach you as environment variables, listed for you when this project has any. Three
rules, and they are the whole of it:

- Read the variable **at the point of use** — in the request, in the client, in the header.
- Never print one, never log one, never write one to a file, and never put one in a URL.
- Never search the project for a secret to check whether it leaked. A value you never wrote to
  disk needs no such check, and the search itself is what stops the run.

Redact anything that could carry a secret before recording it: write \`<redacted>\` in a sample
response, a saved payload or a document. You do not need to prove you handled a credential
safely — you need to handle it safely.

## Showing your work

To let a person look at what you built, call \`preview_start\`. It publishes a URL on their
machine and keeps serving after this run ends. Do not start a server in your own terminal —
\`npm run dev\`, \`vite\`, \`python -m http.server\` never return, so they hold this run open until
the watchdog kills it, and the policy refuses them for exactly that reason.

**There is no browser in this container**, and none can be installed: no chromium, no firefox,
no playwright, no puppeteer. Do not go looking for one. A front end is checked here by parsing
what you wrote — \`node --check\` over the extracted script, a DOM library if you installed one —
and by calling the API the page calls, with the same requests in the same order. Say plainly in
your report that the rendered page was not opened, and leave that to the person who can.

You may build and run your own tooling without asking: write a helper script and run it with
python3, node or bash. Two conditions, both checked, not trusted: the script must live inside
the project, and its code is read before it runs — anything that reaches the network, touches
credentials, installs dependencies or deletes files is judged as if you had typed that command
yourself. Put temporary files in \`${SCRATCH_REL}\`; it is emptied when this run ends, and it is
the one place you may write regardless of any other restriction on where you can write.
Anything you leave elsewhere is committed and reported.

If you need a Python library, install it into the scratch space and import it — no permission
needed, and it is already on your PYTHONPATH:

  pip install --target ${SCRATCH_REL}/deps <package>

Never run \`ensurepip\`, \`python -m venv\` over the system interpreter, or anything else that
writes outside the project: that is denied by a rule no permission can lift, and the toolchain you
need is already installed.

Every Markdown file this system writes and reads back — your deliverable, doc/STATE.md,
doc/PLAN.md, doc/DECISIONS.md, doc/QUESTIONS.md, doc/OPEN-QUESTIONS.md, knowledge documents — is
written for the machine that reads it next, not for a reader:

- Every line is \`key: value\`, a table row, a heading or a fenced block. No paragraphs, ever.
- Keys are English snake_case, dotted for structure. Ids are stable (\`f.1\`, \`G-3\`) so another
  document can point at them instead of repeating them. Values may be in the project's language.
- One fact per line. Every claim carries \`source:\` — \`code:<path>:<line>\`, \`schema:<object>\`,
  \`doc:<path>#<id>\`, \`knowledge:<base>/<doc>\`, \`human:<doubt ref>\` — and \`confidence:\` when it
  is not derived from one.
- The document is the current state, not a log. Supersede in place. No "pass 4", no "as
  established above", no reproducing what the previous version said; \`meta.passes: 4\` is all the
  history anyone needs.
- Three or more items of the same shape become a table. No emphasis for tone, no summary of what
  the document just said, no closing paragraph.
- Do not restate the task, these instructions or another document. Reference them.

There is no size limit, and that is not a licence to pad: a line that carries no fact does not go
in. If a human asks you for prose, put \`${HUMAN_MARKER}\` on the first line and write normally.

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
  /**
   * The project's context brief (PM-09): what the project is for, fixed across every run. It is
   * not the task and not the request of this launch — those are separate blocks — and it is what
   * stops an agent inferring its purpose from a phase title.
   */
  projectContext?: string | undefined;
  /**
   * Workspace directories this project may read outside its own (PE-09). Listed in the prompt
   * because an area the agent does not know about is an area it will not use — which is exactly
   * how a phase spent six passes reporting that it could not reach the code.
   */
  readAreas?: string[] | undefined;
  /** The curated knowledge block built by src/knowledge/inject.ts (KB-04). */
  knowledgeBase?: string | undefined;
  /** The vault index: labels, URLs and variable names, never a value (VT-02). */
  vaultIndex?: string | undefined;
  /**
   * Decisions already settled for this task, prepended when a task is re-run after a doubt
   * was resolved (DESIGN §8.2, §8.4). Binding: the agent must not reopen them.
   */
  decisionContext?: string | undefined;
  /**
   * Present when the deliverable that already exists fails the machine-first check (BA-08,
   * DESIGN §20.4). It comes before the task on purpose: an agent that adds to a bloated document
   * makes it worse, however good the addition is.
   */
  formatFeedback?: string | undefined;
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

/**
 * The prompt of a steering turn (SR-09, §6.8): what the person said, handed to an agent that has
 * just finished a turn and is about to be allowed to stop.
 *
 * Deliberately short and without ceremony. The agent still has everything it read; repeating the
 * task here would invite it to start again, which is the opposite of the point.
 */
export function composeSteering(notes: { note: string; created_at: string }[]): string {
  const lines = notes.map((n, i) => `note.${i + 1} (${n.created_at.slice(0, 19)}Z): ${n.note.trim()}`);
  return [
    "# Correction from the person who launched this run",
    "",
    "You are not finished. This arrived while you were working, and it outranks the task spec on",
    "the point it makes. Nothing else about the task changes.",
    "",
    ...lines,
    "",
    "Act on it now, then finish as usual with the sentinel block, saying in your summary what you",
    "changed because of this.",
  ].join("\n");
}

export function composePrompt(input: ComposeInput, docs: DocContext): string {
  const blocks: string[] = [];

  if (input.instructions.trim()) blocks.push(input.instructions.trim());
  blocks.push(PROTOCOL_BLOCK);

  const contextParts: string[] = [];
  if (input.projectContext?.trim()) {
    contextParts.push(
      `## What this project is for (fixed context, PM-09)\n\n${input.projectContext.trim()}`,
    );
  }
  if (input.readAreas?.length) {
    contextParts.push(
      [
        "## Readable outside this project (PE-09)",
        "",
        "These directories of the workspace are yours to read, and to copy from into this",
        "project. You may not write into them.",
        "",
        ...input.readAreas.map((area, i) => `area.${i + 1}: ${area}`),
      ].join("\n"),
    );
  }
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
  if (input.formatFeedback?.trim()) blocks.push(input.formatFeedback.trim());

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

  if (input.vaultIndex?.trim()) {
    blocks.push(`# Credentials\n\n${input.vaultIndex.trim()}`);
  }

  return blocks.join("\n\n---\n\n");
}
