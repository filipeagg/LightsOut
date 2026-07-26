/** OB-05: a timeline a person can read, and the same lines over MCP. */
import { describe, expect, it } from "vitest";
import { describeEvent, narrate } from "../src/narrate.js";
import type { EventRow } from "../src/db/types.js";

let id = 0;
function event(type: string, payload: unknown, at = "2026-07-26T18:04:17.000Z"): EventRow {
  id += 1;
  return { id, run_id: "r1", ts: at, type, payload: JSON.stringify(payload) };
}

describe("one event, one sentence", () => {
  it("says what a tool call actually did", () => {
    expect(describeEvent("tool.call", { kind: "read", path: "/workspace/projects/x/src/api/views.py" })?.text).toBe(
      "reads src/api/views.py",
    );
    expect(
      describeEvent("tool.call", { kind: "execute", title: "Terminal", detail: "find . -name '*.py' | wc -l" })?.text,
    ).toBe("runs: find . -name '*.py' | wc -l");
    expect(describeEvent("tool.call", { kind: "edit", path: "doc/ANALYSIS.md" })?.text).toBe(
      "writes doc/ANALYSIS.md",
    );
    // The old shape, with nothing but "Terminal", still says something honest.
    expect(describeEvent("tool.call", { kind: "execute", title: "Terminal" })?.text).toBe(
      "runs a command",
    );
  });

  it("says what the agent is working out", () => {
    expect(
      describeEvent("agent.thought", { textExcerpt: "which base classes govern every endpoint" })?.text,
    ).toBe("thinking: which base classes govern every endpoint");
  });

  it("says what happened to the run, in words", () => {
    expect(describeEvent("run.state", { status: "running" })?.text).toBe("started working");
    expect(
      describeEvent("run.state", { status: "interrupted", reason: "container restart" })?.text,
    ).toBe("run interrupted: container restart");
    expect(describeEvent("verify.result", { exitCode: 3 })).toMatchObject({ tone: "problem" });
    expect(describeEvent("judge.verdict", { allowed: true, reason: "read-only count" })?.text).toBe(
      "judge: allowed — read-only count",
    );
  });

  it("stays quiet about events that say nothing to a person", () => {
    expect(describeEvent("deliverable.lint", { ok: true })).toBeUndefined();
    expect(describeEvent("usage_update", {})).toBeUndefined();
  });
});

describe("the last ten lines", () => {
  it("folds a run of the same verb into one line", () => {
    const events = [
      event("run.state", { status: "running" }),
      ...Array.from({ length: 8 }, (_, i) =>
        event("tool.call", { kind: "read", path: `src/file${i}.py` }),
      ),
      event("tool.call", { kind: "execute", detail: "npm test" }),
    ];
    const lines = narrate(events, 10);
    expect(lines).toHaveLength(3);
    expect(lines[0]?.text).toBe("started working");
    expect(lines[1]?.count).toBe(8);
    expect(lines[1]?.text).toMatch(/reads src\/file0\.py \(\+7 more\)/);
    expect(lines[2]?.text).toBe("runs: npm test");
  });

  it("keeps the last ones, oldest first", () => {
    const events = Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0
        ? event("tool.call", { kind: "read", path: `a${i}.py` })
        : event("tool.call", { kind: "execute", detail: `cmd-${i}` }),
    );
    const lines = narrate(events, 5);
    expect(lines).toHaveLength(5);
    expect(lines[4]?.text).toBe("runs: cmd-39");
    expect(new Date(lines[0]!.at).getTime()).toBeLessThanOrEqual(new Date(lines[4]!.at).getTime());
  });

  it("survives a payload that is not what it expected", () => {
    const broken: EventRow = { id: 99, run_id: "r1", ts: "2026-07-26T18:00:00Z", type: "tool.call", payload: "not json" };
    expect(() => narrate([broken], 5)).not.toThrow();
  });
});
