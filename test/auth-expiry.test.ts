/**
 * Auth expiry mid-run (§11.3).
 *
 * `claude auth status` reports `loggedIn: true` while the OAuth token behind it has already
 * expired — the phase 7 gate hit exactly that and reported a green engine driving a run that
 * died on a 401. So the observed failure has to win over the status command until someone
 * reconnects, and the failure has to be recognisable in whatever words the provider used.
 */
import { describe, expect, it } from "vitest";
import { isAuthFailure } from "../src/acp/session.js";
import { HealthProbe } from "../src/health.js";
import { loadConfig } from "../src/config.js";

describe("isAuthFailure", () => {
  it("recognises the shapes both engines actually produce", () => {
    const real = [
      "Internal error: Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.",
      "API Error: 401 Unauthorized",
      "authentication_error: invalid x-api-key",
      "Not logged in. Run `codex login`.",
      "OAuth token invalid",
    ];
    for (const message of real) expect(isAuthFailure(message), message).toBe(true);
  });

  it("does not mistake ordinary failures for auth problems", () => {
    const ordinary = [
      "verify command failed: npm test exited 1",
      "ENOENT: no such file or directory, open 'src/missing.ts'",
      "the adapter closed the connection",
      "500 Internal Server Error from the provider",
    ];
    for (const message of ordinary) expect(isAuthFailure(message), message).toBe(false);
  });
});

describe("HealthProbe auth failures", () => {
  const config = loadConfig({ LO_DB: "/tmp/none.db", LO_WORKSPACE: "/tmp" });

  it("reports an engine as unauthenticated once a run died on its credentials", async () => {
    const probe = new HealthProbe(config, "test", {});
    probe.noteAuthFailure("claude", "AUTH_REQUIRED: token expired");

    const claude = (await probe.engines(true)).find((e) => e.engine === "claude");
    expect(claude?.auth).toBe(false);
    expect(claude?.authSource).toBeNull();
    expect(claude?.authError).toContain("token expired");
  });

  it("only marks the engine that failed", async () => {
    const probe = new HealthProbe(config, "test", {});
    probe.noteAuthFailure("claude", "expired");

    const codex = (await probe.engines(true)).find((e) => e.engine === "codex");
    expect(codex?.authError).toBeUndefined();
  });

  it("forgets the failure once the engine is connected again", async () => {
    const probe = new HealthProbe(config, "test", { OPENAI_API_KEY: "sk-test-key" });
    probe.noteAuthFailure("codex", "expired");
    expect((await probe.engines(true)).find((e) => e.engine === "codex")?.auth).toBe(false);

    probe.clearAuthFailure("codex");
    const codex = (await probe.engines(true)).find((e) => e.engine === "codex");
    expect(codex?.auth).toBe(true);
    expect(codex?.authError).toBeUndefined();
  });
});
