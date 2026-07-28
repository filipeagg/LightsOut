/**
 * MC-09 (the server teaches its own use) and OR-10 (no launch without a request and an expected
 * return).
 */
import { describe, expect, it } from "vitest";
import { availableTopics, guide, TOPIC_ORDER } from "../src/mcp/guide.js";
import { SERVER_INSTRUCTIONS } from "../src/mcp/server.js";
import { lintDocument } from "../src/projects/deliverable.js";
import {
  composeSpec,
  EXPECTED_HEADING,
  requireExpects,
  requireRequest,
} from "../src/orchestrator/spec.js";

describe("the manual served over MCP (MC-09)", () => {
  it("ships every topic it promises, in learning order", () => {
    const topics = availableTopics();
    expect(topics).toEqual(TOPIC_ORDER);
    expect(topics[0]).toBe("overview");
  });

  it("lists the topics when asked for none, with a line about each", () => {
    const answer = guide() as { topics: { topic: string; about: string }[]; hint: string };
    expect(answer.topics).toHaveLength(TOPIC_ORDER.length);
    for (const entry of answer.topics) expect(entry.about.length).toBeGreaterThan(0);
    expect(answer.hint).toMatch(/overview/);
  });

  it("returns a section whole, and says so when the topic does not exist", () => {
    const answer = guide("launching") as { topic: string; content: string };
    expect(answer.topic).toBe("launching");
    expect(answer.content).toMatch(/expects/);
    expect(() => guide("nonsense")).toThrow(/unknown topic/);
    expect(() => guide("../../etc/passwd")).toThrow(/unknown topic/);
  });

  it("is machine-first, like everything else the system writes (BA-07)", () => {
    for (const topic of TOPIC_ORDER) {
      const { content } = guide(topic) as { content: string };
      const lint = lintDocument(content);
      expect(
        lint.ok,
        `guide/${topic}.md drifted: ${lint.reasons.join(" | ")}`,
      ).toBe(true);
    }
  });

  /**
   * The guide told a session to use a `curate` pack that PE-14 removed months earlier, and it
   * planned around it. A document that is confidently out of date is worse than one that is
   * missing: this test is the reason the next pack change cannot leave it behind.
   */
  it("offers only packs that exist, and does not present a retired one as a choice", () => {
    const policies = (guide("policies") as { content: string }).content;
    for (const real of ["| read |", "| build |", "| build-network |"]) {
      expect(policies, `the pack table lost ${real}`).toContain(real);
    }
    for (const gone of ["| curate |", "| probe |", "| default |", "| no-write |", "| test |"]) {
      expect(policies, `${gone} is a retired pack presented as a choice`).not.toContain(gone);
    }
    // Curating knowledge is a capability on the profile now, and the guide has to say so or the
    // reader concludes it is impossible.
    const all = TOPIC_ORDER.map((t) => (guide(t) as { content: string }).content).join("\n");
    expect(all).toContain("capabilities: [knowledge_write]");
  });

  it("teaches the rules a client cannot infer from the tool list", () => {
    const all = TOPIC_ORDER.map((t) => (guide(t) as { content: string }).content).join("\n");
    for (const idea of [
      "write_agent",
      "write_template",
      "add_area",
      "attach_knowledge",
      // TR-01 and SR-09: the two verbs a client would otherwise never reach for.
      "create_trigger",
      "steer_run",
      "answer_doubt",
      "resolve_path",
      "machine-first",
      "expects",
    ]) {
      expect(all, `the guide never mentions ${idea}`).toContain(idea);
    }
  });

  it("says the essentials before any tool is called", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/expects/);
    expect(SERVER_INSTRUCTIONS).toMatch(/guide/);
    expect(SERVER_INSTRUCTIONS).toMatch(/doubt/);
    expect(SERVER_INSTRUCTIONS).toMatch(/127\.0\.0\.1:8484/);
    // TP-09: choosing a template is one of the things a client gets wrong by never being told.
    expect(SERVER_INSTRUCTIONS).toMatch(/list_templates/);
    // Short: it is in context for every conversation. The budget grows only with a rule that
    // earned its place; every line here is one a client demonstrably got wrong without it.
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(1750);
  });
});

describe("the launch contract (OR-10)", () => {
  it("refuses a launch that does not say what it wants back", () => {
    expect(() => requireExpects("", 'task "x"')).toThrow(/needs `expects`/);
    expect(() => requireExpects("   ", 'task "x"')).toThrow(/OR-10/);
    expect(requireExpects(" the file ", 'task "x"')).toBe("the file");
  });

  it("refuses a launch with no request for this run", () => {
    expect(() => requireRequest(undefined, "phase analyse")).toThrow(/request for this run/);
    expect(requireRequest("read the auth layer", "phase analyse")).toBe("read the auth layer");
  });

  it("puts both into the spec, and does not duplicate them on a requeue", () => {
    const once = composeSpec({ spec: "do the thing", expects: "a file" });
    expect(once).toContain("do the thing");
    expect(once).toContain(EXPECTED_HEADING);
    expect(composeSpec({ spec: once, expects: "a different file" })).toBe(once);
  });
});
