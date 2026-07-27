/**
 * ST-09: the engine's own sandbox is configured, not left to its defaults (§7.8).
 *
 * The regression: codex started `sandbox: read-only`, its writes failed inside the engine before
 * ACP, and the policy engine was never asked — a refusal with no audit row.
 */
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureCodexConfig,
  MANAGED_CODEX_CONFIG,
  MANAGED_MARKER,
} from "../src/setup/engine-config.js";

const home = () => mkdtemp(path.join(tmpdir(), "codex-home-"));

describe("the engine's own sandbox (ST-09)", () => {
  it("writes a config when there is none, and permits the work", async () => {
    const dir = await home();
    const result = await ensureCodexConfig(dir);
    expect(result.action).toBe("written");

    const written = await readFile(path.join(dir, "config.toml"), "utf8");
    expect(written).toContain('sandbox_mode = "workspace-write"');
    expect(written).toContain("network_access = true");
    // Not full access: the engine still refuses to write outside its working directory,
    // which is defence in depth behind PE-02.
    expect(written).not.toContain("danger-full-access");
    expect(written).toContain(MANAGED_MARKER);
  });

  it("creates the directory when the engine has never run", async () => {
    const dir = path.join(await home(), "nested", ".codex");
    const result = await ensureCodexConfig(dir);
    expect(result.action).toBe("written");
    await expect(readFile(path.join(dir, "config.toml"), "utf8")).resolves.toContain(
      "workspace-write",
    );
  });

  it("never overwrites a file a person wrote", async () => {
    const dir = await home();
    const mine = 'model = "gpt-5"\nsandbox_mode = "read-only"\n';
    await writeFile(path.join(dir, "config.toml"), mine, "utf8");

    const result = await ensureCodexConfig(dir);
    expect(result.action).toBe("kept");
    // …but says what it costs, because this is the failure that leaves no audit row.
    expect(result.reason).toContain("refuse its own writes");
    await expect(readFile(path.join(dir, "config.toml"), "utf8")).resolves.toBe(mine);
  });

  it("leaves a person's permissive config alone without warning about it", async () => {
    const dir = await home();
    await writeFile(path.join(dir, "config.toml"), 'model = "gpt-5"\n', "utf8");
    const result = await ensureCodexConfig(dir);
    expect(result.action).toBe("kept");
    expect(result.reason).not.toContain("refuse its own writes");
  });

  it("is idempotent on its own file, and refreshes an out-of-date one", async () => {
    const dir = await home();
    await ensureCodexConfig(dir);
    expect((await ensureCodexConfig(dir)).action).toBe("unchanged");

    await writeFile(
      path.join(dir, "config.toml"),
      `${MANAGED_MARKER}\nsandbox_mode = "read-only"\n`,
      "utf8",
    );
    const refreshed = await ensureCodexConfig(dir);
    expect(refreshed.action).toBe("written");
    await expect(readFile(path.join(dir, "config.toml"), "utf8")).resolves.toBe(
      MANAGED_CODEX_CONFIG,
    );
  });

  it("does not disturb the rest of the engine's home", async () => {
    const dir = await home();
    await mkdir(path.join(dir, "sessions"), { recursive: true });
    await writeFile(path.join(dir, "auth.json"), '{"token":"x"}', "utf8");
    await ensureCodexConfig(dir);
    await expect(readFile(path.join(dir, "auth.json"), "utf8")).resolves.toBe('{"token":"x"}');
  });
});
