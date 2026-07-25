/** Phase 3 gate: classification, policy layering and the hard floor (PE-01..05). */
import { describe, expect, it } from "vitest";
import { Classifier } from "../src/policy/classify.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { policyPackSchema, type PolicyPack } from "../src/policy/schema.js";

const PROJECT = "/workspace/projects/demo";

function pack(id: string, rules: PolicyPack["rules"], matchers: PolicyPack["matchers"] = {}) {
  return policyPackSchema.parse({ id, rules, matchers });
}

const defaultPack = pack("default", [
  { class: "project_read", verdict: "allow" },
  { class: "project_write", verdict: "allow" },
  { class: "exec_check", verdict: "allow" },
  { class: "git_local", verdict: "allow" },
  { class: "deps_install", verdict: "require_human" },
  { class: "delete", verdict: "require_human" },
  { class: "git_push", verdict: "deny" },
  { class: "network", verdict: "deny" },
  { class: "outside_workspace", verdict: "deny" },
  { class: "credentials", verdict: "require_human" },
  { class: "publish_external", verdict: "require_human" },
  { class: "other", verdict: "require_human" },
]);

describe("classifier", () => {
  const classifier = new Classifier();
  const classify = (input: Partial<Parameters<Classifier["classify"]>[0]>) =>
    classifier.classify({ projectPath: PROJECT, ...input }).class;

  it("classifies commands by intent, not by prefix", () => {
    expect(classify({ command: "npm test" })).toBe("exec_check");
    expect(classify({ command: "npm run build" })).toBe("exec_check");
    expect(classify({ command: "npm install lodash" })).toBe("deps_install");
    expect(classify({ command: "git commit -m x" })).toBe("git_local");
    expect(classify({ command: "git push origin main" })).toBe("git_push");
    expect(classify({ command: "rm -rf build" })).toBe("delete");
    expect(classify({ command: "curl https://example.com" })).toBe("network");
    expect(classify({ command: "npm publish" })).toBe("publish_external");
    expect(classify({ command: "somebinary --weird" })).toBe("other");
  });

  it("puts dangerous variants ahead of their benign prefix", () => {
    // Force push must never pass as ordinary local git.
    expect(classify({ command: "git push --force origin main" })).toBe("credentials");
    expect(classify({ command: "cat .env" })).toBe("credentials");
    expect(classify({ command: "grep -r AWS_SECRET ." })).toBe("credentials");
  });

  it("treats any path escape as outside_workspace regardless of the command", () => {
    expect(classify({ command: "npm test", paths: ["../other/file.ts"] })).toBe(
      "outside_workspace",
    );
    expect(classify({ kind: "read", paths: ["/etc/passwd"] })).toBe("outside_workspace");
    expect(classify({ kind: "edit", paths: ["src/a.ts", "/tmp/x"] })).toBe("outside_workspace");
    expect(classify({ kind: "edit", paths: ["src/a.ts", `${PROJECT}/src/b.ts`] })).toBe(
      "project_write",
    );
  });

  it("falls back to the tool kind when there is no command", () => {
    expect(classify({ kind: "read" })).toBe("project_read");
    expect(classify({ kind: "edit" })).toBe("project_write");
    expect(classify({ kind: "delete" })).toBe("delete");
    expect(classify({ kind: "fetch" })).toBe("network");
    expect(classify({ kind: "think" })).toBe("other");
  });

  it("matches every command candidate and keeps the most dangerous class", () => {
    // Real shape seen from the Claude adapter: the literal command is in the title and the
    // content is a friendly description that matches nothing.
    expect(
      classify({
        kind: "execute",
        commands: ["Attempt to download example.com with curl", "curl -sS https://example.com"],
      }),
    ).toBe("network");
    expect(classify({ kind: "execute", commands: ["run the tests", "npm test"] })).toBe(
      "exec_check",
    );
    expect(classify({ kind: "execute", commands: ["npm test", "npm install left-pad"] })).toBe(
      "deps_install",
    );
    expect(classify({ kind: "execute", commands: ["tidy up", "no match here"] })).toBe("other");
  });

  it("treats shell writes inside the project as project_write", () => {
    // Real case from the phase 4 gate: this used to fall into `other` and stop the chain on a
    // human gate even though writing inside the project is exactly what the task asked for.
    expect(classify({ kind: "execute", command: `printf 'one\\n' > ${PROJECT}/one.txt` })).toBe(
      "project_write",
    );
    expect(classify({ kind: "execute", command: "echo hello >> notes.md" })).toBe("project_write");
    expect(classify({ kind: "execute", command: "touch src/new.ts" })).toBe("project_write");
    expect(classify({ kind: "execute", command: "mkdir -p src/deep" })).toBe("project_write");
    expect(classify({ kind: "execute", command: "sed -i s/a/b/ src/a.ts" })).toBe("project_write");
  });

  it("finds path escapes hidden inside a command (PE-02)", () => {
    expect(classify({ kind: "execute", command: "printf x > /etc/passwd" })).toBe(
      "outside_workspace",
    );
    expect(classify({ kind: "execute", command: "echo x > ../sibling/file.txt" })).toBe(
      "outside_workspace",
    );
    expect(classify({ kind: "execute", command: "cat /etc/shadow" })).toBe("outside_workspace");
    // A redirect that stays inside is still a write, not an escape.
    expect(classify({ kind: "execute", command: `echo x > ${PROJECT}/inside.txt` })).toBe(
      "project_write",
    );
  });

  it("accepts extra matchers from a pack", () => {
    const custom = new Classifier({ exec_check: ["^bazel test\\b"] });
    expect(custom.classify({ projectPath: PROJECT, command: "bazel test //..." }).class).toBe(
      "exec_check",
    );
  });

  it("resolves paths relative to the project root", () => {
    expect(Classifier.isInside(PROJECT, "src/a.ts")).toBe(true);
    expect(Classifier.isInside(PROJECT, `${PROJECT}/../demo2`)).toBe(false);
    expect(Classifier.isInside(PROJECT, PROJECT)).toBe(true);
  });
});

