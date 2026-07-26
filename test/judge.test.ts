/**
 * PE-11: the permission judge. The engine is stubbed — what is under test is the remit, the
 * reading of an answer, and that every failure falls toward the human.
 */
import { describe, expect, it } from "vitest";
import {
  buildJudgePrompt,
  consultJudge,
  judgeAllows,
  judgeable,
  parseJudgeAnswer,
  JUDGEABLE,
  type JudgeInput,
} from "../src/orchestrator/judge.js";

const PROJECT = "/workspace/projects/demo";

const base: JudgeInput = {
  actionClass: "other",
  title: "weirdtool --count /workspace/projects/demo/src",
  reason: "unmatched command",
  projectPath: PROJECT,
  adapterCommand: "claude-agent-acp",
};

const answering = (text: string) => async () => text;

describe("what the judge may decide (PE-11)", () => {
  it("takes unrecognised commands", () => {
    expect(JUDGEABLE.has("other")).toBe(true);
    expect(judgeable({ actionClass: "other", projectPath: PROJECT, command: base.title })).toBe(
      true,
    );
  });

  it("takes a deletion only when every target is inside the project", () => {
    expect(
      judgeable({ actionClass: "delete", projectPath: PROJECT, command: "rm -rf build" }),
    ).toBe(true);
    expect(
      judgeable({
        actionClass: "delete",
        projectPath: PROJECT,
        command: "rm -rf /workspace/knowledge/efemis",
      }),
    ).toBe(false);
    // A deletion whose target cannot be seen is a human's call, not a guess.
    expect(judgeable({ actionClass: "delete", projectPath: PROJECT, command: "rm -rf" })).toBe(
      false,
    );
  });

  it("never touches the classes that are not its business", () => {
    for (const actionClass of [
      "credentials",
      "publish_external",
      "outside_workspace",
      "deps_install",
      "network",
      "git_push",
    ] as const) {
      expect(
        judgeable({ actionClass, projectPath: PROJECT, command: "anything at all" }),
        `${actionClass} must never reach the judge`,
      ).toBe(false);
    }
  });
});

describe("the question it is asked", () => {
  it("carries the action, the class, the reason and the boundaries", () => {
    const prompt = buildJudgePrompt({
      ...base,
      readAreas: ["sources/thing"],
      writeScopes: ["doc"],
    });
    expect(prompt).toContain("weirdtool --count");
    expect(prompt).toContain("classified_as: other");
    expect(prompt).toContain("policy_said: unmatched command");
    expect(prompt).toContain("writable: doc");
    expect(prompt).toContain("readable_outside_the_project: sources/thing");
    expect(prompt).toContain('"verdict"');
  });
});

describe("reading the answer", () => {
  it("accepts JSON, fenced JSON, and JSON with prose around it", () => {
    expect(parseJudgeAnswer('{"verdict":"allow","risk":"none","reason":"counts lines"}')).toMatchObject(
      { verdict: "allow", risk: "none" },
    );
    expect(
      parseJudgeAnswer('```json\n{"verdict":"escalate","risk":"high","reason":"deletes source"}\n```'),
    ).toMatchObject({ verdict: "escalate" });
    expect(
      parseJudgeAnswer('Sure. {"verdict":"allow","risk":"low","reason":"read only"} Hope that helps.'),
    ).toMatchObject({ verdict: "allow", risk: "low" });
    expect(parseJudgeAnswer("I think it is probably fine")).toBeUndefined();
  });
});

describe("the verdict, and where it fails", () => {
  it("allows a safe unknown command", async () => {
    const result = await consultJudge(
      base,
      answering('{"verdict":"allow","risk":"none","reason":"reads and counts, changes nothing"}'),
    );
    expect(judgeAllows(result)).toBe(true);
  });

  it("escalates anything it calls risky, even when it says allow", async () => {
    expect(
      judgeAllows(
        await consultJudge(base, answering('{"verdict":"escalate","risk":"low","reason":"unsure"}')),
      ),
    ).toBe(false);
    // A contradictory answer — allow with high risk — is not an allow.
    expect(
      judgeAllows(
        await consultJudge(
          base,
          answering('{"verdict":"allow","risk":"high","reason":"deletes the source tree"}'),
        ),
      ),
    ).toBe(false);
  });

  it("falls toward the human on anything that goes wrong", async () => {
    expect(judgeAllows(await consultJudge(base, answering("no idea, sorry")))).toBe(false);
    expect(judgeAllows(await consultJudge(base, answering("")))).toBe(false);
    const crashed = await consultJudge(base, async () => {
      throw new Error("engine not authenticated");
    });
    expect(crashed.ok).toBe(false);
    expect(judgeAllows(crashed)).toBe(false);
    if (!crashed.ok) expect(crashed.error).toMatch(/not authenticated/);
  });

  it("reports how long it took, so a slow judge is visible", async () => {
    const result = await consultJudge(base, answering('{"verdict":"allow","risk":"none"}'));
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
