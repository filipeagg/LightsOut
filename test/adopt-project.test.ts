/**
 * PM-12/PM-13 (§9.7): the same project on a second machine.
 *
 * The failure this guards against is the tempting one: a colleague clones the repository, runs
 * `create_project` with the same name because that is the tool he knows, and gets a scaffold
 * written on top of somebody's working tree. Adoption is the other verb, and what makes it safe
 * is not that it is called something else — it is that it reads.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, type Db } from "../src/db/db.js";
import { migrate } from "../src/db/migrate.js";
import { createRepos, type Repos } from "../src/db/repos/index.js";
import { adoptProject } from "../src/projects/adopt.js";
import { buildDeclaration, renderDeclaration } from "../src/projects/declaration.js";
import { readProjectConfig } from "../src/projects/config.js";

let db: Db;
let repos: Repos;
let workspace: string;

beforeEach(async () => {
  db = openDb({ file: ":memory:" });
  migrate(db);
  repos = createRepos(db);
  workspace = await mkdtemp(path.join(tmpdir(), "lo-adopt-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

const DECLARATION = `# LightsOut project declaration (PM-13).
name: Consultant Portal
verify: "npm test"
push: manual
remote: git@example.com:acme/consultant-portal.git
context: |
  goal: a portal for consultants
  done_when: the gate is green
template: full-development
phases:
  - id: analysis
    title: Read the system until you understand it
    agent: analyst
    instructions: read it
    deliverable: doc/ANALYSIS.md
    gate: auto
    optional: false
    repeatable: false
  - id: build
    title: Build it
    agent: builder
    instructions: build it
    gate: human
    optional: false
    repeatable: true
areas:
  - path: sources/acme-export
    access: read
    note: the customer's export
requires:
  knowledge: [ acme-core ]
  vault: [ jira ]
policy:
  rules: [ { class: deps_install, verdict: allow } ]
`;

/** A cloned project as it arrives: the declaration, some code, and nothing of ours. */
async function plantProject(id = "consultant-portal", declaration = DECLARATION): Promise<string> {
  const dir = path.join(workspace, "projects", id);
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "lightsout.yaml"), declaration, "utf8");
  await writeFile(path.join(dir, "src", "index.html"), "<p>theirs</p>", "utf8");
  return dir;
}

describe("adopting a project that already exists (PM-12)", () => {
  it("builds the project out of the declaration alone", async () => {
    await plantProject();

    const result = await adoptProject(repos, workspace, { id: "consultant-portal" });

    expect(result.adopted).toBe(true);
    expect(result.project.name).toBe("Consultant Portal");
    expect(result.project.context).toContain("a portal for consultants");
    expect(result.project.template_id).toBe("full-development");
    expect(result.project.verify_cmd).toBe("npm test");
    expect(result.project.repo_remote).toBe("git@example.com:acme/consultant-portal.git");
    expect(result.phases).toBe(2);

    const phases = repos.phases.list(result.project.id);
    expect(phases.map((phase) => phase.phase_id)).toEqual(["analysis", "build"]);
    expect(phases[1]!.gate).toBe("human");
    expect(phases[1]!.repeatable).toBe(1);
    // The history of the machine that ran them does not travel: every phase starts pending.
    expect(phases.every((phase) => phase.status === "pending")).toBe(true);
    // One chain, so the adopted phases have somewhere to run (§16.2).
    expect(repos.chains.activeForProject(result.project.id)).toBeDefined();
  });

  it("writes no content into the directory it adopted", async () => {
    const dir = await plantProject();
    const before = await readFile(path.join(dir, "lightsout.yaml"), "utf8");

    await adoptProject(repos, workspace, { id: "consultant-portal" });

    expect(await readFile(path.join(dir, "lightsout.yaml"), "utf8")).toBe(before);
    expect(await readFile(path.join(dir, "src", "index.html"), "utf8")).toBe("<p>theirs</p>");
    // The one exception, and it is git-ignored scratch the runner needs (PE-08).
    expect(await readFile(path.join(dir, ".lightsout", ".gitignore"), "utf8")).toContain("*");
  });

  it("says what this machine is missing instead of failing later", async () => {
    await plantProject();

    const result = await adoptProject(repos, workspace, { id: "consultant-portal" });

    expect(result.missing.knowledge).toEqual(["acme-core"]);
    expect(result.missing.agents.sort()).toEqual(["analyst", "builder"]);
    expect(result.missing.vault).toEqual(["jira"]);
    // The area's directory is not on this machine, so it could not be declared (PE-09).
    expect(result.missing.areas).toEqual(["sources/acme-export"]);
    expect(repos.areas.list(result.project.id)).toHaveLength(0);
  });

  it("declares the area when the directory is actually there", async () => {
    await plantProject();
    await mkdir(path.join(workspace, "sources", "acme-export"), { recursive: true });

    const result = await adoptProject(repos, workspace, { id: "consultant-portal" });

    expect(result.missing.areas).toEqual([]);
    const areas = repos.areas.list(result.project.id);
    expect(areas).toHaveLength(1);
    expect(areas[0]!.path).toBe("sources/acme-export");
    expect(areas[0]!.access).toBe("read");
  });

  it("is idempotent: adopting twice is somebody making sure", async () => {
    await plantProject();

    const first = await adoptProject(repos, workspace, { id: "consultant-portal" });
    const second = await adoptProject(repos, workspace, { id: "consultant-portal" });

    expect(first.adopted).toBe(true);
    expect(second.adopted).toBe(false);
    expect(second.phases).toBe(2);
    expect(repos.phases.list("consultant-portal")).toHaveLength(2);
  });

  it("refuses a directory that is not a project, and names the tool that makes one", async () => {
    const dir = path.join(workspace, "projects", "bare");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "README.md"), "just files", "utf8");

    await expect(adoptProject(repos, workspace, { id: "bare" })).rejects.toThrow(
      /create_project/,
    );
    expect(repos.projects.list()).toHaveLength(0);
  });

  it("refuses an empty directory rather than scaffolding one", async () => {
    await expect(adoptProject(repos, workspace, { id: "nothing" })).rejects.toThrow(
      /no project at projects\/nothing/,
    );
  });

  it("refuses a declaration without a brief (PM-09)", async () => {
    await plantProject("no-brief", "name: No brief\nverify: \"\"\npush: manual\nremote: \"\"\n");

    await expect(adoptProject(repos, workspace, { id: "no-brief" })).rejects.toThrow(/PM-09/);
    expect(repos.projects.list()).toHaveLength(0);
  });
});

