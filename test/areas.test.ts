/**
 * PE-09: read-only workspace areas, and the classification that makes them useful.
 *
 * The scenario is the real one: a project told where the code is
 * (`/workspace/sources/efemis_django-master`), denied every way of reading it, writing reports
 * about being blocked.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, type Db } from "../src/db/db.js";
import { migrate } from "../src/db/migrate.js";
import { createRepos, type Repos } from "../src/db/repos/index.js";
import { validateArea } from "../src/projects/areas.js";
import { Classifier, writeTargets } from "../src/policy/classify.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { policyPackSchema } from "../src/policy/schema.js";

let db: Db;
let repos: Repos;
let workspace: string;
let project: string;

beforeEach(async () => {
  db = openDb({ file: ":memory:" });
  migrate(db);
  repos = createRepos(db);
  workspace = await mkdtemp(path.join(tmpdir(), "lo-areas-"));
  project = path.join(workspace, "projects", "curation");
  await mkdir(path.join(project, "doc"), { recursive: true });
  await mkdir(path.join(workspace, "sources", "efemis_django-master"), { recursive: true });
  await mkdir(path.join(workspace, "projects", "other"), { recursive: true });
  await mkdir(path.join(workspace, "knowledge", "efemis"), { recursive: true });
  await mkdir(path.join(workspace, "agents"), { recursive: true });
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("what may be declared an area", () => {
  it("accepts a directory of the workspace, relative or absolute", () => {
    expect(validateArea(workspace, project, "sources/efemis_django-master").relative).toBe(
      "sources/efemis_django-master",
    );
    expect(
      validateArea(workspace, project, path.join(workspace, "sources")).relative,
    ).toBe("sources");
    // Trailing separators and backslashes are the same directory.
    expect(validateArea(workspace, project, "sources\\efemis_django-master\\").relative).toBe(
      "sources/efemis_django-master",
    );
  });

  it("refuses what would widen the boundary too far, each with its reason", () => {
    expect(() => validateArea(workspace, project, "/")).toThrow(/inside the workspace/);
    expect(() => validateArea(workspace, project, ".")).toThrow(/whole workspace/);
    expect(() => validateArea(workspace, project, "agents")).toThrow(/system that runs it/);
    expect(() => validateArea(workspace, project, "templates")).toThrow(/system that runs it/);
    expect(() => validateArea(workspace, project, "vault.yaml")).toThrow(/credentials vault/);
    expect(() => validateArea(workspace, project, "knowledge/efemis")).toThrow(/knowledge base/);
    expect(() => validateArea(workspace, project, "projects/other")).toThrow(/another project/);
    expect(() => validateArea(workspace, project, "projects/curation")).toThrow(/already readable/);
    expect(() => validateArea(workspace, project, "sources/nope")).toThrow(/no such file/);
    expect(() => validateArea(workspace, project, "../outside")).toThrow(/inside the workspace/);
  });

  it("accepts a single file, because the material is sometimes one archive", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(workspace, "sources", "efemis.zip"), "zip", "utf8");
    expect(validateArea(workspace, project, "sources/efemis.zip").relative).toBe(
      "sources/efemis.zip",
    );
  });

  it("is stored once per project and path", () => {
    repos.projects.create({ id: "curation", name: "Curation", path: project, context: "goal: x" });
    repos.areas.add({ projectId: "curation", path: "sources/efemis_django-master", addedBy: "mcp" });
    repos.areas.add({ projectId: "curation", path: "sources/efemis_django-master", addedBy: "mcp" });
    expect(repos.areas.list("curation")).toHaveLength(1);
    expect(repos.areas.remove("curation", "sources/efemis_django-master")?.path).toBe(
      "sources/efemis_django-master",
    );
    expect(repos.areas.list("curation")).toHaveLength(0);
  });
});

describe("classification with an area (the case that failed)", () => {
  const area = () => [path.join(workspace, "sources", "efemis_django-master")];
  const classifier = new Classifier();
  const classify = (command: string, readAreas = area()) =>
    classifier.classify({ projectPath: project, workspacePath: workspace, readAreas, command });

  it("turns the denied listing into a read", () => {
    const target = path.join(workspace, "sources", "efemis_django-master");
    expect(classify(`ls -la ${target}/`).class).toBe("project_read");
    expect(classify(`cat ${target}/manage.py`).class).toBe("project_read");
  });

  it("allows copying out of the area into the project", () => {
    const target = path.join(workspace, "sources", "efemis_django-master");
    const decision = classify(`cp -r ${target} ./sources/efemis_django-master`);
    expect(decision.class).toBe("project_read");
  });

  it("never allows writing into the area", () => {
    const target = path.join(workspace, "sources", "efemis_django-master");
    expect(classify(`cp -r ./doc ${target}/doc`).class).toBe("outside_workspace");
    expect(classify(`rm -rf ${target}`).class).toBe("outside_workspace");
    expect(
      classifier.classify({
        projectPath: project,
        workspacePath: workspace,
        readAreas: area(),
        kind: "edit",
        paths: [`${target}/settings.py`],
      }).class,
    ).toBe("outside_workspace");
  });

  it("changes nothing outside the declared directory", () => {
    expect(classify(`ls -la ${workspace}/`).class).toBe("outside_workspace");
    expect(classify(`cat ${workspace}/vault.yaml`).class).toBe("credentials");
    expect(classify(`ls ${workspace}/projects/other`).class).toBe("outside_workspace");
    // And with no area declared at all, the old behaviour stands.
    expect(classify(`ls -la ${workspace}/sources/efemis_django-master`, []).class).toBe(
      "outside_workspace",
    );
  });

  it("the hard floor still denies a write to an area, whatever the pack says", () => {
    const pack = policyPackSchema.parse({
      id: "reckless",
      rules: [
        { class: "outside_workspace", verdict: "allow" },
        { class: "project_read", verdict: "allow" },
      ],
    });
    const engine = new PolicyEngine({ default: pack });
    const target = path.join(workspace, "sources", "efemis_django-master");
    const decision = engine.evaluate({
      projectPath: project,
      workspacePath: workspace,
      readAreas: area(),
      command: `cp ./doc/x.md ${target}/x.md`,
    });
    expect(decision.class).toBe("outside_workspace");
    expect(decision.verdict).toBe("deny");
    expect(decision.floored).toBe(true);
  });
});

describe("write targets", () => {
  it("tells the destination of a copy from its sources", () => {
    expect(writeTargets("cp -r /workspace/sources/x ./sources/x")).toEqual(["./sources/x"]);
    expect(writeTargets("ls -la /workspace/sources/")).toEqual([]);
    expect(writeTargets("cat a.md > b.md")).toEqual(["b.md"]);
    expect(writeTargets("mv old.md new.md")).toEqual(["new.md"]);
  });
});
