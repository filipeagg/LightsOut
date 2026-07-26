/**
 * The permission judge (PE-11, DESIGN §6.5b).
 *
 * A gate that would wake a person is put to a cheap read-only agent first: can this command damage
 * the system, or the user's work? Neither — allow. Anything else, or any doubt at all about the
 * answer, and the human doubt opens exactly as before.
 *
 * Everything here fails toward the human: a timeout, a crash, an unparseable answer and an
 * unavailable engine are all "escalate".
 */
import path from "node:path";
import { z } from "zod";
import { askEngine } from "../acp/advisor.js";
import { argPaths, Classifier, pathsInCommand, splitSegments } from "../policy/classify.js";
import type { ActionClass } from "../policy/schema.js";

export const JUDGE_AGENT_ID = "permission-judge";
export const JUDGE_TIMEOUT_MS = 20_000;

/** The only classes the judge may settle (PE-11). Everything else goes straight to the human. */
export const JUDGEABLE: ReadonlySet<ActionClass> = new Set<ActionClass>(["other", "delete"]);

/**
 * What the judge may additionally settle when the project runs unattended (OR-12, §7.7). These
 * are the classes that are worth a person's attention *when there is a person*: they change the
 * build environment or leave the machine, and they are all recorded as provisional decisions and
 * revocable afterwards. Nothing on the hard floor of PE-03 is here.
 */
export const JUDGEABLE_UNATTENDED: ReadonlySet<ActionClass> = new Set<ActionClass>([
  "other",
  "delete",
  "deps_install",
  "toolchain_install",
  "network",
  "script_exec",
  "git_local",
  "project_write",
  "exec_check",
  "knowledge_write",
]);

export const judgeAnswerSchema = z
  .object({
    verdict: z.enum(["allow", "escalate"]),
    risk: z.enum(["none", "low", "high"]).default("low"),
    reason: z.string().default(""),
    concerns: z.array(z.string()).default([]),
  })
  .strip();

export type JudgeAnswer = z.infer<typeof judgeAnswerSchema>;

export type JudgeInput = {
  actionClass: ActionClass;
  /** The command as the engine asked for it; for an fs request, the tool's title. */
  title: string;
  /** Why the policy sent it to a human. */
  reason: string;
  projectPath: string;
  /** Directories this project may read outside itself (PE-09). */
  readAreas?: string[];
  /** Where this pack allows writes, when it confines them (§19). */
  writeScopes?: string[];
  adapterCommand: string;
  timeoutMs?: number;
  onStderr?: (line: string) => void;
};

export type JudgeResult =
  | { ok: true; answer: JudgeAnswer; durationMs: number }
  | { ok: false; error: string; durationMs: number };

/**
 * Is this class the judge's to decide? `delete` only when every path it names resolves inside the
 * project: `rm -rf build` is housekeeping, a deletion elsewhere is not the judge's call.
 */
export function judgeable(input: {
  actionClass: ActionClass;
  projectPath: string;
  command?: string | undefined;
  paths?: string[] | undefined;
  /**
   * The gate was `credentials`, but the whole of the evidence was this run's own vault entry
   * (PE-13, §7.1d). Judgeable whatever the mode: this is the false positive that has stopped four
   * runs, and the hard floor was never meant to catch the system's own key.
   */
  judgeEligible?: boolean | undefined;
  /** The project runs unattended (OR-12), which widens the remit to everything off the floor. */
  unattended?: boolean | undefined;
}): boolean {
  if (input.judgeEligible && input.actionClass === "credentials") return true;
  const remit = input.unattended ? JUDGEABLE_UNATTENDED : JUDGEABLE;
  if (!remit.has(input.actionClass)) return false;
  if (input.actionClass !== "delete") return true;

  // Both kinds of target: what the request declared, and what the command names. `rm -rf build`
  // carries no absolute path, so the arguments themselves are the targets.
  const command = input.command ?? "";
  const targets = [
    ...(input.paths ?? []),
    ...pathsInCommand(command),
    ...splitSegments(command).flatMap((segment) => argPaths(segment)),
  ];
  if (targets.length === 0) return false; // a deletion whose target we cannot see is a human's
  return targets.every((target) => Classifier.isInside(input.projectPath, target));
}

export function buildJudgePrompt(input: JudgeInput): string {
  const areas = input.readAreas?.length ? input.readAreas.join(", ") : "none";
  const scopes = input.writeScopes?.length ? input.writeScopes.join(", ") : "the whole project";
  return [
    "Decide whether this action is safe enough to allow without asking a person.",
    "",
    "## The action",
    `command_or_title: ${input.title}`,
    `classified_as: ${input.actionClass}`,
    `policy_said: ${input.reason}`,
    "",
    "## Where it runs",
    `project_directory: ${input.projectPath}`,
    `writable: ${scopes}`,
    `readable_outside_the_project: ${areas}`,
    "everything_else: denied by policy, whatever this action asks for",
    "",
    "## Answer",
    "One line of JSON, nothing else:",
    '{"verdict":"allow"|"escalate","risk":"none"|"low"|"high","reason":"<20 words>","concerns":[]}',
  ].join("\n");
}

/** Pull the JSON object out of a reply that may still carry prose or a fence. */
export function parseJudgeAnswer(text: string): JudgeAnswer | undefined {
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1]);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = judgeAnswerSchema.safeParse(JSON.parse(candidate.trim()));
      if (parsed.success) return parsed.data;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** How the caller asks: injectable so tests do not spawn an engine. */
export type AskFn = (prompt: string, timeoutMs: number) => Promise<string>;

export async function consultJudge(input: JudgeInput, ask?: AskFn): Promise<JudgeResult> {
  const startedAt = Date.now();
  const timeoutMs = input.timeoutMs ?? JUDGE_TIMEOUT_MS;
  const failed = (error: string): JudgeResult => ({
    ok: false,
    error,
    durationMs: Date.now() - startedAt,
  });
  const answered = (answer: JudgeAnswer): JudgeResult => ({
    ok: true,
    answer,
    durationMs: Date.now() - startedAt,
  });

  try {
    const prompt = buildJudgePrompt(input);
    const text = ask
      ? await ask(prompt, timeoutMs)
      : await askEngine({
          adapterCommand: input.adapterCommand,
          // The judge reads nothing, but a session needs a cwd; the project is the honest one.
          cwd: path.resolve(input.projectPath),
          prompt,
          timeoutMs,
          ...(input.onStderr ? { onStderr: input.onStderr } : {}),
        });
    const answer = parseJudgeAnswer(text);
    if (!answer) return failed(`unparseable answer: ${text.slice(0, 120)}`);
    return answered(answer);
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

/** The one place that decides what an answer means. Unsure, slow or risky all mean "ask". */
export function judgeAllows(result: JudgeResult): boolean {
  return result.ok && result.answer.verdict === "allow" && result.answer.risk !== "high";
}
