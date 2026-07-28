/**
 * Making a dev server reachable from the user's browser (PV-04, DESIGN §21.3).
 *
 * Vite, `next dev` and `python -m http.server` all bind `localhost` by default. Inside a container
 * that is the container's own loopback, so publishing the port changes nothing and the browser
 * gets a connection reset — the failure that looks like Docker being broken and is not. And most
 * of them will happily move to another port when the one they were given is busy, which lands them
 * outside the published pool and produces the same symptom for a different reason.
 *
 * So the command is rewritten before it runs: bind `0.0.0.0`, take the port that was allocated, and
 * fail rather than wander. What was rewritten is recorded on the preview row, because a command the
 * system changed must be visible to whoever wrote the original.
 *
 * **The failure that rewrote this module (2026-07-28).** `npm run dev --host 0.0.0.0 --port 5170
 * --strictPort` looks right and is not: npm keeps those flags for itself, and the script ran as
 * `vite 0.0.0.0 5170`. Vite ignored both, bound `localhost:5173`, and the panel offered a link to
 * port 5170 where nothing was listening. Two lessons, both implemented here:
 *
 * 1. **A package script needs `--`.** Flags for the script go after it, or they never arrive.
 * 2. **Never add a flag to a program you have not identified.** Behind `npm run dev` there may be
 *    vite, next, a plain node server or anything else. Once the flags actually reach it, guessing
 *    stops being harmless: an unknown flag is now a crash instead of a silent no-op. So the script
 *    body is read from package.json and only the flags of the program it names are added; anything
 *    unrecognised is left alone and steered with `PORT`/`HOST`, which the manager already sets.
 */

export type Normalisation = {
  /** The command as it will actually run. */
  command: string;
  /** What was changed and why, one clause each; empty when the command was left alone. */
  notes: string[];
};

export type NormaliseOptions = {
  /** `package.json` scripts, so `npm run dev` can be resolved to the program it runs. */
  scripts?: Record<string, string>;
};

/** Package runners, and whether flags for the script have to cross a `--`. */
const RUNNERS: { re: RegExp; separator: boolean }[] = [
  { re: /^npm\s+run(?:-script)?\s+([\w:.-]+)/, separator: true },
  { re: /^npm\s+(start|test)\b/, separator: true },
  { re: /^pnpm\s+run\s+([\w:.-]+)/, separator: true },
  { re: /^pnpm\s+([\w:.-]+)/, separator: true },
  // yarn forwards trailing arguments to the script in both v1 and berry, and v1 warns about `--`.
  { re: /^yarn\s+(?:run\s+)?([\w:.-]+)/, separator: false },
  { re: /^bun\s+run\s+([\w:.-]+)/, separator: true },
];

type Resolved = {
  /** The script name, when the command runs one. */
  script?: string;
  /** The text of that script, when package.json had it. */
  body?: string;
  /** Whether appended flags need a `--` in front of them. */
  separator: boolean;
};

function resolveRunner(command: string, scripts: Record<string, string>): Resolved {
  for (const runner of RUNNERS) {
    const match = runner.re.exec(command);
    if (!match) continue;
    const script = match[1]!;
    const body = scripts[script];
    return { script, separator: runner.separator, ...(body ? { body } : {}) };
  }
  return { separator: false };
}

/** Does the text say what to bind to? Then it was deliberate and is left alone. */
function hasHost(text: string): boolean {
  return /(^|\s)(--host\b|--host=|-H\b|--hostname\b|--bind\b|-b\s+\d)/.test(text);
}

function hasPort(text: string): boolean {
  return /(^|\s)(--port\b|--port=|-p\s+\d)/.test(text);
}

/**
 * The program that will actually listen. `unknown` is not a failure: it is the honest answer for
 * `node server.js`, and it means "add nothing, use the environment".
 */
export type PreviewFamily = "vite" | "next" | "http.server" | "lo-serve" | "unknown";

