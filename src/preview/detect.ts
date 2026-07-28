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
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

/** The project's own scripts. Exported: normalisation needs to know what `npm run dev` runs. */
export function packageScripts(projectPath: string): Record<string, string> {
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

  // PM-11: `src/` is where the code goes, so `src/index.html` is the prototype case. Checked
  // before the root, because a project with both has its source in one and something incidental
  // in the other.
  for (const dir of ["src", "."]) {
    if (existsSync(path.join(projectPath, dir, "index.html"))) {
      return {
        kind: "static",
        command: `${LO_SERVE} --root ${dir}`,
        reason:
          dir === "src"
            ? "src/index.html is the project's page, so src/ is served as a static site"
            : "index.html sits at the root of the project, so the project is served as a static site",
      };
    }
  }

  // Last resort, and the reason it exists: a page called something else. An agent that wrote
  // `efemis_prototipo.html` produced a working prototype nobody could open, and refusing to serve
  // it over a naming convention helps no one — as long as there is exactly one candidate and no
  // guessing involved. Said out loud, so the next page gets called index.html.
  for (const dir of ["src", ".", ...BUILD_DIRS, "doc"]) {
    const pages = htmlPagesIn(path.join(projectPath, dir));
    if (pages.length !== 1) continue;
    return {
      kind: "static",
      command: `${LO_SERVE} --root ${dir}`,
      reason:
        `${dir === "." ? "" : `${dir}/`}${pages[0]} is the only page in ` +
        `${dir === "." ? "the project root" : `${dir}/`}, so it is served from there. ` +
        `Name it index.html and it will be found without this guess` +
        (dir === "doc" ? "; doc/ is for documents, code belongs in src/ (PM-11)" : ""),
    };
  }

  return {
    reason:
      "nothing to preview: no dev, serve, preview or start script in package.json, and no " +
      `index.html in src/, the project root or ${BUILD_DIRS.join(", ")}. Put the page at ` +
      "src/index.html, or start the preview with an explicit command.",
  };
}

/** The .html files directly inside one directory; [] when it is missing or unreadable. */
function htmlPagesIn(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".html"))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export function isPreviewPlan(value: PreviewPlan | DetectFailure): value is PreviewPlan {
  return "command" in value;
}
