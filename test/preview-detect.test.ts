/**
 * PV-07: preview takes no arguments, because the person pressing it does not know the command.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectPreview, isPreviewPlan, LO_SERVE } from "../src/preview/detect.js";

const project = () => mkdtemp(path.join(tmpdir(), "preview-detect-"));
const page = "<!doctype html><title>x</title>";

const plan = (result: ReturnType<typeof detectPreview>) => {
  if (!isPreviewPlan(result)) throw new Error(`expected a plan, got: ${result.reason}`);
  return result;
};

describe("what to serve, when nobody said (PV-07)", () => {
  it("serves a single page at the root — the prototype case", async () => {
    const dir = await project();
    await writeFile(path.join(dir, "index.html"), page, "utf8");

    const chosen = plan(detectPreview(dir));
    expect(chosen.kind).toBe("static");
    expect(chosen.command).toBe(`${LO_SERVE} --root .`);
    // The reason is shown to a person, so it has to read as a sentence.
    expect(chosen.reason).toContain("index.html");
  });

  it("prefers the project's own dev script to anything it can infer", async () => {
    const dir = await project();
    await writeFile(path.join(dir, "index.html"), page, "utf8");
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { dev: "vite", build: "vite build" } }),
      "utf8",
    );
    expect(plan(detectPreview(dir)).command).toBe("npm run dev");
  });

  it("prefers a built directory to the source at the root", async () => {
    const dir = await project();
    await writeFile(path.join(dir, "index.html"), page, "utf8");
    await mkdir(path.join(dir, "dist"));
    await writeFile(path.join(dir, "dist", "index.html"), page, "utf8");

    const chosen = plan(detectPreview(dir));
    expect(chosen.kind).toBe("build");
    expect(chosen.command).toBe(`${LO_SERVE} --root dist`);
  });

  it("takes the scripts in order of how likely they are to be a preview", async () => {
    const dir = await project();
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { start: "node server.js", serve: "http-server" } }),
      "utf8",
    );
    expect(plan(detectPreview(dir)).command).toBe("npm run serve");
  });

  it("is not derailed by a package.json it cannot parse", async () => {
    const dir = await project();
    await writeFile(path.join(dir, "package.json"), "{ not json", "utf8");
    await writeFile(path.join(dir, "index.html"), page, "utf8");
    expect(plan(detectPreview(dir)).kind).toBe("static");
  });

  it("prefers src/index.html, which is where PM-11 says the code lives", async () => {
    const dir = await project();
    await mkdir(path.join(dir, "src"));
    await writeFile(path.join(dir, "src", "index.html"), page, "utf8");

    const chosen = plan(detectPreview(dir));
    expect(chosen.command).toBe(`${LO_SERVE} --root src`);
    expect(chosen.reason).toContain("src/index.html");
  });

  it("serves a differently named page when it is the only one, and says to rename it", async () => {
    // The real case: a working 1912-line prototype at doc/acme_prototipo.html that nobody
    // could open. Refusing over a naming convention helps no one.
    const dir = await project();
    await mkdir(path.join(dir, "doc"));
    await writeFile(path.join(dir, "doc", "acme_prototipo.html"), page, "utf8");

    const chosen = plan(detectPreview(dir));
    expect(chosen.command).toBe(`${LO_SERVE} --root doc`);
    expect(chosen.reason).toContain("acme_prototipo.html");
    expect(chosen.reason).toContain("index.html");
    expect(chosen.reason).toContain("src/");
  });

  it("does not guess when a directory holds several pages", async () => {
    const dir = await project();
    await mkdir(path.join(dir, "src"));
    await writeFile(path.join(dir, "src", "a.html"), page, "utf8");
    await writeFile(path.join(dir, "src", "b.html"), page, "utf8");
    expect(isPreviewPlan(detectPreview(dir))).toBe(false);
  });

  it("refuses with what it looked for, not with a shrug", async () => {
    const dir = await project();
    const result = detectPreview(dir);
    expect(isPreviewPlan(result)).toBe(false);
    if (isPreviewPlan(result)) return;
    // A refusal a person can act on names the places that were checked.
    expect(result.reason).toContain("package.json");
    expect(result.reason).toContain("dist");
    expect(result.reason).toContain("project root");
    expect(result.reason).toContain("src/index.html");
  });

  it("never throws on a directory that is not there", () => {
    expect(() => detectPreview("/nowhere/at/all")).not.toThrow();
    expect(isPreviewPlan(detectPreview("/nowhere/at/all"))).toBe(false);
  });
});
