/** Phase 3 gate: result sentinel, prompt composition and agent profile loading. */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseResult, SENTINEL_CLOSE, SENTINEL_OPEN } from "../src/acp/result.js";
import {
  composePrompt,
  lastEntries,
  managedSection,
  openPlanItems,
  PROTOCOL_BLOCK,
  readDocContext,
} from "../src/acp/prompt.js";
import { AgentsLoader } from "../src/agents/loader.js";
import { scrubEnv } from "../src/acp/adapter.js";

const sentinel = (body: unknown) => `${SENTINEL_OPEN}\n${JSON.stringify(body)}\n${SENTINEL_CLOSE}`;

describe("result sentinel", () => {
  it("parses an ok result", () => {
    const parsed = parseResult(`Done.\n\n${sentinel({ status: "ok", summary: "wired the repo" })}`);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.result.status).toBe("ok");
      expect(parsed.result.summary).toBe("wired the repo");
    }
  });

  it("parses a doubt result with options", () => {
    const parsed = parseResult(
      sentinel({
        status: "doubt",
        summary: "stopped before choosing",
        doubt: {
          context: "two sync strategies",
          blocks: "task 3",
          options: [
            { id: "A", text: "incremental" },
            { id: "B", text: "full" },
          ],
          recommendation: "A",
        },
      }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.result.doubt?.options).toHaveLength(2);
  });

  it("uses the last sentinel when the agent echoes the format earlier", () => {
    const text = [
      `I will end with ${SENTINEL_OPEN} {"status":"ok"} ${SENTINEL_CLOSE} as instructed.`,
      sentinel({ status: "ok", summary: "real one" }),
    ].join("\n\n");
    const parsed = parseResult(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.result.summary).toBe("real one");
  });

  it("falls back to an excerpt when the sentinel is missing or invalid", () => {
    const missing = parseResult("I finished the task and everything passes.");
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error).toContain("no LIGHTSOUT_RESULT");
      expect(missing.fallbackSummary).toContain("finished the task");
    }

    const broken = parseResult(`text\n${SENTINEL_OPEN}\n{not json}\n${SENTINEL_CLOSE}`);
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error).toContain("not valid JSON");

    const invalid = parseResult(sentinel({ status: "doubt", summary: "no payload" }));
    expect(invalid.ok).toBe(false);

    const unknownStatus = parseResult(sentinel({ status: "exploded", summary: "x" }));
    expect(unknownStatus.ok).toBe(false);
  });

  it("borrows the summary from the message when the sentinel omits it", () => {
    const parsed = parseResult(`Refactored the loader.\n${sentinel({ status: "ok" })}`);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.result.summary).toContain("Refactored the loader");
  });
});

describe("prompt composition", () => {
  it("extracts the managed section, open plan items and recent decisions", () => {
    const state = `Free text\n<!-- lightsout:begin -->\nPhase: chain 2/6\n<!-- lightsout:end -->\nmore`;
    expect(managedSection(state)).toBe("Phase: chain 2/6");
    expect(managedSection("no markers here")).toBe("no markers here");

    const plan = "- [x] done thing\n- [ ] open thing\n- [ ] another\ntext";
    expect(openPlanItems(plan)).toBe("- [ ] open thing\n- [ ] another");

    const decisions = ["## D-1 one", "## D-2 two", "## D-3 three"].join("\n\n");
    expect(lastEntries(decisions, 2)).toBe("## D-2 two\n\n## D-3 three");
  });

  it("orders the blocks and includes the protocol and verify command", () => {
    const prompt = composePrompt(
      {
        instructions: "AGENT RULES",
        projectPath: "/workspace/projects/demo",
        taskTitle: "Add endpoint",
        taskSpec: "SPEC BODY",
        verifyCmd: "npm test",
      },
      {
        state: "<!-- lightsout:begin -->\nPhase: 1/3\n<!-- lightsout:end -->",
        plan: "- [ ] open item",
        decisions: "## D-1 keep it simple",
      },
    );

    expect(prompt.indexOf("AGENT RULES")).toBeLessThan(prompt.indexOf(PROTOCOL_BLOCK));
    expect(prompt.indexOf(PROTOCOL_BLOCK)).toBeLessThan(prompt.indexOf("Project context"));
    expect(prompt.indexOf("Project context")).toBeLessThan(prompt.indexOf("Task: Add endpoint"));
    expect(prompt).toContain("Phase: 1/3");
    expect(prompt).toContain("- [ ] open item");
    expect(prompt).toContain("keep it simple");
    expect(prompt).toContain("`npm test`");
    expect(prompt).toContain("/workspace/projects/demo");
  });

  it("skips context blocks that do not exist", () => {
    const prompt = composePrompt(
      { instructions: "", projectPath: "/p", taskTitle: "T", taskSpec: "S" },
      {},
    );
    expect(prompt).not.toContain("Project context");
    expect(prompt).toContain(PROTOCOL_BLOCK);
  });

  it("reads doc context from disk, tolerating missing files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lo-docs-"));
    try {
      await mkdir(path.join(dir, "doc"), { recursive: true });
      await writeFile(path.join(dir, "doc", "STATE.md"), "state body", "utf8");
      const docs = await readDocContext(dir);
      expect(docs.state).toBe("state body");
      expect(docs.plan).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("adapter environment", () => {
  it("passes through only what the engine needs (NF-02)", () => {
    const env = scrubEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/app",
        CLAUDE_CONFIG_DIR: "/home/app/.claude",
        GIT_TOKEN: "secret",
        ANTHROPIC_API_KEY: "secret",
        LO_DB: "/data/lightsout.db",
      },
      { CODEX_HOME: "/home/app/.codex" },
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/app",
      CLAUDE_CONFIG_DIR: "/home/app/.claude",
      CODEX_HOME: "/home/app/.codex",
    });
  });
});

