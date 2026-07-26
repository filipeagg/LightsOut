/**
 * The durable toolchain (ST-07, ST-08, DESIGN §7.6).
 *
 * The line being protected is the one between three places an install can land: the scratch
 * directory, which dies with the run; the project's own toolchain, which outlives it but belongs
 * to one project; and the image, which belongs to everything and cannot be changed from in here.
 * Confusing any two of them is how an agent ends up either reinstalling a framework every run or
 * silently changing the environment of every other project.
 */
import { describe, expect, it } from "vitest";
import { Classifier } from "../src/policy/classify.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { NEVER_LEARNED } from "../src/policy/schema.js";
import {
  installsIntoToolchain,
  isRootManager,
  isToolchainManager,
  managerOf,
  toolchainEnv,
  toolchainRoot,
} from "../src/projects/toolchain.js";

const PROJECT = "/workspace/projects/portal";
const ID = "portal";
const ROOT = "/toolchains";

function classify(command: string) {
  return new Classifier().classify({
    kind: "execute",
    command,
    projectPath: PROJECT,
    projectId: ID,
    toolchainsRoot: ROOT,
  });
}

describe("managerOf", () => {
  it("names the manager and normalises pip3", () => {
    expect(managerOf("npm install left-pad")).toBe("npm");
    expect(managerOf("pip3 install --target x httpx")).toBe("pip");
    expect(managerOf("apt-get install libpq-dev")).toBe("apt-get");
    expect(managerOf("ls -la")).toBeUndefined();
  });

  it("separates what can be granted from what needs root", () => {
    expect(isToolchainManager("npm")).toBe(true);
    expect(isToolchainManager("apt")).toBe(false);
    expect(isRootManager("apt")).toBe(true);
    expect(isRootManager("npm")).toBe(false);
  });
});

describe("installsIntoToolchain", () => {
  it("counts an npm install with no target, which follows npm_config_prefix", () => {
    expect(installsIntoToolchain(ID, PROJECT, "npm install vite", ROOT)).toBe(true);
  });

  it("counts an explicit target inside the toolchain", () => {
    const target = `${toolchainRoot(ID, ROOT)}/py`;
    expect(installsIntoToolchain(ID, PROJECT, `pip install --target ${target} httpx`, ROOT)).toBe(
      true,
    );
  });

  it("does not count a bare pip install, which writes into the interpreter", () => {
    expect(installsIntoToolchain(ID, PROJECT, "pip install httpx", ROOT)).toBe(false);
  });

  it("does not count another project's toolchain", () => {
    const other = `${toolchainRoot("other", ROOT)}/py`;
    expect(installsIntoToolchain(ID, PROJECT, `pip install --target ${other} httpx`, ROOT)).toBe(
      false,
    );
  });

  it("does not count a target inside the project's scratch directory", () => {
    expect(
      installsIntoToolchain(ID, PROJECT, "pip install --target .lightsout/tmp/deps httpx", ROOT),
    ).toBe(false);
  });
});

describe("classification (§7.6)", () => {
  it("an npm install into the toolchain is toolchain_install, not deps_install", () => {
    expect(classify("npm install vite").class).toBe("toolchain_install");
  });

  it("a bare pip install is still deps_install: it changes the image", () => {
    expect(classify("pip install httpx").class).toBe("deps_install");
  });

  it("the scratch install is still an ordinary project write (PE-08)", () => {
    expect(classify("pip install --target .lightsout/tmp/deps openpyxl").class).toBe(
      "project_write",
    );
  });

  it("apt is deps_install whatever the flags: it needs root and goes down the ST-08 path", () => {
    expect(classify("apt-get install -y libpq-dev").class).toBe("deps_install");
  });

  it("without a project id nothing changes, which is the safe default", () => {
    const plain = new Classifier().classify({
      kind: "execute",
      command: "npm install vite",
      projectPath: PROJECT,
    });
    expect(plain.class).toBe("deps_install");
  });
});

describe("the grant decides, and only for its own project", () => {
  const packs = {
    default: {
      id: "default",
      rules: [
        { class: "toolchain_install" as const, verdict: "require_human" as const },
        { class: "deps_install" as const, verdict: "require_human" as const },
      ],
      write_scopes: [],
      vault: { test_only_required: false },
      matchers: {},
    },
  };

  const input = {
    kind: "execute",
    command: "npm install vite",
    projectPath: PROJECT,
    projectId: ID,
    toolchainsRoot: ROOT,
  };

  it("asks a human when nothing has been granted", () => {
    const decision = new PolicyEngine(packs).evaluate(input);
    expect(decision.class).toBe("toolchain_install");
    expect(decision.verdict).toBe("require_human");
  });

  it("allows it once the manager is authorised, and says so", () => {
    const decision = new PolicyEngine(packs, {
      toolchainGrant: (manager) => manager === "npm",
    }).evaluate(input);
    expect(decision.verdict).toBe("allow");
    expect(decision.toolchainManager).toBe("npm");
    expect(decision.reason).toContain("authorised");
  });

  it("a grant for one manager is not a grant for another", () => {
    const decision = new PolicyEngine(packs, {
      toolchainGrant: (manager) => manager === "pip",
    }).evaluate(input);
    expect(decision.verdict).toBe("require_human");
  });

  it("is never settled by a system-wide learned shape", () => {
    expect(NEVER_LEARNED.has("toolchain_install")).toBe(true);
    const decision = new PolicyEngine(packs, { learnedAllow: () => true }).evaluate(input);
    expect(decision.verdict).toBe("require_human");
  });
});

describe("toolchainEnv", () => {
  it("puts the toolchain first on PATH and keeps what was there", () => {
    const env = toolchainEnv(ID, { PATH: "/usr/bin" }, ROOT);
    expect(env.PATH.startsWith(`${ROOT}/${ID}/bin:`)).toBe(true);
    expect(env.PATH.endsWith("/usr/bin")).toBe(true);
    expect(env.NODE_PATH).toBe(`${ROOT}/${ID}/node_modules`);
    expect(env.npm_config_prefix).toBe(`${ROOT}/${ID}`);
  });

  it("keeps the scratch deps directory importable alongside it (ST-03b)", () => {
    const env = toolchainEnv(ID, { PYTHONPATH: "/p/.lightsout/tmp/deps" }, ROOT);
    expect(env.PYTHONPATH.split(":")).toContain("/p/.lightsout/tmp/deps");
    expect(env.PYTHONPATH.split(":")).toContain(`${ROOT}/${ID}/py`);
  });
});
