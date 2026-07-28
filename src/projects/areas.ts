/**
 * Declaring and resolving read-only workspace areas (PE-09, DESIGN §9.5).
 *
 * An area widens what a project may read, so every rule about what cannot be one lives here, in
 * one function, and is tested. None of it is overridable by a policy pack: an area is a grant of
 * *read*, inside the workspace, and never over the system's own configuration, the curated
 * knowledge, or another project.
 */
import { statSync } from "node:fs";
import path from "node:path";

export type AreaTarget = {
  /** Workspace-relative, forward slashes, no trailing separator. */
  relative: string;
  /** Absolute inside the container. */
  absolute: string;
};

/** Directories an area may never name, whatever anyone asks for. */
export const FORBIDDEN_AREA_ROOTS = ["agents", "templates", "knowledge"];
export const FORBIDDEN_AREA_FILES = ["vault.yaml"];

function normalise(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .replace(/^\.\//, "");
}

/**
 * Turn what someone typed into an area, or refuse it with the reason. Accepts a
 * workspace-relative path or an absolute container path under the workspace; `projectPath` is the
 * project's own directory, which is what makes "another project" detectable.
 */
export function validateArea(
  workspace: string,
  projectPath: string,
  input: string,
  options: { exists?: (absolute: string) => boolean } = {},
): AreaTarget {
  const raw = normalise(input);
  if (!raw) throw new Error("give a path inside the workspace");

  const root = path.resolve(workspace);
  const absolute = raw.startsWith("/")
    ? path.resolve(raw)
    : path.resolve(root, raw);

  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new Error(`an area must be inside the workspace: ${input}`);
  }
  if (absolute === root) {
    throw new Error("the whole workspace is not an area: name a directory inside it");
  }

  const relative = path.relative(root, absolute).split(path.sep).join("/");
  const [first, ...rest] = relative.split("/");

  if (FORBIDDEN_AREA_FILES.includes(relative)) {
    throw new Error(`${relative} is the credentials vault and can never be an area (PE-09)`);
  }
  if (first && FORBIDDEN_AREA_ROOTS.includes(first)) {
    const why =
      first === "knowledge"
        ? "attach a knowledge base instead (KB-03)"
        : "an agent may not read the system that runs it";
    throw new Error(`${first}/ can never be an area: ${why}`);
  }
  if (first === "projects") {
    const ownRelative = path
      .relative(root, path.resolve(projectPath))
      .split(path.sep)
      .join("/");
    const own = ownRelative === relative || relative.startsWith(`${ownRelative}/`);
    if (!own) {
      throw new Error(
        `${relative} belongs to another project: one project is not a source of truth for another (PE-09)`,
      );
    }
    // The project's own directory needs no area; saying so is clearer than accepting a no-op.
    throw new Error("this project's own directory is already readable; an area is for elsewhere");
  }
  if (rest.length === 0 && !first) {
    throw new Error(`invalid area: ${input}`);
  }

  // A directory or a single file: the material a project is pointed at is sometimes one archive
  // (`sources/acme_django-master.zip` on this machine), and naming the parent directory to reach
  // it would grant more than was meant.
  const exists =
    options.exists ??
    ((target: string) => {
      try {
        const info = statSync(target);
        return info.isDirectory() || info.isFile();
      } catch {
        return false;
      }
    });
  if (!exists(absolute)) {
    throw new Error(`no such file or directory in the workspace: ${relative}`);
  }

  return { relative, absolute };
}

/** The absolute paths of a project's areas, for the classifier (§7.1). */
export function areaPaths(workspace: string, relatives: string[]): string[] {
  return relatives.map((relative) => path.resolve(workspace, relative));
}
