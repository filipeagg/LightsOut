/**
 * Login flow machinery (SU-04).
 *
 * Driven with stub commands rather than the real CLIs on purpose: `codex login` deletes the
 * existing credentials the moment it starts, so a test — or a phase gate — that ran it for real
 * would log the machine out. The gate checks the HTTP wiring; this checks the parsing, the
 * replay and the cancellation.
 */
import { describe, expect, it } from "vitest";
import { LoginFlows, type FlowEvent } from "../src/setup/login-flows.js";
import type { EngineHealth } from "../src/health.js";

function probe(auth: boolean) {
  let invalidated = 0;
  const engines = async (): Promise<EngineHealth[]> => [
    {
      engine: "claude",
      adapter: "stub",
      detected: true,
      auth,
      authSource: auth ? "api_key" : null,
      checkedAt: new Date().toISOString(),
    },
  ];
  return { invalidate: () => { invalidated++; }, engines, count: () => invalidated };
}

/** Wait for the flow to emit a `done` event, collecting everything on the way. */
function collect(flows: LoginFlows, flowId: string): Promise<FlowEvent[]> {
  return new Promise((resolve) => {
    const seen: FlowEvent[] = [];
    flows.subscribe(flowId, (event) => {
      seen.push(event);
      if (event.type === "done") resolve(seen);
    });
  });
}

describe("LoginFlows", () => {
  it("parses the verification URL and code out of the CLI output", async () => {
    const flows = new LoginFlows(probe(true), {
      login: {
        claude: [
          "sh",
          "-c",
          "echo 'Open https://claude.ai/oauth/authorize?x=1 in your browser'; echo 'code: ABCD-EFGH'",
        ],
      },
    });
    const id = await flows.start("claude");
    const events = await collect(flows, id);

    expect(events.find((e) => e.type === "url")).toEqual({
      type: "url",
      url: "https://claude.ai/oauth/authorize?x=1",
    });
    expect(events.find((e) => e.type === "code")).toEqual({ type: "code", code: "ABCD-EFGH" });
    const done = events.find((e) => e.type === "done");
    expect(done).toMatchObject({ type: "done", exitCode: 0, auth: true });
  });

  it("replays buffered events to a browser that subscribes late", async () => {
    const flows = new LoginFlows(probe(false), {
      login: { claude: ["sh", "-c", "echo 'go to https://example.test/device'"] },
    });
    const id = await flows.start("claude");
    await collect(flows, id);

    const replayed: FlowEvent[] = [];
    flows.subscribe(id, (event) => replayed.push(event));
    expect(replayed.some((e) => e.type === "url")).toBe(true);
    expect(replayed.at(-1)).toMatchObject({ type: "done", auth: false });
  });

  it("cancels a flow the user walked away from", async () => {
    const flows = new LoginFlows(probe(true), {
      login: { claude: ["sh", "-c", "echo 'https://example.test/wait'; sleep 60"] },
    });
    const id = await flows.start("claude");
    const finished = collect(flows, id);
    expect(flows.cancel(id)).toBe(true);
    const events = await finished;
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(flows.get(id)?.finished).toBe(true);
    // A second cancel is a no-op rather than an error.
    expect(flows.cancel(id)).toBe(false);
  });

  it("hands the API key to the CLI on stdin, never in argv", async () => {
    const flows = new LoginFlows(probe(true), {
      key: { claude: ["sh", "-c", "read value; test \"$value\" = 'sk-secret-value'"] },
    });
    const result = await flows.storeApiKey("claude", "  sk-secret-value  ");
    expect(result.exitCode).toBe(0);
    expect(result.auth).toBe(true);
  });

  it("reports a CLI that refuses the key instead of guessing", async () => {
    const flows = new LoginFlows(probe(false), {
      key: { claude: ["sh", "-c", "cat >/dev/null; echo 'unrecognised option --api-key' >&2; exit 2"] },
    });
    const result = await flows.storeApiKey("claude", "sk-whatever");
    expect(result.exitCode).toBe(2);
    expect(result.auth).toBe(false);
    expect(result.output).toContain("unrecognised option");
  });

  it("refuses to subscribe to a flow that does not exist", () => {
    const flows = new LoginFlows(probe(true));
    expect(() => flows.subscribe("nope", () => {})).toThrow(/unknown login flow/);
  });
});
