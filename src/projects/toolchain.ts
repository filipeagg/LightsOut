/**
 * A project's durable development environment (ST-07, ST-08, DESIGN §7.6).
 *
 * The gap this fills: `.lightsout/tmp/deps` is swept when the run ends (PE-08), and a real install
 * into the image is a rebuild nobody inside the container can do. A project that needs a framework
 * therefore had no answer at all. `/toolchains/<project>` is the third place — it outlives the run,
 * it belongs to exactly one project, and writing into it needs the user's authorisation once.
 *
 * It is a managed volume rather than a folder in the workspace on purpose (RT-02): the workspace is
 * the user's own directory, and build output the size of `node_modules` does not belong next to
 * their source.
 */
import path from "node:path";
import { mkdir } from "node:fs/promises";

/** Where the volume is mounted inside the container. Compose and the Dockerfile agree on this. */
export const TOOLCHAINS_ROOT = "/toolchains";

/**
 * The package managers an authorisation can be given for. One grant per manager rather than one
 * blanket grant: allowing `npm` for a web project is not allowing `apt`, and `apt` is not on this
 * list at all — it needs root and goes down the ST-08 path instead.
 */
export const TOOLCHAIN_MANAGERS = ["npm", "pnpm", "yarn", "bun", "pip", "uv", "poetry", "cargo", "go"] as const;
export type ToolchainManager = (typeof TOOLCHAIN_MANAGERS)[number];

export function isToolchainManager(value: string): value is ToolchainManager {
  return (TOOLCHAIN_MANAGERS as readonly string[]).includes(value);
}

/** Managers that cannot be granted here because they need root; ST-08 handles these. */
export const ROOT_MANAGERS = ["apt", "apt-get", "dpkg", "brew", "yum", "dnf", "apk"] as const;

export function isRootManager(value: string): boolean {
  return (ROOT_MANAGERS as readonly string[]).includes(value);
}

/** This project's toolchain directory. One per project id, never shared, never nested. */
export function toolchainRoot(projectId: string, root = TOOLCHAINS_ROOT): string {
  return path.join(root, projectId);
}

/**
 * Create it, with the sub-directories the environment below points at. Called at scaffold and again
 * before every run, because a volume can be recreated under a project that already exists.
 */
export async function ensureToolchain(projectId: string, root = TOOLCHAINS_ROOT): Promise<string> {
  const dir = toolchainRoot(projectId, root);
  for (const sub of ["bin", "lib", "py", "node_modules/.bin"]) {
    await mkdir(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

/**
 * The environment that makes an installed tool findable without the agent knowing any of this.
 * A toolchain the agent has to be told how to use is a toolchain it will not use.
 */
export function toolchainEnv(
  projectId: string,
  base: { PATH?: string | undefined; PYTHONPATH?: string | undefined },
  root = TOOLCHAINS_ROOT,
): Record<string, string> {
  const dir = toolchainRoot(projectId, root);
  const bin = [path.join(dir, "bin"), path.join(dir, "node_modules", ".bin")];
  return {
    PATH: [...bin, base.PATH ?? ""].filter(Boolean).join(":"),
    NODE_PATH: path.join(dir, "node_modules"),
    PYTHONPATH: [path.join(dir, "py"), base.PYTHONPATH ?? ""].filter(Boolean).join(":"),
    npm_config_prefix: dir,
    LO_TOOLCHAIN: dir,
  };
}

/**
 * Which package manager a command is driving, or undefined when it is not an install at all.
 * Read from the first word after the wrappers have already been peeled by the classifier.
 */
export function managerOf(segment: string): string | undefined {
  // Longest alternative first: `apt` would otherwise match `apt-get` and report the wrong
  // manager, which decides whether it needs root.
  const match = segment.match(
    /^(npm|pnpm|yarn|bun|pip3?|uv|poetry|cargo|go|apt-get|apt|dpkg|brew|yum|dnf|apk)\b/i,
  );
  if (!match?.[1]) return undefined;
  const name = match[1].toLowerCase();
  return name === "pip3" ? "pip" : name;
}

/**
 * Does this install land in the project's own toolchain directory (ST-07)?
 *
 * Two ways it can: an explicit target flag pointing inside it, or an npm-family command with no
 * target at all, which follows `npm_config_prefix` and therefore lands there by construction. The
 * second case is the common one and missing it would classify an ordinary `npm install` as a
 * change to the image, which is not what happens.
 */
export function installsIntoToolchain(
  projectId: string,
  projectPath: string,
  segment: string,
  root = TOOLCHAINS_ROOT,
): boolean {
  const manager = managerOf(segment);
  if (!manager || !isToolchainManager(manager)) return false;

  const dir = toolchainRoot(projectId, root);
  const flag = segment.match(/(?:--target|--prefix|--install-dir|-t)[=\s]+("[^"]+"|'[^']+'|\S+)/i);
  const target = flag?.[1]?.replace(/^['"]|['"]$/g, "");
  if (target) {
    const resolved = path.resolve(projectPath, target);
    return resolved === dir || resolved.startsWith(dir + path.sep);
  }

  // No target: npm and friends honour npm_config_prefix, which the run's environment points at
  // the toolchain. `pip` without `--target` writes into the interpreter, which is outside the
  // workspace and stays on the hard floor — so it deliberately does not count here.
  return ["npm", "pnpm", "yarn", "bun"].includes(manager);
}

/** The machine-first request an agent writes when it needs a system package (ST-08). */
export type SystemPackageRequest = {
  manager: string;
  packages: string[];
  reason: string;
};

/**
 * The line appended to `toolchain.d/<project>.txt` on approval, and the command the user runs.
 * LightsOut never rebuilds its own image: a container that can replace its own image can replace
 * itself with a different one.
 */
export function rebuildInstruction(projectId: string): string {
  return (
    `Approved. The packages are recorded in toolchain.d/${projectId}.txt, which the image build ` +
    `reads. Apply them by running, in your own terminal, in the LightsOut folder:\n\n` +
    `    docker compose up -d --build\n\n` +
    `The run that asked stays paused until then; relaunch it afterwards.`
  );
}
