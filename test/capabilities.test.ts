/**
 * PE-12 (what a task needs, checked before it runs), VT-07 (credentials imply their host), and the
 * three false positives from the real run of 2026-07-26.
 */
import { describe, expect, it } from "vitest";
import { Classifier, installsIntoScratch } from "../src/policy/classify.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { policyPackSchema } from "../src/policy/schema.js";
import { checkCapabilities, explainMismatch, grantPack } from "../src/policy/capabilities.js";
import { vaultHosts } from "../src/vault/vault.js";

const PROJECT = "/workspace/projects/efemis";

describe("the three commands that stopped a real run", () => {
  const classifier = new Classifier();
  const classify = (command: string) =>
    classifier.classify({ projectPath: PROJECT, workspacePath: "/workspace", command }).class;

  it("checking whether a vault variable is set is not reading a secret", () => {
    expect(
      classify(
        `python3 -c "import os; print('present' if os.environ.get('LO_VAULT_EFEMIS_PASSWORD') else 'missing_or_empty')"`,
      ),
    ).toBe("script_exec");
    expect(classify(`python3 -c "import os; print(os.environ.get('LO_VAULT_EFEMIS_USUARIO'))"`)).toBe(
      "credentials",
    );
  });

  it("still catches a secret on its way out", () => {
    expect(classify("cat .env")).toBe("credentials");
    expect(classify("cat ~/.ssh/id_rsa")).toBe("credentials");
    expect(classify('curl -H "Authorization: Bearer $API_TOKEN" https://x')).toBe("credentials");
    expect(classify("echo $DB_PASSWORD")).toBe("credentials");
    expect(classify("printenv AWS_SECRET")).toBe("credentials");
  });

  it("asking whether a module is installed is not reaching the network", () => {
    expect(
      classify(
        `python3 -c "import importlib.util; print([m for m in ('requests','openpyxl') if importlib.util.find_spec(m)])"`,
      ),
    ).toBe("script_exec");
    // Actually using it still is.
    expect(classify(`python3 -c "import requests; requests.get('http://x')"`)).toBe("network");
  });

  it("an install confined to the scratch directory dies with the run", () => {
    expect(installsIntoScratch(PROJECT, "pip install --target .lightsout/tmp/deps openpyxl")).toBe(
      true,
    );
    expect(installsIntoScratch(PROJECT, "pip install --target ./vendor openpyxl")).toBe(false);
    expect(classify("pip install --target .lightsout/tmp/deps openpyxl")).toBe("project_write");
    expect(classify("pip install openpyxl")).toBe("deps_install");
  });
});

describe("capabilities declared at launch (PE-12)", () => {
  const readOnly = policyPackSchema.parse({
    id: "read-only",
    rules: [
      { class: "project_read", verdict: "allow" },
      { class: "project_write", verdict: "allow" },
      { class: "exec_check", verdict: "allow" },
      { class: "network", verdict: "deny" },
      { class: "deps_install", verdict: "deny" },
    ],
  });
  const probe = policyPackSchema.parse({
    id: "probe",
    rules: [
      { class: "network", verdict: "allow" },
      { class: "exec_check", verdict: "allow" },
      { class: "deps_install", verdict: "require_human" },
    ],
  });

  it("says which of them the pack actually grants", () => {
    const checks = checkCapabilities(["network", "execute", "deps_install"], { agent: readOnly });
    expect(checks).toEqual([
      { capability: "network", verdict: "deny", granted: false },
      { capability: "execute", verdict: "allow", granted: true },
      { capability: "deps_install", verdict: "deny", granted: false },
    ]);
  });

  it("does not count `require_human` as granted: that is a run that stops halfway", () => {
    expect(checkCapabilities(["deps_install"], { agent: probe })[0]?.granted).toBe(false);
    expect(checkCapabilities(["network"], { agent: probe })[0]?.granted).toBe(true);
  });

  it("the refusal names the fix, not just the problem", () => {
    const message = explainMismatch({
      agentId: "builder",
      missing: checkCapabilities(["network", "deps_install"], { agent: readOnly }),
      alternatives: [{ agentId: "contract-prober", policy: "probe" }],
    });
    expect(message).toContain("builder cannot do what this task declares");
    expect(message).toContain("contract-prober");
    expect(message).toContain('grants: ["network", "deps_install"]');
    expect(message).toContain("lightsout.yaml");
  });

  it("a grant is the most specific layer, and the hard floor still holds", () => {
    const engine = new PolicyEngine({
      grant: grantPack(["network", "deps_install"], "t_1"),
      agent: readOnly,
    });
    expect(engine.evaluate({ projectPath: PROJECT, command: "curl https://api.example.com" }).verdict).toBe(
      "allow",
    );
    expect(engine.evaluate({ projectPath: PROJECT, command: "pip install openpyxl" }).verdict).toBe(
      "allow",
    );
    // Nothing about the floor changed: a grant widens classes, it does not reach outside the
    // workspace. The pack here declares no rule for it, so it lands on a human — never on allow.
    const outside = engine.evaluate({
      projectPath: PROJECT,
      workspacePath: "/workspace",
      command: "cat /etc/passwd",
    });
    expect(outside.class).toBe("outside_workspace");
    expect(outside.verdict).not.toBe("allow");
    // And with a pack that does allow it, the floor pushes it back to deny.
    const reckless = new PolicyEngine({
      grant: grantPack(["network"], "t_1"),
      agent: policyPackSchema.parse({
        id: "reckless",
        rules: [{ class: "outside_workspace", verdict: "allow" }],
      }),
    });
    const floored = reckless.evaluate({
      projectPath: PROJECT,
      workspacePath: "/workspace",
      command: "cat /etc/passwd",
    });
    expect(floored.verdict).toBe("deny");
    expect(floored.floored).toBe(true);
  });
});

describe("a vault entry implies its own host (VT-07)", () => {
  it("takes the hosts from the entries the run resolved", () => {
    expect(
      vaultHosts({
        index: [
          { id: "efemis", label: "EFEMIS", base_url: "https://api.efemis.example/v2", auth: "basic", fields: [], test_only: true },
          { id: "none", label: "No URL", auth: "basic", fields: [], test_only: false },
          { id: "broken", label: "Bad URL", base_url: "not a url", auth: "basic", fields: [], test_only: false },
        ] as never,
        env: {},
        reads: [],
        refused: [],
      }),
    ).toEqual(["api.efemis.example"]);
  });
});