describe("policy engine", () => {
  it("answers from the default pack and records the source", () => {
    const engine = new PolicyEngine({ default: defaultPack });
    const write = engine.evaluate({ projectPath: PROJECT, kind: "edit", paths: ["src/a.ts"] });
    expect(write).toMatchObject({ class: "project_write", verdict: "allow", ruleSource: "default" });
    expect(write.latencyMs).toBeLessThan(50);

    const push = engine.evaluate({ projectPath: PROJECT, command: "git push" });
    expect(push.verdict).toBe("deny");
  });

  it("layers project over agent over default (PE-05)", () => {
    const agentPack = pack("agent", [{ class: "deps_install", verdict: "deny" }]);
    const projectPack = pack("project", [{ class: "deps_install", verdict: "allow" }]);

    const withAgent = new PolicyEngine({ agent: agentPack, default: defaultPack });
    expect(withAgent.evaluate({ projectPath: PROJECT, command: "npm install x" })).toMatchObject({
      verdict: "deny",
      ruleSource: "agent",
    });

    const withProject = new PolicyEngine({
      project: projectPack,
      agent: agentPack,
      default: defaultPack,
    });
    expect(withProject.evaluate({ projectPath: PROJECT, command: "npm install x" })).toMatchObject({
      verdict: "allow",
      ruleSource: "project",
    });
  });

  it("enforces the hard floor no pack can relax (PE-03)", () => {
    const reckless = pack("reckless", [
      { class: "outside_workspace", verdict: "allow" },
      { class: "credentials", verdict: "allow" },
      { class: "publish_external", verdict: "provisional" },
    ]);
    const engine = new PolicyEngine({ project: reckless, default: defaultPack });

    const escape = engine.evaluate({ projectPath: PROJECT, kind: "edit", paths: ["/etc/hosts"] });
    expect(escape).toMatchObject({ verdict: "deny", floored: true });

    const creds = engine.evaluate({ projectPath: PROJECT, command: "cat .env" });
    expect(creds).toMatchObject({ verdict: "require_human", floored: true });

    const publish = engine.evaluate({ projectPath: PROJECT, command: "npm publish" });
    expect(publish).toMatchObject({ verdict: "require_human", floored: true });
  });

  it("defaults to require_human when no pack declares the class", () => {
    const engine = new PolicyEngine({ default: pack("empty", []) });
    const decision = engine.evaluate({ projectPath: PROJECT, command: "npm test" });
    expect(decision.verdict).toBe("require_human");
    expect(decision.reason).toContain("no rule for this class");
  });

  it("rejects a pack with an unknown action class in matchers", () => {
    expect(() =>
      policyPackSchema.parse({ id: "bad", rules: [], matchers: { typo_class: ["^x"] } }),
    ).toThrow();
  });
});
