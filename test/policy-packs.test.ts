/**
 * PE-14: three packs, and everything else is a property of the agent (§7.2b).
 *
 * The picker offered ten names for four independent decisions — two of them (`advisor`,
 * `no-write`) with byte-identical rules, one of them (`read-only`) named for something it does
 * not do. These tests hold the three that replaced them, and the promise that nobody's existing
 * profile stopped working.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentsLoader } from "../src/agents/loader.js";
import { agentProfileSchema } from "../src/agents/schema.js";
import { PolicyEngine } from "../src/policy/engine.js";

let agents: AgentsLoader;

beforeAll(async () => {
  agents = new AgentsLoader(await mkdtemp(path.join(tmpdir(), "lo-packs-")));
  await agents.load();
});

const PROJECT = "/workspace/projects/p";
const verdict = (packId: string, command: string) => {
  const pack = agents.pack(packId)!;
  return new PolicyEngine({ agent: pack, default: pack }).evaluate({
    projectPath: PROJECT,
    command,
  }).verdict;
};

describe("three packs, and only three are offered", () => {
  it("offers exactly read, build and build-network", () => {
    expect(agents.choosablePacks().map((p) => p.id).sort()).toEqual([
      "build",
      "build-network",
      "read",
    ]);
  });

  it("each one says what it is, so the picker needs no prior knowledge", () => {
    for (const pack of agents.choosablePacks()) {
      expect(pack.name, pack.id).toBeTruthy();
      expect((pack.description ?? "").length, pack.id).toBeGreaterThan(20);
    }
  });

  it("still resolves every retired id, so nobody's profile broke", () => {
    for (const id of [
      "advisor",
      "no-write",
      "read-only",
      "curate",
      "probe",
      "test",
      "integrate",
      "web-prototype",
      "default",
    ]) {
      expect(agents.pack(id), id).toBeDefined();
      expect(agents.pack(id)!.deprecated, id).toBe(true);
    }
  });
});

describe("what the three actually permit", () => {
  it("read runs nothing and writes nothing", () => {
    expect(verdict("read", "cat doc/PLAN.md")).toBe("allow");
    expect(verdict("read", "printf x > doc/PLAN.md")).toBe("deny");
    expect(verdict("read", "npm test")).toBe("deny");
    expect(verdict("read", "curl https://example.com")).toBe("deny");
  });

  it("build works in the project and stops at the network", () => {
    expect(verdict("build", "printf x > src/a.ts")).toBe("allow");
    expect(verdict("build", "npm test")).toBe("allow");
    expect(verdict("build", "git commit -m x")).toBe("allow");
    expect(verdict("build", "curl https://example.com")).toBe("deny");
  });

  it("build-network is build plus the one thing that leaves the machine", () => {
    expect(verdict("build-network", "printf x > src/a.ts")).toBe("allow");
    expect(verdict("build-network", "curl https://example.com")).toBe("allow");
    // …and not more than that: pushing is still the orchestrator's job.
    expect(verdict("build-network", "git push origin main")).toBe("deny");
  });

  it("none of them serves inline, whatever else they may do (PV-02)", () => {
    for (const id of ["read", "build", "build-network"]) {
      expect(verdict(id, "npm run dev"), id).toBe("deny");
    }
  });
});

describe("the profile carries what used to need a pack of its own", () => {
  const profile = (extra: Record<string, unknown>) =>
    agentProfileSchema.parse({
      id: "x",
      name: "X",
      engine: "claude",
      policy: "build",
      ...extra,
    });

  it("confines writes with writeScopes instead of a bespoke pack", () => {
    const confined = agents.packFor(profile({ writeScopes: ["probes", "doc"] }))!;
    expect(confined.write_scopes).toEqual(["probes", "doc"]);
    // The pack itself is untouched: the overlay is per profile.
    expect(agents.pack("build")!.write_scopes).toEqual([]);

    const engine = new PolicyEngine({ agent: confined, default: agents.pack("build")! });
    expect(engine.evaluate({ projectPath: PROJECT, command: "touch probes/p.py" }).verdict).toBe(
      "allow",
    );
    expect(engine.evaluate({ projectPath: PROJECT, command: "touch src/x.ts" }).verdict).toBe(
      "deny",
    );
  });

  it("grants knowledge_write and serve as capabilities, and nothing else", () => {
    const curator = agents.packFor(profile({ capabilities: ["knowledge_write"] }))!;
    expect(curator.rules[0]).toMatchObject({ class: "knowledge_write", verdict: "allow" });
    // A capability can only add: what the pack denied for other classes is unchanged.
    const engine = new PolicyEngine({ agent: curator, default: curator });
    expect(engine.evaluate({ projectPath: PROJECT, command: "curl https://x.example" }).verdict).toBe(
      "deny",
    );

    // The enum is the guard: nothing that leaves the machine can be a capability.
    expect(() => profile({ capabilities: ["network"] })).toThrow();
    expect(() => profile({ capabilities: ["credentials"] })).toThrow();
  });

  it("leaves a profile with neither exactly as its pack", () => {
    expect(agents.packFor(profile({}))).toBe(agents.pack("build"));
  });
});

describe("the builtin library uses the new shape", () => {
  it("every builtin names one of the three", () => {
    const allowed = new Set(["read", "build", "build-network"]);
    for (const p of agents.current().profiles.values()) {
      expect(allowed.has(p.policy), `${p.id} → ${p.policy}`).toBe(true);
    }
  });

  it("keeps the confinement each specialised pack used to give", () => {
    const scopes = (id: string) => agents.packFor(agents.profileOrThrow(id))!.write_scopes;
    expect(scopes("contract-prober")).toEqual(["probes", "doc"]);
    expect(scopes("planner")).toEqual(["doc"]);
    expect(scopes("qa-engineer")).toContain("tests");
    expect(scopes("builder")).toEqual([]);
  });

  it("keeps the capability that was a pack", () => {
    expect(agents.profileOrThrow("codebase-analyst").capabilities).toEqual(["knowledge_write"]);
    // `serve` was web-prototyper's whole reason to exist and it is retired (BA-01): serving is
    // preview_start's job now (PV-07), owned by LightsOut rather than granted to an agent.
    for (const p of agents.current().profiles.values()) {
      expect(p.capabilities ?? [], p.id).not.toContain("serve");
    }
  });

  it("keeps the network exactly where it was", () => {
    const reaches = (id: string) =>
      agents
        .packFor(agents.profileOrThrow(id))!
        .rules.find((r) => r.class === "network")?.verdict === "allow";
    expect(reaches("contract-prober")).toBe(true);
    expect(reaches("integrator")).toBe(true);
    expect(reaches("qa-engineer")).toBe(true);
    expect(reaches("builder")).toBe(false);
    expect(reaches("answerer")).toBe(false);
  });
});