describe("agents loader", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "lo-ws-"));
    await mkdir(path.join(workspace, "agents", "policies"), { recursive: true });
    await mkdir(path.join(workspace, "agents", "fragments"), { recursive: true });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  const writeAgent = (name: string, body: string) =>
    writeFile(path.join(workspace, "agents", name), body, "utf8");

  it("loads profiles and packs, defaulting the id to the file name", async () => {
    await writeAgent("builder.yaml", "name: Builder\nengine: claude\nmodel: sonnet\n");
    await writeFile(
      path.join(workspace, "agents", "policies", "default.yaml"),
      "rules:\n  - { class: project_write, verdict: allow }\n",
      "utf8",
    );

    const loader = new AgentsLoader(workspace);
    const report = await loader.load();
    // 10 builtin profiles and 7 builtin packs, with builder and default shadowed (§2).
    expect(report).toMatchObject({ loaded: 13, packs: 9, fromWorkspace: 1, rejected: [] });
    expect(loader.profileOrThrow("builder").engine).toBe("claude");
    expect(loader.profile("builder")?.policy).toBe("default");
    expect(loader.pack("default")?.rules[0]?.verdict).toBe("allow");
  });

  it("rejects invalid files with a reason and keeps the good ones (AP-02)", async () => {
    await writeAgent("good.yaml", "name: Good\nengine: codex\n");
    await writeAgent("bad-engine.yaml", "name: Bad\nengine: gemini\n");
    await writeAgent("bad-extra.yaml", "name: Bad\nengine: claude\nunknown: 1\n");
    await writeAgent("empty.yaml", "");

    const loader = new AgentsLoader(workspace);
    const report = await loader.load();
    expect(report.loaded).toBe(14); // 13 builtin + good.yaml
    expect(report.rejected.map((r) => r.file).sort()).toEqual([
      "bad-engine.yaml",
      "bad-extra.yaml",
      "empty.yaml",
    ]);
    expect(loader.profile("bad-engine")).toBeUndefined();
  });

  it("composes instructions from fragments (AP-04) and rejects missing ones", async () => {
    await writeFile(
      path.join(workspace, "agents", "fragments", "house.md"),
      "HOUSE RULES",
      "utf8",
    );
    await writeAgent(
      "builder.yaml",
      "name: Builder\nengine: claude\ninclude: [house]\ninstructions: OWN RULES\n",
    );
    await writeAgent("broken.yaml", "name: Broken\nengine: claude\ninclude: [nope]\n");

    const loader = new AgentsLoader(workspace);
    const report = await loader.load();
    expect(report.rejected.map((r) => r.file)).toEqual(["broken.yaml"]);
    expect(report.loaded).toBe(13); // builder shadowed, broken rejected
    expect(loader.instructionsFor(loader.profileOrThrow("builder"))).toBe(
      "HOUSE RULES\n\nOWN RULES",
    );
  });

  it("serves the builtin library when the workspace has no profiles (BA-01)", async () => {
    const loader = new AgentsLoader(workspace);
    const report = await loader.load();
    expect(report.loaded).toBe(13);
    expect(report.fromWorkspace).toBe(0);
    expect(report.packs).toBe(9);
    expect(report.rejected).toEqual([]);
    for (const id of ["prompt-architect", "planner", "builder", "answerer"]) {
      expect(loader.profile(id)).toBeDefined();
    }
    for (const id of ["default", "read-only", "no-write", "probe", "test", "curate", "advisor"]) {
      expect(loader.pack(id)).toBeDefined();
    }
    // Nothing is copied into the workspace: the library is read where it ships (DESIGN §2).
    expect((await readdir(path.join(workspace, "agents"))).sort()).toEqual([
      "fragments",
      "policies",
    ]);
  });

  it("lets a workspace file shadow a builtin of the same id (AP-01, §2)", async () => {
    await writeAgent("builder.yaml", "name: Mine\nengine: codex\ninstructions: LOCAL\n");
    const loader = new AgentsLoader(workspace);
    const report = await loader.load();
    expect(report.loaded).toBe(13);
    expect(report.fromWorkspace).toBe(1);
    const builder = loader.profileOrThrow("builder");
    expect(builder.name).toBe("Mine");
    expect(builder.engine).toBe("codex");
  });

  it("names the available profiles when one is missing", async () => {
    await writeAgent("builder.yaml", "name: Builder\nengine: claude\n");
    const loader = new AgentsLoader(workspace);
    await loader.load();
    expect(() => loader.profileOrThrow("ghost")).toThrow(/unknown agent profile: ghost/);
    expect(() => loader.profileOrThrow("ghost")).toThrow(/builder/);
  });
});
