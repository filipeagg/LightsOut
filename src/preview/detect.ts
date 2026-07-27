/**
 * What to serve, when nobody said (PV-07, DESIGN §21.5).
 *
 * The Preview card used to be an empty text box with `npm run dev` as its placeholder and two
 * sentences about why a dev server run in an agent's terminal would hang the run. Every word of
 * that was true and none of it was the user's problem: the person this system is for does not
 * write code, and wanted one button and a link.
 *
 * So the command becomes optional and this module answers the question instead. It only ever
 * proposes; the caller may still pass a command and is then obeyed.
 *
 * The order matters and is deliberate. A `dev` script is what the project's own author said to
 * run, so it wins. A built directory is a finished artefact and beats the source that produced
 * it. A single page at the root is the prototype case — and it is last, because a repository with
 * both `index.html` and a build is almost never asking for the raw file.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Where `lo-serve` lives in the image: no dependencies, permissive CORS, honest 404s (§21.4). */
export const LO_SERVE = "node /opt/lightsout/dist/preview/serve.js";

export type PreviewPlan = {
  command: string;
  /** One sentence a person can read, saying what was chosen and why. */
  reason: string;
  /** `script` | `build` | `static` — for the audit row and the panel. */
  kind: "script" | "build" | "static";
};

export type DetectFailure = {
  /** Why nothing could be chosen, naming what was looked for. */
  reason: string;
};

/** Directories a finished front end usually lands in, best first. */
const BUILD_DIRS = ["dist", "build", "out", "public", "_site", "site"];

/** Scripts worth serving, best first. `start` is last: it is often a server, not a preview. */
const DEV_SCRIPTS = ["dev", "serve", "preview", "start"];

function packageScripts(projectPath: string): Record<string, string> {
  const file = path.join(projectPath, "package.json");
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  } catch {
    // A package.json we cannot read is not a reason to fail: fall through to the other clues.
    return {};
  }
}

/**
 * Decide what to serve for this project, or say what was looked for and not found.
 *
 * Never throws: an unreadable project produces a refusal a person can act on, not a stack trace.
 */
export function detectPreview(projectPath: string): PreviewPlan | DetectFailure {
  const scripts = packageScripts(projectPath);
  for (const name of DEV_SCRIPTS) {
    if (scripts[name]) {
      return {
        kind: "script",
        command: `npm run ${name}`,
        reason: `package.json declares a "${name}" script, so that is what this project says to run`,
      };
    }
  }

  for (const dir of BUILD_DIRS) {
    if (existsSync(path.join(projectPath, dir, "index.html"))) {
      return {
        kind: "build",
        command: `${LO_SERVE} --root ${dir}`,
        reason: `${dir}/index.html exists, so the built page is served as it is`,
      };
    }
  }

  if (existsSync(path.join(projectPath, "index.html"))) {
    return {
      kind: "static",
      command: `${LO_SERVE} --root .`,
      reason: "index.html sits at the root of the project, so the project is served as a static site",
    };
  }

  return {
    reason:
      "nothing to preview: no dev, serve, preview or start script in package.json, no index.html " +
      `in ${BUILD_DIRS.join(", ")}, and no index.html at the root of the project. Build the page ` +
      "first, or start the preview with an explicit command.",
  };
}

export function isPreviewPlan(value: PreviewPlan | DetectFailure): value is PreviewPlan {
  return "command" in value;
}
