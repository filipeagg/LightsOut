/**
 * Preview servers (PV-01..06, DESIGN §21).
 *
 * Three separate promises are under test. That a dev server run inline is refused with the way to
 * do it instead — the refusal is the whole remedy, so a vague one is a broken feature. That the
 * command is rewritten to bind 0.0.0.0 on the allocated port, which is the difference between a
 * page that loads and a connection reset. And that `lo-serve` will not serve a file outside its
 * root, because it listens on a published port.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Classifier } from "../src/policy/classify.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { normalisePreviewCommand } from "../src/preview/normalise.js";
import { parseArgs, resolveFile } from "../src/preview/serve.js";

const PROJECT = "/workspace/projects/portal";

function classify(command: string) {
  return new Classifier().classify({ kind: "execute", command, projectPath: PROJECT });
}

describe("the serve class (PV-05)", () => {
  it.each([
    "npm run dev",
    "pnpm dev",
    "yarn start",
    "vite",
    "npx vite --open",
    "next dev",
    "ng serve",
    "python3 -m http.server 8000",
    "npx http-server ./dist",
    "php -S localhost:8000",
    "uvicorn app:api",
  ])("classifies %s as serve", (command) => {
    expect(classify(command).class).toBe("serve");
  });

  it("does not swallow the commands that do end", () => {
    expect(classify("npm run build").class).toBe("exec_check");
    expect(classify("npm test").class).toBe("exec_check");
    expect(classify("vite build").class).not.toBe("serve");
  });
});

describe("running one inline (PV-02)", () => {
  const packs = {
    default: {
      id: "default",
      // Even a pack that allows everything cannot make this work: the run would hang.
      rules: [
        { class: "serve" as const, verdict: "allow" as const },
        { class: "exec_check" as const, verdict: "allow" as const },
      ],
      write_scopes: [],
      vault: { test_only_required: false },
      matchers: {},
    },
  };

  it("is denied, not gated: a human could otherwise approve the thing that hangs the run", () => {
    const decision = new PolicyEngine(packs).evaluate({
      kind: "execute",
      command: "npm run dev",
      projectPath: PROJECT,
    });
    expect(decision.class).toBe("serve");
    expect(decision.verdict).toBe("deny");
  });

  it("says what to do instead, which is the entire point of the refusal", () => {
    const decision = new PolicyEngine(packs).evaluate({
      kind: "execute",
      command: "vite",
      projectPath: PROJECT,
    });
    expect(decision.reason).toContain("preview_start");
    expect(decision.reason).toContain("watchdog");
  });
});

describe("normalisePreviewCommand (PV-04)", () => {
  it("binds 0.0.0.0 and takes the allocated port", () => {
    const { command, notes } = normalisePreviewCommand("npm run dev", 5171);
    expect(command).toContain("--host 0.0.0.0");
    expect(command).toContain("--port 5171");
    expect(notes.length).toBeGreaterThan(0);
  });

  it("adds --strictPort so a busy port is an error, not a move off the published range", () => {
    expect(normalisePreviewCommand("vite", 5170).command).toContain("--strictPort");
  });

  it("leaves a deliberate host alone: someone chose it", () => {
    const { command } = normalisePreviewCommand("vite --host 127.0.0.1", 5170);
    expect(command).toContain("--host 127.0.0.1");
    expect(command).not.toContain("--host 0.0.0.0");
  });

  it("handles python's positional port and --bind", () => {
    const { command } = normalisePreviewCommand("python3 -m http.server", 5172);
    expect(command).toContain("--bind 0.0.0.0");
    expect(command).toMatch(/http\.server\s+5172/);
  });

  it("does not add --strictPort to something that has never heard of it", () => {
    expect(normalisePreviewCommand("python3 -m http.server", 5172).command).not.toContain(
      "--strictPort",
    );
    expect(normalisePreviewCommand("uvicorn app:api", 5173).command).not.toContain("--strictPort");
  });
});

describe("lo-serve (§21.3)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "lo-serve-"));
  mkdirSync(path.join(root, "sub"), { recursive: true });
  writeFileSync(path.join(root, "index.html"), "<h1>hi</h1>");
  writeFileSync(path.join(root, "sub", "index.html"), "<h1>sub</h1>");

  it("serves a file and a directory's index", () => {
    expect(resolveFile(root, "/index.html")).toBe(path.join(root, "index.html"));
    expect(resolveFile(root, "/")).toBe(path.join(root, "index.html"));
    expect(resolveFile(root, "/sub")).toBe(path.join(root, "sub", "index.html"));
  });

  it("refuses to leave its root: it is listening on a published port", () => {
    expect(resolveFile(root, "/../../etc/passwd")).toBeUndefined();
    expect(resolveFile(root, "/%2e%2e/%2e%2e/etc/passwd")).toBeUndefined();
  });

  it("parses the proxy flag both ways round", () => {
    const a = parseArgs(["--root", root, "--port", "5170", "--proxy", "/api=http://x:8080"]);
    expect(a.proxies).toEqual([{ prefix: "/api", target: "http://x:8080" }]);
    const b = parseArgs(["--proxy=/api=http://x:8080", "--spa"]);
    expect(b.proxies[0]?.target).toBe("http://x:8080");
    expect(b.spa).toBe(true);
  });

  it("refuses a proxy spec with no upstream instead of half-configuring itself", () => {
    expect(() => parseArgs(["--proxy", "/api"])).toThrow(/prefix/);
  });
});