export function familyOf(text: string): PreviewFamily {
  if (/\bserve\.js\b/.test(text)) return "lo-serve";
  if (/\bvite\b/.test(text)) return "vite";
  if (/\bnext\s+(dev|start)\b/.test(text)) return "next";
  if (/python3?\s+-m\s+http\.server\b/.test(text)) return "http.server";
  return "unknown";
}

/**
 * Rewrite `command` to listen on `0.0.0.0:<port>` and not move.
 *
 * The port is forced even when the caller named one: it was allocated, and a preview on an
 * unpublished port is a link that cannot work.
 */
export function normalisePreviewCommand(
  command: string,
  port: number,
  options: NormaliseOptions = {},
): Normalisation {
  const notes: string[] = [];
  const out = command.trim();
  const runner = resolveRunner(out, options.scripts ?? {});
  // What the flags have to satisfy: the script's own text when there is one, otherwise the command.
  const target = runner.body ?? out;
  const family = familyOf(target);

  // `python -m http.server [port] [--bind addr]` takes its port positionally, so it is rewritten
  // in place rather than by appending — and only when it is the command itself. Behind a package
  // script there is nothing to rewrite, and it falls through to the environment.
  if (family === "http.server" && !runner.script) {
    let rewritten = out;
    if (!/--bind\b/.test(rewritten)) {
      rewritten += " --bind 0.0.0.0";
      notes.push("added --bind 0.0.0.0: a server on the container's localhost is unreachable");
    }
    if (!/http\.server\s+\d+/.test(rewritten)) {
      rewritten = rewritten.replace(/(http\.server)(\s|$)/, `$1 ${port} `).trimEnd();
      notes.push(`set the port to ${port}, the one published for this preview`);
    }
    return { command: rewritten, notes };
  }

  const flags: string[] = [];
  if (family === "unknown") {
    // The lesson of the 2026-07-28 failure. PORT and HOST are set for the process by the manager,
    // and most servers read them; a flag invented for a program nobody identified is a crash.
    notes.push(
      runner.script
        ? `left the command alone: package.json's "${runner.script}" script runs something this ` +
            "system does not recognise, so PORT and HOST are set for it instead of flags it may " +
            "not accept — if it does not listen on " +
            `${port}, make the script read PORT, or start the preview with an explicit command`
        : "left the command alone: it is not a server this system recognises, so PORT and HOST " +
            "are set for it instead of flags it may not accept",
    );
    return { command: out, notes };
  }

  if (!hasHost(target) && !hasHost(out)) {
    flags.push(family === "next" ? "--hostname 0.0.0.0" : "--host 0.0.0.0");
    notes.push("added a host of 0.0.0.0: a server on the container's localhost is unreachable");
  }
  if (!hasPort(target) && !hasPort(out)) {
    flags.push(`--port ${port}`);
    notes.push(`set the port to ${port}, the one published for this preview`);
  }
  // Only vite has it. On anything else it is an immediate crash, which is worse than the problem
  // it prevents — and `lo-serve` and `next` do not move ports in the first place.
  if (family === "vite" && !/--strictPort\b/.test(target) && !/--strictPort\b/.test(out)) {
    flags.push("--strictPort");
    notes.push("added --strictPort: moving to another port would leave the published one dead");
  }

  if (flags.length === 0) return { command: out, notes };

  // The separator, and the reason this module exists: without it npm keeps the flags and the
  // script never sees them. Not added twice if the caller already wrote one.
  const needsSeparator = runner.separator && !/(^|\s)--(\s|$)/.test(out);
  const joined = flags.join(" ");
  if (needsSeparator) {
    notes.push(`passed them after -- so ${runner.script ? `the "${runner.script}" script` : "the script"} receives them rather than the package manager`);
    return { command: `${out} -- ${joined}`, notes };
  }
  return { command: `${out} ${joined}`, notes };
}
