/**
 * TP-09/TP-10 (§16.4): choosing a template is a decision, not a default.
 *
 * The failure behind these: templates were optional, so the cheapest path was to skip them, and
 * clients skipped them every time. Phases, gates, deliverables and frozen instructions went
 * unused. What is tested here is the shape that makes the choice unavoidable, not the paragraph
 * that asks for it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, type Db } from "../src/db/db.js";
import { migrate } from "../src/db/migrate.js";
import { createRepos, type Repos } from "../src/db/repos/index.js";
import { createProject, NO_TEMPLATE } from "../src/projects/scaffold.js";
import { projectTemplateSchema } from "../src/templates/schema.js";
import { SERVER_INSTRUCTIONS } from "../src/mcp/server.js";

let db: Db;
let repos: Repos;
let workspace: string;

beforeEach(async () => {
  db = openDb({ file: ":memory:" });
  migrate(db);
  repos = createRepos(db);
  workspace = await mkdtemp(path.join(tmpdir(), "lo-template-choice-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

const BRIEF = "goal: prove the point\nactors: one operator\ndone_when: the gate is green";

const MINIMAL = {
  id: "sample",
  name: "Sample",
  phases: [{ id: "one", title: "One", agent: "builder", instructions: "do it" }],
};

describe("the selection criteria travel with the template (TP-10)", () => {
  it("parses when_to_use and not_for", () => {
    const parsed = projectTemplateSchema.parse({
      ...MINIMAL,
      when_to_use: "the result has to survive",
      not_for: "throwaway demos",
    });
    expect(parsed.when_to_use).toBe("the result has to survive");
    expect(parsed.not_for).toBe("throwaway demos");
  });

  it("defaults them to empty, so templates written before this stay valid", () => {
    const parsed = projectTemplateSchema.parse(MINIMAL);
    expect(parsed.when_to_use).toBe("");
    expect(parsed.not_for).toBe("");
  });
});

describe('"none" is an answer that carries its reason (TP-09)', () => {
  it("refuses no-template without one, and leaves nothing behind", async () => {
    await expect(
      createProject(repos, workspace, {
        name: "Unplanned",
        context: BRIEF,
        template: NO_TEMPLATE,
      }),
    ).rejects.toThrow(/templateReason/);
    expect(repos.projects.list()).toHaveLength(0);
  });

  it("stores the reason on the project when one is given", () => {
    // The row directly: `createProject` also runs git, which this image does not carry.
    const project = repos.projects.create({
      id: "unplanned",
      name: "Unplanned",
      path: path.join(workspace, "projects", "unplanned"),
      context: BRIEF,
      templateReason: "one-off migration of a single file; no phase list fits",
    });
    expect(project.template_id).toBeNull();
    expect(project.template_reason).toMatch(/one-off migration/);
  });

  it("leaves rows that predate the question alone", () => {
    const project = repos.projects.create({
      id: "older",
      name: "Older",
      path: path.join(workspace, "projects", "older"),
      context: BRIEF,
    });
    // NULL, not an invented reason: the migration does not put words in anyone's mouth.
    expect(project.template_reason).toBeNull();
  });
});

describe("the client is told before it guesses", () => {
  it("names list_templates in the instructions that are always in context", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/list_templates/);
    expect(SERVER_INSTRUCTIONS).toMatch(/none/);
  });
});