describe("the declaration is a merge, not a regeneration (PM-13)", () => {
  it("keeps what the system does not own", async () => {
    const existing = { policy: { rules: [{ class: "deps_install", verdict: "allow" }] } };
    const rendered = renderDeclaration(
      buildDeclaration({
        project: {
          id: "p",
          name: "P",
          path: "/workspace/projects/p",
          context: "goal: something",
          repo_remote: null,
          push_policy: "manual",
          policy_pack: "default",
          verify_cmd: null,
          template_id: null,
          template_reason: null,
          unattended: 1,
          archived: 0,
          created_at: "2026-09-06T00:00:00Z",
        },
        phases: [],
        areas: [],
        knowledge: [],
        vault: ["jira"],
      }),
      existing,
    );

    expect(rendered).toContain("deps_install");
    expect(rendered).toContain("jira");
    expect(rendered).toContain("goal: something");
  });

  it("round-trips through the schema the orchestrator already reads", async () => {
    const dir = await plantProject();
    const { config, pack } = await readProjectConfig(dir);

    expect(config.phases).toHaveLength(2);
    expect(config.requires.vault).toEqual(["jira"]);
    expect(config.areas[0]!.access).toBe("read");
    // The inline override pack still parses, which is the half of the file that predates PM-13.
    expect(pack?.rules[0]!.class).toBe("deps_install");
  });
});

/**
 * §9.7.2b: the import that used to leave nothing behind.
 *
 * No directory and no remote, but the bundle carries `lightsout.yaml` verbatim — so the project
 * exists, says what it still needs, and refuses a launch until its clone arrives. Before this it
 * returned `ok: true` with a note in a field nobody reads, and the panel showed nothing at all.
 */
describe("a project declared before its working copy arrives (§9.7.2b)", () => {
  it("builds the project from the declaration and names the directory that is missing", async () => {
    const result = await adoptProject(repos, workspace, {
      id: "consultant-portal",
      declaration: DECLARATION,
    });

    expect(result.adopted).toBe(true);
    expect(result.project.name).toBe("Consultant Portal");
    expect(result.project.template_id).toBe("full-development");
    expect(result.phases).toBe(2);
    expect(result.missing.workdir).toBe(path.join(workspace, "projects", "consultant-portal"));
  });

  it("reports what it requires, which is the reason the stand-in is kept at all", async () => {
    const result = await adoptProject(repos, workspace, {
      id: "consultant-portal",
      declaration: DECLARATION,
    });

    // Read from `projects.declaration`: there is no file to read it from, and reporting an empty
    // list here would say "nothing left to do" at the moment everything is left to do.
    expect(result.missing.vault).toEqual(["jira"]);
    expect(result.missing.knowledge).toEqual(["acme-core"]);
  });

  it("writes nothing into the directory it is waiting for", async () => {
    await adoptProject(repos, workspace, { id: "consultant-portal", declaration: DECLARATION });

    // `git clone` refuses a target that is not empty, so a scratch folder created here would be
    // the thing that makes the clone impossible.
    await expect(stat(path.join(workspace, "projects", "consultant-portal"))).rejects.toThrow();
  });

  it("lets the file take over once the clone lands", async () => {
    await adoptProject(repos, workspace, { id: "consultant-portal", declaration: DECLARATION });
    await plantProject();

    // Idempotent, and now reading the real thing: the stand-in stops being consulted.
    const again = await adoptProject(repos, workspace, { id: "consultant-portal" });
    expect(again.adopted).toBe(false);
    expect(again.missing.workdir).toBeNull();
  });

  it("still refuses when there is no declaration either", async () => {
    await expect(adoptProject(repos, workspace, { id: "nothing-here" })).rejects.toThrow(
      /no project at/,
    );
  });
});
