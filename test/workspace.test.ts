/**
 * Workspace layout (RT-02, DESIGN §11.1 step 4) and loader polling (AP-03).
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureWorkspaceLayout, WORKSPACE_DIRS } from "../src/workspace/layout.js";
import { writeFileDurable } from "../src/workspace/durable.js";
import { AgentsLoader } from "../src/agents/loader.js";

async function tempWorkspace(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "lo-ws-"));
}

const PROBE_AGENT = `name: Poll probe
engine: claude
instructions: Do the thing.
`;

describe("durable writes", () => {
  it("replaces a file atomically and leaves no temporary behind", async () => {
    const root = await tempWorkspace();
    const file = path.join(root, "knowledge.yaml");

    await writeFileDurable(file, "id: first\n");
    expect(await readFile(file, "utf8")).toBe("id: first\n");

    await writeFileDurable(file, "id: second\n");
    expect(await readFile(file, "utf8")).toBe("id: second\n");

    // A leftover temporary would be picked up by the loaders as a stray file in the base.
    const entries = await readdir(root);
    expect(entries).toEqual(["knowledge.yaml"]);
  });

  it("fails without destroying what was already there", async () => {
    const root = await tempWorkspace();
    const file = path.join(root, "sub", "missing", "knowledge.yaml");
    // The directory does not exist: the write must fail rather than half-create anything.
    await expect(writeFileDurable(file, "id: x\n")).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });
});

describe("workspace layout", () => {
  it("creates every directory the loaders read from", async () => {
    const root = await tempWorkspace();
    const report = await ensureWorkspaceLayout(root);
    expect(report.root).toBe(root);
    for (const dir of WORKSPACE_DIRS) {
      const info = await stat(path.join(root, dir));
      expect(info.isDirectory()).toBe(true);
    }
  });

  it("git-ignores the vault and is idempotent", async () => {
    const root = await tempWorkspace();
    const first = await ensureWorkspaceLayout(root);
    expect(first.gitignoreUpdated).toBe(true);
    expect(await readFile(path.join(root, ".gitignore"), "utf8")).toContain("vault.yaml");

    const second = await ensureWorkspaceLayout(root);
    expect(second.gitignoreUpdated).toBe(false);
    expect(second.created).toEqual([]);
  });

  it("keeps entries a user already had in the workspace .gitignore", async () => {
    const root = await tempWorkspace();
    await writeFile(path.join(root, ".gitignore"), "scratch/\n", "utf8");
    await ensureWorkspaceLayout(root);
    const content = await readFile(path.join(root, ".gitignore"), "utf8");
    expect(content).toContain("scratch/");
    expect(content).toContain("vault.yaml");
  });
});

describe("agents loader polling", () => {
  it("reloads only when the tree changed", async () => {
    const root = await tempWorkspace();
    await ensureWorkspaceLayout(root);
    let reloads = 0;
    const loader = new AgentsLoader(root, () => {
      reloads += 1;
    });
    await loader.load();

    expect(await loader.pollOnce()).toBe(false);
    expect(reloads).toBe(0);

    await writeFile(path.join(root, "agents", "poll-probe.yaml"), PROBE_AGENT, "utf8");
    expect(await loader.pollOnce()).toBe(true);
    expect(reloads).toBe(1);
    expect(loader.profile("poll-probe")).toBeDefined();

    expect(await loader.pollOnce()).toBe(false);
    expect(reloads).toBe(1);
  });
});
