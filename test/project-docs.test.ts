/**
 * PM-09 (the context brief) and PM-10 (reading the project's documents).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, type Db } from "../src/db/db.js";
import { migrate } from "../src/db/migrate.js";
import { createRepos, type Repos } from "../src/db/repos/index.js";
import { createProject } from "../src/projects/scaffold.js";
import {
  hostPathFor,
  listProjectDocs,
  readProjectDoc,
  resolveDocPath,
} from "../src/projects/docs-index.js";
import { composePrompt } from "../src/acp/prompt.js";

let db: Db;
let repos: Repos;
let workspace: string;

beforeEach(async () => {
  db = openDb({ file: ":memory:" });
  migrate(db);
  repos = createRepos(db);
  workspace = await mkdtemp(path.join(tmpdir(), "lo-docs-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

const BRIEF = "goal: keep the pilot honest\nactors: one operator\ndone_when: the gate is green";

describe("the context brief (PM-09)", () => {
  it("is required whatever the template, and the refusal says what to write", async () => {
    await expect(
      createProject(repos, workspace, { name: "No brief", context: "  " }),
    ).rejects.toThrow(/context brief/);
    // Nothing was left behind by the refusal.
    expect(repos.projects.list()).toHaveLength(0);
  });

  it("is stored with the project and can be corrected", () => {
    // The row directly: `createProject` also runs git, which the test image does not carry.
    const project = repos.projects.create({
      id: "brief",
      name: "Brief",
      path: path.join(workspace, "projects", "brief"),
      context: BRIEF,
    });
    expect(project.context).toBe(BRIEF);
    const updated = repos.projects.update(project.id, { context: "goal: something else" });
    expect(updated.context).toBe("goal: something else");
  });

  it("reaches the prompt as fixed context, separate from the task", () => {
    const prompt = composePrompt(
      {
        instructions: "you are a builder",
        projectPath: "/workspace/projects/x",
        taskTitle: "do the thing",
        taskSpec: "the spec",
        projectContext: BRIEF,
      },
      {},
    );
    expect(prompt).toContain("What this project is for");
    expect(prompt).toContain("goal: keep the pilot honest");
    expect(prompt.indexOf("What this project is for")).toBeLessThan(
      prompt.indexOf("# Task: do the thing"),
    );
  });

  // Migration 4's backfill over a real legacy database is covered in test/phases-db.test.ts,
  // which is where the migration fixtures live.
});

describe("listing and reading the documents (PM-10)", () => {
  /**
   * A project directory by hand: `createProject` runs `git init`, and the test image has no git.
   * What is under test here is the walk and the confinement, not the scaffolding.
   */
  async function seed(): Promise<string> {
    const root = path.join(workspace, "projects", "docs-project");
    repos.projects.create({ id: "docs-project", name: "Docs", path: root, context: BRIEF });
    await mkdir(path.join(root, "doc"), { recursive: true });
    for (const doc of ["STATE", "PLAN", "DECISIONS", "QUESTIONS"]) {
      await writeFile(path.join(root, "doc", `${doc}.md`), `# ${doc}\n`, "utf8");
    }
    await mkdir(path.join(root, "sources", "deep"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(
      path.join(root, "doc", "ANALYSIS.md"),
      ["meta.doc: ANALYSIS", "meta.updated: 2026-07-26", "f.1.claim: a fact", "f.1.source: code:x"].join(
        "\n",
      ),
      "utf8",
    );
    await writeFile(path.join(root, "README.md"), "# readme\n\nsome prose\n", "utf8");
    await writeFile(path.join(root, "sources", "deep", "IGNORED.md"), "# ignored\n", "utf8");
    await writeFile(path.join(root, "node_modules", "pkg", "SKIP.md"), "# skip\n", "utf8");
    await writeFile(path.join(root, "doc", "notes.txt"), "not markdown\n", "utf8");
    return root;
  }

  it("finds every .md and skips what is not ours", async () => {
    const root = await seed();
    const docs = await listProjectDocs(root);
    const paths = docs.map((d) => d.path);
    expect(paths).toContain("doc/ANALYSIS.md");
    expect(paths).toContain("README.md");
    // The scaffold's own managed docs are there and marked as managed.
    expect(paths).toContain("doc/STATE.md");
    expect(docs.find((d) => d.path === "doc/STATE.md")?.managed).toBe(true);
    expect(docs.find((d) => d.path === "README.md")?.managed).toBe(false);
    // Skipped directories and other formats never appear.
    expect(paths.some((p) => p.startsWith("sources/"))).toBe(false);
    expect(paths.some((p) => p.startsWith("node_modules/"))).toBe(false);
    expect(paths.some((p) => p.endsWith(".txt"))).toBe(false);
  });

  it("carries the format verdict so drift is visible in the list", async () => {
    const root = await seed();
    const docs = await listProjectDocs(root);
    expect(docs.find((d) => d.path === "doc/ANALYSIS.md")?.lint.ok).toBe(true);
  });

  it("reads one document by its relative path", async () => {
    const root = await seed();
    const doc = await readProjectDoc(root, "doc/ANALYSIS.md");
    expect(doc.content).toContain("f.1.claim: a fact");
    expect(doc.truncated).toBe(false);
    expect(doc.path).toBe("doc/ANALYSIS.md");
  });

  it("refuses anything that is not a document of this project", async () => {
    const root = await seed();
    expect(() => resolveDocPath(root, "../other/x.md")).toThrow(/escapes/);
    expect(() => resolveDocPath(root, "/etc/passwd")).toThrow(/relative/);
    expect(() => resolveDocPath(root, "C:\\Windows\\x.md")).toThrow(/relative/);
    expect(() => resolveDocPath(root, "doc/notes.txt")).toThrow(/Markdown/);
    expect(() => resolveDocPath(root, "sources/deep/IGNORED.md")).toThrow(/not served/);
    expect(() => resolveDocPath(root, "  ")).toThrow(/give a path/);
  });

  it("reports where the file is on the user's own machine, or nothing at all", () => {
    const container = "/workspace";
    const host = "C:\\Users\\me\\Documents\\LightsOut";
    expect(hostPathFor(container, host, "/workspace/projects/x/doc/ANALYSIS.md")).toBe(
      "C:\\Users\\me\\Documents\\LightsOut\\projects\\x\\doc\\ANALYSIS.md",
    );
    // A Windows mount written with forward slashes still answers in backslashes: the point of
    // this path is that a person can paste it into their editor.
    expect(hostPathFor(container, "C:/Users/me/LightsOut", "/workspace/projects/x/doc/A.md")).toBe(
      "C:\\Users\\me\\LightsOut\\projects\\x\\doc\\A.md",
    );
    expect(hostPathFor(container, "/home/me/LightsOut", "/workspace/projects/x")).toBe(
      "/home/me/LightsOut/projects/x",
    );
    // Not configured, or outside the workspace: null rather than a guess.
    expect(hostPathFor(container, "", "/workspace/projects/x")).toBeNull();
    expect(hostPathFor(container, host, "/etc/passwd")).toBeNull();
  });
});
