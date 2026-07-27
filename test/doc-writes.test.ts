/**
 * MC-12..14 (§9.2b): writing a document without destroying it.
 *
 * The incident these tests stand for: `write_doc` on DECISIONS.md, meant as an addition, taken as
 * a replacement, eight recorded decisions gone with no commit to recover them from. Each test here
 * is one of the four things that had to be true for that to happen.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HISTORY_KEEP,
  docHistoryDir,
  hashContent,
  knowledgeHistoryDir,
  snapshotFile,
} from "../src/projects/doc-history.js";
import { applyEdits } from "../src/projects/doc-patch.js";
import { APPEND_ONLY_DOCS } from "../src/control/actions.js";

let project: string;

beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), "lo-docs-"));
  mkdirSync(path.join(project, "doc"), { recursive: true });
});

afterEach(() => rmSync(project, { recursive: true, force: true }));

const docFile = (name: string): string => path.join(project, "doc", `${name}.md`);

describe("the snapshot before an overwrite (MC-12)", () => {
  it("keeps the previous bytes where they can be found", async () => {
    writeFileSync(docFile("STATE"), "before\n", "utf8");
    const saved = await snapshotFile(docFile("STATE"), docHistoryDir(project), "STATE");

    expect(saved).not.toBeNull();
    expect(readFileSync(saved as string, "utf8")).toBe("before\n");
    // Inside `.lightsout/`, which ignores itself in git and is not what the PE-08 sweep empties.
    expect(path.relative(project, saved as string).startsWith(".lightsout")).toBe(true);
  });

  it("saves nothing when there was nothing to lose", async () => {
    expect(await snapshotFile(docFile("STATE"), docHistoryDir(project), "STATE")).toBeNull();
  });

  it("keeps the last ten and no more", async () => {
    for (let i = 0; i < HISTORY_KEEP + 4; i += 1) {
      writeFileSync(docFile("STATE"), `version ${i}\n`, "utf8");
      await snapshotFile(docFile("STATE"), docHistoryDir(project), "STATE");
    }
    const kept = readdirSync(docHistoryDir(project)).filter((f) => f.startsWith("STATE-"));
    expect(kept.length).toBe(HISTORY_KEEP);
    // The ones kept are the newest: the oldest content is what went.
    const contents = kept.map((f) => readFileSync(path.join(docHistoryDir(project), f), "utf8"));
    expect(contents).toContain(`version ${HISTORY_KEEP + 3}\n`);
    expect(contents).not.toContain("version 0\n");
  });

  it("does not put a knowledge base's history inside the user's own folder (KB-08)", () => {
    const dir = knowledgeHistoryDir("/workspace", "legacy-core");
    expect(dir.startsWith(path.join("/workspace", ".lightsout"))).toBe(true);
    expect(dir).not.toContain(path.join("knowledge", "legacy-core"));
  });
});

describe("the append-only documents (MC-13)", () => {
  it("names the two the system also writes from the database (§8.3)", () => {
    expect([...APPEND_ONLY_DOCS].sort()).toEqual(["DECISIONS", "QUESTIONS"]);
  });
});

describe("exact-string edits (MC-13)", () => {
  const doc = "a: one\nb: two\nc: three\n";

  it("replaces the one occurrence it was told about", () => {
    const { content, applied } = applyEdits(doc, [{ find: "b: two", replace: "b: TWO" }]);
    expect(content).toBe("a: one\nb: TWO\nc: three\n");
    expect(applied).toBe(1);
  });

  it("applies several edits in order", () => {
    const { content, applied } = applyEdits(doc, [
      { find: "a: one", replace: "a: 1" },
      { find: "c: three", replace: "c: 3" },
    ]);
    expect(content).toBe("a: 1\nb: two\nc: 3\n");
    expect(applied).toBe(2);
  });

  it("refuses a find that matches nothing, and says to read the file again", () => {
    expect(() => applyEdits(doc, [{ find: "d: four", replace: "x" }])).toThrow(/no occurrence/);
  });

  it("refuses an ambiguous find rather than picking one", () => {
    const repeated = "x: 1\nx: 1\n";
    expect(() => applyEdits(repeated, [{ find: "x: 1", replace: "x: 2" }])).toThrow(
      /found 2 occurrences/,
    );
  });

  it("accepts the ambiguity when the caller says how many it means", () => {
    const repeated = "x: 1\nx: 1\n";
    const { content, applied } = applyEdits(repeated, [
      { find: "x: 1", replace: "x: 2", expectCount: 2 },
    ]);
    expect(content).toBe("x: 2\nx: 2\n");
    expect(applied).toBe(2);
  });

  it("changes nothing at all when a later edit fails", () => {
    // All or nothing: a half-applied patch is a document nobody wrote.
    expect(() =>
      applyEdits(doc, [
        { find: "a: one", replace: "a: 1" },
        { find: "nowhere", replace: "x" },
      ]),
    ).toThrow();
    // The caller still holds the original string; nothing was written to disk by this module.
    expect(doc).toBe("a: one\nb: two\nc: three\n");
  });

  it("refuses an empty edit list and an empty find", () => {
    expect(() => applyEdits(doc, [])).toThrow(/no edits/);
    expect(() => applyEdits(doc, [{ find: "", replace: "x" }])).toThrow(/find is empty/);
  });
});

describe("the version a write is based on (MC-14)", () => {
  it("is stable for the same content and different for one changed byte", () => {
    expect(hashContent("a\n")).toBe(hashContent("a\n"));
    expect(hashContent("a\n")).not.toBe(hashContent("a \n"));
  });
});
