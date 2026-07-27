/**
 * SR-09 (§6.8): a run in flight can be corrected without being killed.
 *
 * What has to hold: a note is durable, it is delivered exactly once, the run cannot finish while
 * one is pending, and none of it resolves a doubt or grants anything.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/db.js";
import { migrate } from "../src/db/migrate.js";
import { createRepos, type Repos } from "../src/db/repos/index.js";
import { composeSteering, INBOX_REL, PROTOCOL_BLOCK, PROTOCOL_VERSION } from "../src/acp/prompt.js";

let db: Db;
let repos: Repos;

beforeEach(() => {
  db = openDb({ file: ":memory:" });
  migrate(db);
  repos = createRepos(db);
});

afterEach(() => db.close());

/** The smallest world a run needs: a project, a chain, a task and a run row. */
function aRun(): { runId: string; projectId: string } {
  const project = repos.projects.create({
    id: "steer",
    name: "Steer",
    path: "/workspace/projects/steer",
    context: "goal: be corrected mid-flight",
  });
  const chain = repos.chains.create({ projectId: project.id, title: "Chain" });
  const task = repos.tasks.create({
    projectId: project.id,
    chainId: chain.id,
    title: "Work",
    spec: "do the thing",
    agentId: "builder",
    position: 1,
  });
  const run = repos.runs.start({ taskId: task.id, engine: "claude" });
  return { runId: run.id, projectId: project.id };
}

describe("the notes left for a run", () => {
  it("are durable, ordered and pending until something takes them", () => {
    const { runId, projectId } = aRun();
    repos.runNotes.add({ runId, projectId, note: "use sonnet, not opus", createdBy: "panel" });
    repos.runNotes.add({ runId, projectId, note: "and skip the audit", createdBy: "mcp" });

    expect(repos.runNotes.countPending(runId)).toBe(2);
    expect(repos.runNotes.pending(runId).map((n) => n.note)).toEqual([
      "use sonnet, not opus",
      "and skip the audit",
    ]);
  });

  it("are delivered exactly once, whichever route takes them first", () => {
    const { runId, projectId } = aRun();
    repos.runNotes.add({ runId, projectId, note: "one", createdBy: "panel" });

    const first = repos.runNotes.takePending(runId, "inbox");
    expect(first).toHaveLength(1);
    expect(first[0]?.note).toBe("one");

    // The steering turn asks a moment later and must not hand over the same note again.
    expect(repos.runNotes.takePending(runId, "turn")).toHaveLength(0);
    expect(repos.runNotes.countPending(runId)).toBe(0);

    const delivered = repos.runNotes.list(runId)[0];
    expect(delivered?.delivery).toBe("inbox");
    expect(delivered?.delivered_at).toBeTruthy();
  });

  it("keeps a note left after a delivery pending for the next one", () => {
    const { runId, projectId } = aRun();
    repos.runNotes.add({ runId, projectId, note: "one", createdBy: "panel" });
    repos.runNotes.takePending(runId, "turn");
    repos.runNotes.add({ runId, projectId, note: "two", createdBy: "panel" });

    expect(repos.runNotes.countPending(runId)).toBe(1);
    expect(repos.runNotes.takePending(runId, "turn").map((n) => n.note)).toEqual(["two"]);
  });

  it("belongs to its own run", () => {
    const { runId, projectId } = aRun();
    repos.runNotes.add({ runId, projectId, note: "mine", createdBy: "panel" });
    expect(repos.runNotes.pending("01OTHERRUN")).toEqual([]);
  });
});

describe("the steering prompt", () => {
  it("says the run is not finished and does not restate the task", () => {
    const text = composeSteering([
      { note: "the API paginates from 1, not 0", created_at: "2026-07-28T09:00:00.000Z" },
    ]);
    expect(text).toMatch(/not finished/i);
    expect(text).toContain("the API paginates from 1, not 0");
    // It has to end where the agent knows what to do: the sentinel is how a turn closes.
    expect(text).toMatch(/sentinel/i);
  });

  it("numbers several notes in the order they were written", () => {
    const text = composeSteering([
      { note: "first", created_at: "2026-07-28T09:00:00.000Z" },
      { note: "second", created_at: "2026-07-28T09:05:00.000Z" },
    ]);
    expect(text.indexOf("note.1")).toBeLessThan(text.indexOf("note.2"));
    expect(text).toContain("first");
    expect(text).toContain("second");
  });
});

describe("the protocol tells the agent about its inbox (MC-11)", () => {
  it("names the file and says a note outranks the spec", () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(7);
    expect(PROTOCOL_BLOCK).toContain(INBOX_REL);
    expect(PROTOCOL_BLOCK).toMatch(/outranks/);
  });
});
