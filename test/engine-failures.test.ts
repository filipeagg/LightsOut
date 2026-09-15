/**
 * Telling engine failures apart (§6.9, §11.3b).
 *
 * The regression these exist for: three runs died on *"Failed to refresh OAuth token: another
 * Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in
 * a minute"*, and all three were recorded as a plain `error`. The task was blamed, the chain
 * paused, and the one instruction in the message — wait a minute — was the only thing nobody did.
 *
 * The ordering test is the important one. That sentence talks about OAuth tokens and signing in,
 * so the auth patterns match it happily; read that way it becomes "reconnect the engine", which
 * sends a person to a login page for a credential that was never broken.
 */
import { describe, expect, it } from "vitest";
import { classifyFailure, isAuthFailure, retryAfterMs, isRetryable } from "../src/acp/failures.js";
import { EngineStartGate } from "../src/acp/engine-gate.js";
import { HealthProbe } from "../src/health.js";
import { loadConfig } from "../src/config.js";

const REFRESH_LOCK =
  "Internal error: Failed to refresh OAuth token: another Claude Code process is refreshing it " +
  "or exited mid-refresh. This is usually transient; retry in a minute.";

describe("classifyFailure", () => {
  it("reads the refresh-lock message as transient, not as a dead credential", () => {
    expect(classifyFailure(REFRESH_LOCK)).toBe("transient");
    expect(isAuthFailure(REFRESH_LOCK)).toBe(false);
    expect(isRetryable(classifyFailure(REFRESH_LOCK))).toBe(true);
  });

  it("still recognises the auth failures both engines actually produce", () => {
    const real = [
      "Internal error: Failed to authenticate. API Error: 401 OAuth access token has expired.",
      "API Error: 401 Unauthorized",
      "authentication_error: invalid x-api-key",
      "Not logged in. Run `codex login`.",
      "OAuth token invalid",
    ];
    for (const message of real) expect(classifyFailure(message), message).toBe("auth");
  });

  it("separates an account with no credit from one that is not connected", () => {
    const broke = [
      "Your credit balance is too low to access the Anthropic API.",
      "429 You exceeded your current quota, please check your plan and billing details.",
      "insufficient_quota: you are out of credits",
    ];
    for (const message of broke) expect(classifyFailure(message), message).toBe("no_credit");
  });

  it("recognises a rate limit and obeys the delay the provider named", () => {
    expect(classifyFailure("API Error: 429 rate_limit_error")).toBe("rate_limited");
    expect(retryAfterMs("rate limited; try again in 30 seconds")).toBe(30_000);
    expect(retryAfterMs("retry-after: 120")).toBe(120_000);
    expect(retryAfterMs(REFRESH_LOCK)).toBe(60_000);
    expect(retryAfterMs("something went wrong")).toBeUndefined();
  });

  it("leaves an ordinary failure alone, which is what keeps retries bounded", () => {
    const ordinary = [
      "verify command failed: npm test exited 1",
      "ENOENT: no such file or directory, open 'src/missing.ts'",
      "the agent refused to write the file",
    ];
    for (const message of ordinary) expect(classifyFailure(message), message).toBe("error");
    expect(classifyFailure("")).toBe("error");
  });
});

describe("provider state (§11.3b)", () => {
  const config = loadConfig({ LO_DB: "/tmp/none.db", LO_WORKSPACE: "/tmp" });

  it("keeps an engine with no credit authenticated, and says so separately", async () => {
    const probe = new HealthProbe(config, "test", { OPENAI_API_KEY: "sk-test-key" });
    probe.noteFailure("codex", "no_credit", "NO_CREDIT: credit balance is too low");

    const codex = (await probe.engines(true)).find((e) => e.engine === "codex");
    // The credential is fine. Reporting this as "not connected" sends the operator to a login
    // page to fix a billing problem, which is the whole reason the two are now different fields.
    expect(codex?.auth).toBe(true);
    expect(codex?.state).toBe("no_credit");
    expect(codex?.stateDetail).toContain("credit balance is too low");
    expect(codex?.authError).toBeUndefined();
  });

  it("is degraded while a provider has nothing left to spend", async () => {
    const probe = new HealthProbe(config, "test", { OPENAI_API_KEY: "sk-test-key" });
    probe.noteFailure("codex", "no_credit", "no credit");
    expect((await probe.snapshot(true)).status).toBe("degraded");
  });

  it("carries the moment the provider asked to be tried again", async () => {
    const probe = new HealthProbe(config, "test", { OPENAI_API_KEY: "sk-test-key" });
    probe.noteFailure("codex", "rate_limited", "429", 60_000);

    const codex = (await probe.engines(true)).find((e) => e.engine === "codex");
    expect(codex?.state).toBe("rate_limited");
    expect(Date.parse(codex?.retryAfter ?? "")).toBeGreaterThan(Date.now());
  });

  it("says `unknown` until a run has proved the provider works, and `ok` after one", async () => {
    const probe = new HealthProbe(config, "test", { OPENAI_API_KEY: "sk-test-key" });
    const before = (await probe.engines(true)).find((e) => e.engine === "codex");
    expect(before?.state).toBe("unknown");

    probe.clearAuthFailure("codex");
    const after = (await probe.engines(true)).find((e) => e.engine === "codex");
    expect(after?.state).toBe("ok");
    expect(after?.stateSince).toBeTruthy();
  });

  it("a dead credential is still the one state that clears `auth`", async () => {
    const probe = new HealthProbe(config, "test", { OPENAI_API_KEY: "sk-test-key" });
    probe.noteAuthFailure("codex", "AUTH_REQUIRED: token expired");

    const codex = (await probe.engines(true)).find((e) => e.engine === "codex");
    expect(codex?.auth).toBe(false);
    expect(codex?.state).toBe("auth_required");
    expect(codex?.authError).toContain("token expired");
  });
});

describe("EngineStartGate (§6.9)", () => {
  it("lets one run at a time into an engine's refresh window", async () => {
    const gate = new EngineStartGate(5);
    const release = await gate.enter("claude");

    let secondEntered = false;
    const second = gate.enter("claude").then((leave) => {
      secondEntered = true;
      leave();
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(secondEntered).toBe(false);

    release();
    await second;
    expect(secondEntered).toBe(true);
  });

  it("does not make one engine wait for the other", async () => {
    const gate = new EngineStartGate(5);
    const held = await gate.enter("claude");
    // Would hang if the gate were global rather than per engine.
    const other = await gate.enter("codex");
    other();
    held();
  });

  it("is a no-op when the stagger is switched off", async () => {
    const gate = new EngineStartGate(0);
    await gate.enter("claude");
    await gate.enter("claude");
    expect(gate.holdMs).toBe(0);
  });
});
