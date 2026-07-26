/** PE-08: the scratch directory is emptied at run close and leftovers are reported, not deleted. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureScratch, scratchRoot, sweep, SCRATCH_PARENT_REL } from "../src/projects/hygiene.js";

let project: string;

beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), "lo-hygiene-"));
});

afterEach(() => rmSync(project, { recursive: true, force: true }));

describe("ensureScratch", () => {
  it("creates the directory and a .gitignore that hides all of it", async () => {
    const root = await ensureScratch(project);
    expect(existsSync(root)).toBe(true);
    const ignore = readFileSync(path.join(project, SCRATCH_PARENT_REL, ".gitignore"), "utf8");
    expect(ignore).toContain("*");
  });

  it("is idempotent and keeps what is already there", async () => {
    const root = await ensureScratch(project);
    writeFileSync(path.join(root, "keep.txt"), "x", "utf8");
    await ensureScratch(project);
    expect(existsSync(path.join(root, "keep.txt"))).toBe(true);
  });
});

describe("sweep", () => {
  it("empties the scratch directory and reports what it removed", async () => {
    const root = await ensureScratch(project);
    writeFileSync(path.join(root, "a.tmp"), "12345", "utf8");
    mkdirSync(path.join(root, "nested"));
    writeFileSync(path.join(root, "nested", "b.json"), "{}", "utf8");

    const result = await sweep(project);
    expect(result.files).toBe(2);
    expect(result.bytes).toBe(7);
    expect(result.error).toBeUndefined();
    expect(existsSync(root)).toBe(true);
    expect(existsSync(path.join(root, "a.tmp"))).toBe(false);
    // The .gitignore survives: the directory must stay ignored for the next run.
    expect(existsSync(path.join(project, SCRATCH_PARENT_REL, ".gitignore"))).toBe(true);
  });

  it("reports nothing and fails at nothing when the directory does not exist", async () => {
    const result = await sweep(project);
    expect(result).toMatchObject({ files: 0, bytes: 0, untracked: [] });
    expect(result.error).toBeUndefined();
  });

  it("never touches anything outside the scratch directory", async () => {
    await ensureScratch(project);
    mkdirSync(path.join(project, "src"), { recursive: true });
    writeFileSync(path.join(project, "src", "app.ts"), "export {};", "utf8");
    await sweep(project);
    expect(existsSync(path.join(project, "src", "app.ts"))).toBe(true);
  });

  it("resolves the scratch root inside the project it was given", () => {
    expect(scratchRoot(project)).toBe(path.join(project, ".lightsout", "tmp"));
  });
});
