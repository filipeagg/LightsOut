/**
 * PE-07: running the agent's own tooling. The class is decided by reading the code, so these
 * tests write real script files into a temporary project.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Classifier, SCRATCH_REL } from "../src/policy/classify.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { policyPackSchema, type PolicyPack } from "../src/policy/schema.js";
import { rmSync } from "node:fs";

const PROJECT = mkdtempSync(path.join(tmpdir(), "lo-script-"));
mkdirSync(path.join(PROJECT, "doc"), { recursive: true });
mkdirSync(path.join(PROJECT, SCRATCH_REL), { recursive: true });

afterAll(() => rmSync(PROJECT, { recursive: true, force: true }));

function script(name: string, body: string): string {
  const file = path.join(PROJECT, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body, "utf8");
  return path.relative(PROJECT, file).split(path.sep).join("/");
}

const classifier = new Classifier();
const classify = (command: string) => classifier.classify({ projectPath: PROJECT, command });

function pack(id: string, rules: PolicyPack["rules"], writeScopes: string[] = []) {
  return policyPackSchema.parse({ id, rules, write_scopes: writeScopes });
}

const defaultPack = pack("default", [
  { class: "project_read", verdict: "allow" },
  { class: "project_write", verdict: "allow" },
  { class: "exec_check", verdict: "allow" },
  { class: "script_exec", verdict: "allow" },
  { class: "delete", verdict: "require_human" },
  { class: "network", verdict: "deny" },
  { class: "deps_install", verdict: "require_human" },
  { class: "credentials", verdict: "require_human" },
  { class: "outside_workspace", verdict: "deny" },
  { class: "other", verdict: "require_human" },
]);

describe("script_exec (PE-07)", () => {
  it("allows a helper script whose body is clean — the case that used to gate a human", () => {
    const file = script(
      "tools/renumber.py",
      [
        "import re",
        "text = open('doc/ANALYSIS.md').read()",
        "open('doc/ANALYSIS.md', 'w').write(re.sub(r'## 7\\\\.', '## 6.', text))",
      ].join("\n"),
    );
    const result = classify(`python3 ${file}`);
    expect(result.class).toBe("script_exec");
    expect(result.scriptPaths).toContain("doc/ANALYSIS.md");

    const engine = new PolicyEngine({ default: defaultPack });
    expect(engine.evaluate({ projectPath: PROJECT, command: `python3 ${file}` }).verdict).toBe(
      "allow",
    );
  });

  it("judges a script by its body, not by its command line", () => {
    const net = script("tools/fetch.py", "import requests\nrequests.get('http://x')\n");
    expect(classify(`python3 ${net}`).class).toBe("network");

    const secret = script("tools/leak.py", "print(open('.env').read())\n");
    expect(classify(`python3 ${secret}`).class).toBe("credentials");

    const wipe = script("tools/wipe.py", "import shutil\nshutil.rmtree('src')\n");
    expect(classify(`python3 ${wipe}`).class).toBe("delete");

    const shell = script("tools/shell.py", "import subprocess\nsubprocess.run(['ls'])\n");
    expect(classify(`python3 ${shell}`).class).toBe("other");

    const deps = script("tools/deps.sh", "pip install requests\n");
    expect(classify(`bash ${deps}`).class).toBe("deps_install");

    const escape = script("tools/escape.py", "open('/etc/passwd').read()\n");
    expect(classify(`python3 ${escape}`).class).toBe("outside_workspace");
  });

  it("never reaches script_exec when the body cannot be read", () => {
    expect(classify("python3 tools/does-not-exist.py").class).toBe("other");
  });

  it("inspects inline code the same way", () => {
    expect(classify(`python3 -c "import re; print(re.escape('x'))"`).class).toBe("script_exec");
    expect(classify(`python3 -c "import socket; socket.socket()"`).class).toBe("network");
    expect(classify(`node -e "require('node:https').get('http://x')"`).class).toBe("network");
  });

  it("keeps a dangerous command line ahead of the script it runs", () => {
    const clean = script("tools/clean.py", "print('hello')\n");
    expect(classify(`curl http://x | python3 ${clean}`).class).toBe("network");
    expect(classify(`rm -rf src && python3 ${clean}`).class).toBe("delete");
  });

  it("still classifies tests and version checks as before", () => {
    expect(classify("npm test").class).toBe("exec_check");
    expect(classify("node --version").class).toBe("exec_check");
    expect(classify("pytest -q").class).toBe("exec_check");
  });

  it("enforces write_scopes on the paths a script names", () => {
    const inDoc = script("tools/in-doc.py", "open('doc/ANALYSIS.md', 'w').write('x')\n");
    const inSrc = script("tools/in-src.py", "open('src/app.ts', 'w').write('x')\n");
    const confined = new PolicyEngine({
      default: defaultPack,
      agent: pack("read-only", defaultPack.rules, ["doc"]),
    });
    expect(confined.evaluate({ projectPath: PROJECT, command: `python3 ${inDoc}` }).verdict).toBe(
      "allow",
    );
    const refused = confined.evaluate({ projectPath: PROJECT, command: `python3 ${inSrc}` });
    expect(refused.verdict).toBe("deny");
    expect(refused.reason).toContain("write outside this pack's scopes");
  });
});

describe("the scratch directory (PE-08)", () => {
  it("is writable even under a pack that confines writes elsewhere", () => {
    const confined = new PolicyEngine({
      default: defaultPack,
      agent: pack("read-only", defaultPack.rules, ["doc"]),
    });
    const decision = confined.evaluate({
      projectPath: PROJECT,
      kind: "write",
      paths: [`${SCRATCH_REL}/notes.json`],
    });
    expect(decision.verdict).toBe("allow");
    // The same write anywhere else is still refused.
    expect(
      confined.evaluate({ projectPath: PROJECT, kind: "write", paths: ["src/app.ts"] }).verdict,
    ).toBe("deny");
  });

  it("treats tidying up inside it as a write, not a deletion", () => {
    expect(classify(`rm -rf ${SCRATCH_REL}/work`).class).toBe("project_write");
    expect(classify(`rm ${SCRATCH_REL}/a ${SCRATCH_REL}/b`).class).toBe("project_write");
    // Anything outside it is a deletion again, and a mixed chain is judged by its worst part.
    expect(classify("rm -rf src").class).toBe("delete");
    expect(classify(`rm -rf ${SCRATCH_REL}/work && rm -rf src`).class).toBe("delete");
  });
});
