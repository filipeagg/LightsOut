/**
 * PE-10: the classifier's blind spots, and learning from a gate a human answered.
 *
 * The scenario is the real one: a chain stopped for eleven minutes on
 * `R=…; find $R/a $R/b -maxdepth 1 -name '*.py' | xargs wc -l` — counting lines.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/db.js";
import { migrate } from "../src/db/migrate.js";
import { createRepos, type Repos } from "../src/db/repos/index.js";
import { Classifier, commandShape, isAssignmentOnly } from "../src/policy/classify.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { policyPackSchema } from "../src/policy/schema.js";

const PROJECT = "/workspace/projects/demo";
const BLOCKED =
  "R=/workspace/projects/demo/src/m; find $R/throttling $R/user -maxdepth 1 -name '*.py' | xargs wc -l";

let db: Db;
let repos: Repos;

beforeEach(() => {
  db = openDb({ file: ":memory:" });
  migrate(db);
  repos = createRepos(db);
});

describe("the blind spots that stopped the chain", () => {
  const classifier = new Classifier();
  const classify = (command: string) => classifier.classify({ projectPath: PROJECT, command }).class;

  it("reads a pipeline through xargs", () => {
    expect(classify("find . -name '*.py' | xargs wc -l")).toBe("project_read");
    expect(classify("xargs wc -l")).toBe("project_read");
    expect(classify("time xargs -0 wc -l")).toBe("project_read");
  });

  it("does not let a bare assignment drag a pipeline into a gate", () => {
    expect(isAssignmentOnly("R=/tmp/x")).toBe(true);
    expect(isAssignmentOnly("rm -rf /tmp/x")).toBe(false);
    expect(classify("R=/tmp/x")).toBe("project_read");
    expect(classify(BLOCKED)).toBe("project_read");
  });

  it("still classifies a wrapped dangerous command by what it wraps", () => {
    expect(classify("xargs rm -rf build")).toBe("delete");
    expect(classify("find . -name '*.tmp' | xargs rm")).toBe("delete");
    expect(classify("time curl https://example.com")).toBe("network");
    expect(classify("env cat .env")).toBe("credentials");
    expect(classify("timeout 30 npm install lodash")).toBe("deps_install");
  });

  it("reads the rest of an ordinary pipeline", () => {
    expect(classify("grep -rn TODO src | sort | uniq -c | head -20")).toBe("project_read");
    expect(classify("cat a.txt | tr a-z A-Z | wc -c")).toBe("project_read");
  });
});

describe("command shapes", () => {
  it("keeps the programs and drops the particulars", () => {
    // `xargs` is peeled by the same normalisation the classifier uses, so the shape says what
    // actually runs: find, then wc.
    expect(commandShape(BLOCKED)).toBe("find <path> <path> -maxdepth <n> -name <str> | wc -l");
    // Which is why a pipeline into `rm` is a different shape, and stays a different question.
    expect(commandShape("find /a -name '*.tmp' | xargs rm")).toBe(
      "find <path> -name <str> | rm",
    );
    // The same kind of command with other files has the same shape…
    expect(commandShape("find /other/x -maxdepth 2 -name '*.ts' | xargs wc -l")).toBe(
      commandShape("find /a/b -maxdepth 9 -name '*.py' | xargs wc -l"),
    );
    // …and a different command does not.
    expect(commandShape("rm -rf /a/b")).not.toBe(commandShape("find /a/b | xargs wc -l"));
  });
});

describe("learning from an answered gate", () => {
  function engine(): PolicyEngine {
    const pack = policyPackSchema.parse({
      id: "default",
      rules: [
        { class: "project_read", verdict: "allow" },
        { class: "other", verdict: "require_human" },
        { class: "credentials", verdict: "require_human" },
        { class: "delete", verdict: "require_human" },
      ],
    });
    return new PolicyEngine(
      { default: pack },
      { learnedAllow: (shape) => repos.learned.shapes().has(shape) },
    );
  }

  const unknown = "weirdtool --do-the-thing /workspace/projects/demo/src";

  it("asks the first time and not the second", () => {
    const first = engine().evaluate({ projectPath: PROJECT, command: unknown });
    expect(first.class).toBe("other");
    expect(first.verdict).toBe("require_human");

    repos.learned.add({
      shape: commandShape(unknown),
      sample: unknown,
      actionClass: "other",
      addedBy: "human",
    });

    const second = engine().evaluate({ projectPath: PROJECT, command: unknown });
    expect(second.verdict).toBe("allow");
    expect(second.learnedShape).toBe(commandShape(unknown));
    expect(second.reason).toMatch(/allowed by a human before/);

    // The same kind of command with a different argument is the same shape.
    const sibling = engine().evaluate({
      projectPath: PROJECT,
      command: "weirdtool --do-the-thing /workspace/projects/demo/doc",
    });
    expect(sibling.verdict).toBe("allow");
  });

  it("never learns a class the classifier understood", () => {
    // Even with the shape remembered, a credential read is still a credential read.
    repos.learned.add({
      shape: commandShape("cat /workspace/projects/demo/.env"),
      sample: "cat .env",
      actionClass: "other",
      addedBy: "human",
    });
    const decision = engine().evaluate({
      projectPath: PROJECT,
      command: "cat /workspace/projects/demo/.env",
    });
    expect(decision.class).toBe("credentials");
    expect(decision.verdict).toBe("require_human");
  });

  it("counts uses and can be forgotten", () => {
    const shape = commandShape(unknown);
    repos.learned.add({ shape, sample: unknown, actionClass: "other", addedBy: "human" });
    repos.learned.recordUse(shape);
    repos.learned.recordUse(shape);
    expect(repos.learned.list()[0]?.uses).toBe(2);

    expect(repos.learned.remove(shape)?.shape).toBe(shape);
    expect(repos.learned.list()).toHaveLength(0);
    expect(engine().evaluate({ projectPath: PROJECT, command: unknown }).verdict).toBe(
      "require_human",
    );
  });
});
