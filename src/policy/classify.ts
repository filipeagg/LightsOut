/**
 * ACP permission request → action class (PE-01, PE-02, DESIGN §7.1).
 *
 * Inputs: the tool-call kind, the requested path, and the command string. Path escapes win
 * over everything: anything resolving outside the project directory is `outside_workspace`
 * regardless of what the command looks like (PE-02).
 */
import { openSync, readSync, closeSync, statSync } from "node:fs";
import path from "node:path";
import type { ActionClass } from "./schema.js";

/**
 * The project's scratch directory (PE-08, DESIGN §5.2b). Writes here are exempt from a pack's
 * `write_scopes`, removals here are housekeeping rather than deletions, and the orchestrator
 * empties it at the end of every run.
 */
export const SCRATCH_REL = path.join(".lightsout", "tmp");

export function scratchRoot(projectPath: string): string {
  return path.resolve(projectPath, SCRATCH_REL);
}

export type ClassifyInput = {
  /** ACP tool call kind: read, edit, delete, move, search, execute, think, fetch, other. */
  kind?: string;
  /** Tool call title. Adapters often put the literal command here. */
  title?: string;
  /** Paths touched by the request, absolute or relative to the project. */
  paths?: string[];
  /** Shell command when the request is an execution. */
  command?: string;
  /**
   * Every string that might be the command: adapters disagree on where it lives (Claude
   * Code puts the command in the tool-call title and a prose description in the content).
   * All candidates are matched and the most dangerous class wins, so a friendly description
   * can never launder a sensitive command.
   */
  commands?: string[];
  /** Absolute path of the active project. */
  projectPath: string;
  /**
   * Absolute path of the workspace root (`/workspace`). Without it the workspace-aware rules
   * of §7.1 are skipped and every path outside the project is `outside_workspace`, which is
   * the phase 3 behaviour and remains the safe default.
   */
  workspacePath?: string;
  /** Base id this project may write into, if any (KB-05). */
  writableKnowledgeBase?: string | undefined;
  /**
   * Absolute paths of the workspace directories this project may **read** (PE-09, §9.5). A read
   * inside one of them is `project_read`; a write is still `outside_workspace`, which the hard
   * floor keeps at deny.
   */
  readAreas?: string[] | undefined;
};

export type Classification = {
  class: ActionClass;
  /** Why this class was chosen, for the audit row and for doubts. */
  reason: string;
  /**
   * Project-relative paths a script body names, when the class is `script_exec` (PE-07). The
   * engine enforces `write_scopes` on them: a script cannot be a way around the confinement that
   * stops the same agent from using `sed -i`. Paths a body builds at runtime are invisible here,
   * and DESIGN §7.1 says so.
   */
  scriptPaths?: string[];
};

/** Built-in matcher table (DESIGN §7.2 ships defaults; packs extend it). */
export const DEFAULT_MATCHERS: Record<string, string[]> = {
  // Read-only inspection through the terminal. Without these, exploring a repository —
  // `ls`, `find`, `wc`, `git ls-files` — falls into `other` and stops an unattended chain on a
  // human gate for an action that changes nothing. Anything that can hide a second command
  // inside a benign-looking one is disqualified below (READ_ONLY_DISQUALIFIERS), and the
  // dangerous classes are matched first, so `cat .env` is still `credentials` and
  // `find . -delete` is still `delete`.
  project_read: [
    "^(ls|pwd|find|stat|du|df|tree|file|wc|head|tail|cat|less|more|nl|sort|uniq|cut|column)\\b",
    "^(grep|rg|ag|egrep|fgrep|diff|cmp|jq|yq|awk|sed|md5sum|sha1sum|sha256sum)\\b",
    "^(basename|dirname|realpath|readlink|which|type|whoami|date|uname|hostname|id)\\b",
    // The rest of a pipeline: text tools that read their input and write to stdout.
    "^(comm|join|paste|tr|rev|seq|fold|expand|unexpand|tac|shuf|split -n|csplit)\\b",
    "^(ps|pgrep|env|printenv|locale|nproc|free|uptime)\\b",
    "^(cd|pushd|popd|true|false|sleep)\\b",
    // A test evaluates and prints nothing: `[ -n "$X" ]`, `test -f a.txt`.
    "^(\\[\\[?|test)\\s",
    "^(echo|printf)\\b",
    "^git\\s+(ls-files|count-objects|rev-list|blame|describe|shortlog|remote|cat-file|for-each-ref|config\\s+--get)\\b",
    "^(npm|pnpm|yarn|bun)\\s+(ls|list|view|outdated|why)\\b",
    "^(node|tsc|python3?|go|cargo|git|docker)\\s+(--version|-v|version)\\b",
  ],
  // Shell writes inside the project. Without these a plain `printf 'x' > file.txt` falls into
  // `other` and stops an unattended chain on a human gate, even though writing inside the
  // project is exactly what the task asked for. Path escapes are checked first (PE-02), so
  // these patterns can only match writes that stay inside the project directory.
  project_write: [
    "^(printf|echo)\\b[^|]*>>?\\s*\\S+",
    "^(cat|tee)\\b[^|]*>>?\\s*\\S+",
    "^(touch|mkdir|cp|mv)\\b",
    "^sed\\s+-i\\b",
    "^(python3?|node)\\s+-c\\b[^|]*(open|writeFile)",
    // Capturing the output of a reading tool is a write, and a mundane one. Without this it
    // would be disqualified from `project_read` and reach a human for `ls > listing.txt`.
    "^(ls|find|wc|cat|grep|rg|awk|sort|uniq|head|tail|jq|yq|diff|stat|du|tree|xxd|od)\\b[^|]*>>?\\s*\\S",
  ],
  exec_check: [
    "^(npm|pnpm|yarn|bun) (test|run (test|build|lint|typecheck|check))\\b",
    "^(node|tsc|eslint|prettier|vitest|jest|pytest|ruff|mypy|go test|cargo (test|build|check))\\b",
    "^(make|just) (test|build|lint|check)\\b",
  ],
  deps_install: [
    "^(npm|pnpm|yarn|bun) (i|install|add|ci)\\b",
    "^(pip|pip3|uv|poetry) (install|add|sync)\\b",
    "^(apt|apt-get|brew|choco|winget) (install|add)\\b",
    "^(cargo|go) (add|get|install)\\b",
  ],
  git_push: ["^git\\s+push\\b", "^git\\s+remote\\s+(add|set-url)\\b", "^gh\\s+(pr|release)\\b"],
  git_local: [
    "^git\\s+(status|diff|log|show|add|commit|checkout|switch|branch|stash|restore|reset|tag|rev-parse|fetch|merge|rebase)\\b",
  ],
  delete: [
    "^rm\\b",
    "^rmdir\\b",
    "^find\\b.*-delete\\b",
    // `find … -exec rm` is a delete, not a search. Other `-exec` actions are disqualified from
    // `project_read` and land in `other`, so a human sees them.
    "^find\\b.*-(exec|execdir|ok)\\b.*\\b(rm|rmdir|unlink|shred|truncate)\\b",
    "^git\\s+clean\\b",
    "^truncate\\b",
  ],
  network: [
    "^(curl|wget|http|https|nc|ncat|telnet|ssh|scp|rsync)\\b",
    "\\bpip\\s+download\\b",
    "^(npx|pnpx)\\b",
  ],
  credentials: [
    // A key named outright, or a secret variable *expanded* — `$PASSWORD`, `${DB_PASSWORD}` —
    // which is a value on its way somewhere. A variable *name* mentioned as text is not:
    // `os.environ.get('LO_VAULT_EFEMIS_PASSWORD')` is an agent checking its own wiring, and
    // gating that stopped a real run dead (§7.1b). The script body check judges the code itself.
    "\\b(ANTHROPIC_API_KEY|OPENAI_API_KEY|GIT_TOKEN|GITHUB_TOKEN|AWS_SECRET)\\b",
    "[$%]\\{?[A-Za-z_][A-Za-z0-9_]*(PASSWORD|SECRET|TOKEN|API_KEY)",
    "^(printenv|env)\\b[^|]*\\b(PASSWORD|SECRET|TOKEN|API_KEY)",
    // Every reading tool, not just the obvious three: `project_read` now allows the whole
    // family, so a secret file must be sensitive whichever tool opens it.
    "(^|\\s)(cat|less|more|head|tail|grep|rg|egrep|fgrep|awk|sed|nl|cut|sort|uniq|xxd|od|strings|jq|yq|diff|cmp|base64)\\b.*(\\.env|\\.npmrc|\\.netrc|id_rsa|id_ed25519|credentials|\\.pem|\\.pfx|\\.p12)\\b",
    "^(ssh-keygen|gpg|openssl)\\b",
    "^git\\s+push\\b.*(--force|-f)(\\s|$)",
  ],
  publish_external: [
    "^npm\\s+publish\\b",
    "^(docker\\s+push|gh\\s+release\\s+create|aws\\s+s3\\s+cp|gcloud|az)\\b",
    "^(twine|cargo)\\s+publish\\b",
  ],
};

/**
 * Running code the agent supplied (PE-07). These patterns only say "this segment runs a script";
 * the class is decided by reading the code itself (SCRIPT_BODY_FAMILIES below). A segment that
 * matches here and whose body cannot be read falls to `other`, which is a human.
 */
export const SCRIPT_INTERPRETERS =
  "(python3?|python3\\.\\d+|node|bun|deno|ruby|perl|php|bash|sh|zsh|Rscript|osascript)";

/** `python3 script.py`, `node tools/x.mjs`, `bash ./x.sh`, `deno run x.ts`. */
const SCRIPT_FILE_RE = new RegExp(`^${SCRIPT_INTERPRETERS}\\s+(?:run\\s+)?(?:-[^\\s]+\\s+)*([^\\s'\"-][^\\s]*)`, "i");
/** `python3 -c '…'`, `node -e "…"`, `perl -e …`. */
const SCRIPT_INLINE_RE = new RegExp(`^${SCRIPT_INTERPRETERS}\\s+(?:-[A-Za-z]*[ce])\\b\\s*(.*)$`, "i");
/** A heredoc feeding an interpreter: `python3 - <<'EOF' … EOF`. */
const SCRIPT_HEREDOC_RE = new RegExp(`^${SCRIPT_INTERPRETERS}\\b[^\\n]*<<-?\\s*['\"]?\\w+`, "i");

/**
 * What a script body may not contain and still count as `script_exec`. The class on the right is
 * what the request gets instead, so the pack's own rule for that class decides — a body that
 * fetches over the network is judged exactly as `curl` would be.
 */
const SCRIPT_BODY_FAMILIES: [ActionClass, RegExp, string][] = [
  // A secret *file* opened, or a secret *value* printed — not the word "credentials" appearing as
  // a label, and not a variable name that happens to contain PASSWORD. `os.environ.get('LO_VAULT_
  // EFEMIS_PASSWORD')` followed by "present"/"missing" is how an agent checks its own wiring
  // before starting, and gating it stopped a run dead (§7.1b). Printing the value is the thing
  // that matters, and that still matches.
  [
    "credentials",
    /\.env\b|\.npmrc|\.netrc|id_rsa|id_ed25519|\.pem\b|\.pfx\b|\.p12\b|['"][^'"]*credentials[^'"]*['"]\s*[,)]?\s*(?:,\s*)?['"]?r?b?['"]?\s*\)|open\s*\([^)]*credentials|print\s*\(\s*(?:os\.environ|os\.getenv)|console\.log\s*\(\s*process\.env\.[A-Za-z_]|(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|GIT_TOKEN|GITHUB_TOKEN|AWS_SECRET)\b/i,
    "reads or carries credentials",
  ],
  // Dependencies before network: `pip install requests` is a dependency, and the package name
  // would otherwise read as a network library.
  [
    "deps_install",
    /\b(pip3?|uv|poetry|npm|pnpm|yarn|bun|apt|apt-get|cargo|go)\s+(install|add|sync|ci|get)\b/i,
    "installs dependencies",
  ],
  // A network library *used*, not a module name mentioned. `import requests` and
  // `requests.get(…)` reach the network; `find_spec('requests')` asks whether it is installed,
  // which is what an agent does before deciding it cannot do the job (§7.1b).
  [
    "network",
    /\b(import|from|require\s*\(|=\s*require)\s+['"]?(requests|httpx|urllib|urllib2|urllib3|http\.client|socket|paramiko|smtplib|ftplib|websocket|axios|node-fetch|node:https?|got)\b|\b(requests|httpx|urllib|axios|socket)\s*\.\s*[a-z_]+\s*\(|\bfetch\s*\(|https?:\/\//i,
    "reaches the network",
  ],
  [
    "delete",
    /\b(shutil\.rmtree|os\.remove|os\.unlink|os\.rmdir|fs\.rm|rmSync|unlinkSync|Path\([^)]*\)\.unlink)\b|\brm\s+-[rf]/i,
    "deletes files",
  ],
  [
    "other",
    /\b(subprocess|os\.system|os\.popen|os\.exec|child_process|execSync|spawnSync|Deno\.run|eval\s*\(|exec\s*\()/i,
    "runs further commands of its own",
  ],
];

/**
 * Filesystem paths inside a script body: PE-02 does not stop at the shell (§7.1c).
 *
 * Only paths that mean something to *this* filesystem count. `"/plantation/query"` is an API
 * route, and treating it as an escape denied every script that talks to an HTTP API — under the
 * hard floor, so nothing could rescue it. A URL's path is not a path.
 */
const SYSTEM_ROOTS =
  "etc|usr|bin|sbin|lib|lib64|var|root|home|proc|sys|dev|tmp|opt|data|boot|mnt|media|srv|run|workspace";

/**
 * The character devices every shell command uses. `2>/dev/null` appears in half the commands ever
 * written and damages nothing; treating it as an escape denied them all (§7.1c).
 */
const HARMLESS_DEVICES = /^\/dev\/(null|zero|stdin|stdout|stderr|tty|urandom|random|fd\/\d+)$/;

/**
 * Is this string a path *on this filesystem*, as opposed to a URL route, an API path or a word
 * with slashes? Only the real roots count. `/plantation/query` is an endpoint; `/etc/passwd` is a
 * file. Getting this wrong denied every script that talks to an HTTP API, under the hard floor
 * where nothing could rescue it.
 */
export function looksLikeFilesystemPath(value: string): boolean {
  const clean = value.trim().replace(/^['"]|['"]$/g, "");
  if (!clean) return false;
  if (HARMLESS_DEVICES.test(clean)) return false;
  if (clean.startsWith("../") || clean.includes("/../")) return true;
  if (!clean.startsWith("/")) return true; // relative: resolved against the project by the caller
  return new RegExp(`^/(?:${SYSTEM_ROOTS})(?:/|$)`).test(clean);
}
const SCRIPT_BODY_PATHS = new RegExp(
  `(^|['"\\s(])((?:/(?:${SYSTEM_ROOTS})(?:/[^\\s'")]*)?)|\\.\\./[^\\s'")]+)`,
  "g",
);

/** Everything between `http(s)://` and the next quote or space: a URL, not a filesystem path. */
const URLS = /\bhttps?:\/\/[^\s'"`)]+/g;

export type ScriptBody = { source: "file" | "inline"; target?: string; text: string };

function compile(matchers: Record<string, string[]>): Map<ActionClass, RegExp[]> {
  const compiled = new Map<ActionClass, RegExp[]>();
  for (const [cls, patterns] of Object.entries(matchers)) {
    compiled.set(
      cls as ActionClass,
      patterns.map((p) => new RegExp(p, "i")),
    );
  }
  return compiled;
}

/**
 * Order matters: the first class whose matcher hits wins, and the dangerous ones are
 * checked before the benign ones so that `git push --force` cannot pass as `git_local`.
 */
const COMMAND_ORDER: ActionClass[] = [
  "credentials",
  "publish_external",
  "delete",
  "deps_install",
  "git_push",
  "network",
  "exec_check",
  "git_local",
  "project_write",
  "project_read",
];

/**
 * What stops a read-looking segment from counting as `project_read`: a write redirect, a `find`
 * action, or a substitution that can carry a whole second command inside an argument. A
 * disqualified segment falls back to `other`, which means a human decides.
 */
const READ_ONLY_DISQUALIFIERS: RegExp[] = [
  />>?\s*\S/,
  /\s-(exec|execdir|ok|okdir|delete|fls|fprint)\b/i,
  /\$\(|`|<\(/,
];

export function disqualifiesReadOnly(segment: string): boolean {
  return READ_ONLY_DISQUALIFIERS.some((re) => re.test(segment));
}

/**
 * Remove the places where a variable is *tested* rather than used, before asking whether a command
 * touches a secret (§7.1b).
 *
 * `if [ -n "${LO_VAULT_EFEMIS_PASSWORD:-}" ]; then echo present; else echo missing; fi` expands the
 * variable and cannot leak it: the shell compares it and throws it away. An agent checking its own
 * wiring writes exactly this, and gating it stopped a run — twice, because the first fix only
 * covered the Python spelling of the same idea. What still counts as a credential read is a value
 * that goes anywhere else: `echo $TOKEN`, a header, a file, another command.
 */
export function stripPresenceTests(segment: string): string {
  return (
    segment
      // [ -n "$X" ] and [[ -z $X ]], with or without the :- default
      .replace(/\[\[?[^\]]*\]\]?/g, " ")
      // test -n "$X" / test -z $X
      .replace(/\btest\s+-[nz]\s+("[^"]*"|'[^']*'|\S+)/gi, " ")
      // ${X:+literal} expands to the literal, never to the value
      .replace(/\$\{[A-Za-z_][A-Za-z0-9_]*:\+[^}]*\}/g, " ")
  );
}

/**
 * Split a command line into the commands it actually runs, on `&&`, `||`, `|`, `;`, `&` and
 * newlines outside quotes (DESIGN §7.1). Matchers are anchored at the start of a segment, so
 * without this every chained command would be judged by its first word alone and
 * `find . && git log` would land in `other` — a human gate for nothing. It cannot launder
 * anything either: the caller keeps the most dangerous class across segments, so `curl x | sh`
 * stays `network`.
 */
export function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote) {
      current += ch;
      if (ch === quote && command[i - 1] !== "\\") quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\n" || ch === ";") {
      segments.push(current);
      current = "";
      continue;
    }
    if (ch === "&" || ch === "|") {
      if (command[i + 1] === ch) i += 1; // `&&` and `||` are one separator, not two
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);

  return segments.map(normalizeSegment).filter((s) => s.length > 0);
}

/**
 * Programs that run another program. Left in place they make every pipeline unmatched: the real
 * case was `find … | xargs wc -l`, denied as `other` because nothing knew what `xargs` was, which
 * stopped a chain for eleven minutes over counting lines. Stripping them is *safer* than listing
 * them as read-only — `xargs rm` is then classified by `rm`, as it should be.
 */
const WRAPPERS = /^(xargs|time|nice|nohup|command|stdbuf|timeout|env|ionice|setsid)\b/i;
/**
 * Shell keywords that introduce a command rather than being one. Without stripping them,
 * `if [ -n "$X" ]; then echo present; fi` is three unmatched words and a whole read-only pipeline
 * lands on a human — the second spelling of the same false positive (§7.1b).
 */
const SHELL_KEYWORDS = /^(if|then|elif|else|fi|do|done|while|until|for|case|esac|in)\s+/i;
const SHELL_KEYWORD_ONLY = /^(fi|done|esac|then|else|do)$/i;
/** Their own options, which must go with them: `xargs -0 -n1`, `timeout 30s`, `nice -n 10`. */
const WRAPPER_ARG = /^(-{1,2}[A-Za-z0-9-]+(=\S+)?|\d+[smhd]?|[A-Za-z_][A-Za-z0-9_]*=\S*)$/;

/**
 * Strip what sits between the separator and the command itself — subshell and group brackets,
 * negation, leading environment assignments and process wrappers — so `(cd x && FOO=1 npm test)`
 * is matched as `npm test` and `xargs -0 wc -l` as `wc -l`. `sudo` is deliberately left in place:
 * it is not noise.
 */
function normalizeSegment(segment: string): string {
  let out = segment.trim();
  out = out.replace(/^[({\s]+/, "").replace(/[)}\s;]+$/, "");
  out = out.replace(/^!\s*/, "");
  out = out.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "");
  // `2>/dev/null` is not a write, and leaving it in made every quiet read look like one (§7.1c).
  out = stripDevNull(out);
  // `if [ … ]`, `then echo …`, `for f in …`: the keyword is not the command being run.
  for (let guard = 0; guard < 3 && SHELL_KEYWORDS.test(out); guard += 1) {
    out = out.replace(SHELL_KEYWORDS, "").trim();
  }
  if (SHELL_KEYWORD_ONLY.test(out)) return "";

  // Peel wrappers one at a time: `time xargs -0 wc -l` is a read of files, twice removed.
  for (let guard = 0; guard < 4 && WRAPPERS.test(out); guard += 1) {
    const parts = out.split(/\s+/).slice(1);
    while (parts.length > 0 && WRAPPER_ARG.test(parts[0]!)) parts.shift();
    const inner = parts.join(" ").trim();
    if (!inner) break; // a bare `env` or `xargs` with nothing after it: leave it be
    out = inner;
  }
  return out.trim();
}

/**
 * A segment that only sets a shell variable (`R=/some/path`). It runs nothing and changes nothing
 * outside the shell, but as an unmatched word it used to drag a whole pipeline into `other`.
 */
/** `2>/dev/null` is not a write, and leaving it in made every quiet read look like one (§7.1c). */
export function stripDevNull(value: string): string {
  return value.replace(/(?:\d+|&)?>>?\s*\/dev\/(?:null|stdout|stderr)\b/g, " ").trim();
}

export function isAssignmentOnly(segment: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)$/.test(segment.trim());
}

/**
 * The paths a command **writes to**, as opposed to the ones it merely reads (PE-09). Copying out
 * of a read-only area into the project is the whole point of an area, so "this command writes
 * somewhere" is not precise enough: `cp /workspace/sources/x ./sources/x` reads the first path and
 * writes the second. Redirect targets, and the destination of the copy-shaped commands, are the
 * write targets; everything else on the line is a read.
 */
const COPY_LIKE = /^(cp|mv|rsync|install|ln|scp)\b/i;
/** Commands whose every path argument is a thing they change: removals and in-place edits. */
const CHANGES_EVERY_ARG = /^(rm|rmdir|unlink|shred|truncate|mkdir|touch|chmod|chown|tee|sed\s+-i)\b/i;

export function writeTargets(command: string): string[] {
  const targets: string[] = [];
  for (const segment of splitSegments(command)) {
    for (const match of segment.matchAll(/>>?\s*("([^"]+)"|'([^']+)'|([^\s;|&]+))/g)) {
      const target = match[2] ?? match[3] ?? match[4];
      if (target) targets.push(target);
    }
    const args = argPaths(segment);
    if (CHANGES_EVERY_ARG.test(segment)) {
      targets.push(...args);
      continue;
    }
    if (!COPY_LIKE.test(segment)) continue;
    const last = args[args.length - 1];
    if (last) targets.push(last);
  }
  return targets;
}

/**
 * Paths a shell command touches: redirect targets and absolute-looking arguments. Used to
 * enforce PE-02 on commands, where the ACP request carries no `locations`.
 */
export function pathsInCommand(command: string): string[] {
  const found: string[] = [];
  for (const match of command.matchAll(/>>?\s*("([^"]+)"|'([^']+)'|([^\s;|&]+))/g)) {
    const target = match[2] ?? match[3] ?? match[4];
    if (target) found.push(target);
  }
  // Absolute or parent-relative paths. `/` must be followed by a path character, so build
  // targets like `bazel test //...` and regex arguments are not mistaken for paths.
  for (const match of command.matchAll(
    /(^|\s)(\/[A-Za-z0-9._][^\s;|&"']*|\.\.\/[^\s;|&"']+)/g,
  )) {
    const target = match[2];
    if (target) found.push(target);
  }
  // …and only the ones that mean something to this filesystem. An API route in a comment
  // (`# GET /plantation`) and `2>/dev/null` are not paths anyone can damage (§7.1c).
  return found.filter((target) => looksLikeFilesystemPath(target));
}

/** Path-like literals in a script body: quoted relative paths that carry an extension. */
export function scriptFileCandidates(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/['"`]([A-Za-z0-9._][A-Za-z0-9._/\\-]*\.[A-Za-z0-9]{1,8})['"`]/g)) {
    const target = match[1];
    if (target) found.add(target);
  }
  return [...found];
}

/**
 * Path-like arguments of one segment: everything after the command word that is not an option.
 * Used to tell housekeeping inside the scratch directory from a real deletion (PE-08).
 */
export function argPaths(segment: string): string[] {
  return segment
    .split(/\s+/)
    .slice(1)
    .map((token) => token.replace(/^['"]|['"]$/g, ""))
    .filter((token) => token.length > 0 && !token.startsWith("-"));
}

/**
 * An install that lands in the scratch directory and dies with the run (PE-08). `deps_install` is
 * gated because a dependency changes the build environment for every later run (ST-03) — which is
 * exactly what `pip install --target .lightsout/tmp/deps` does not do. It still needs the network,
 * and that is a separate question the pack answers.
 */
export function installsIntoScratch(projectPath: string, segment: string): boolean {
  const match = segment.match(/(?:--target|--prefix|--install-dir|-t)[=\s]+("[^"]+"|'[^']+'|\S+)/i);
  const target = match?.[1]?.replace(/^['"]|['"]$/g, "");
  if (!target) return false;
  return Classifier.isInside(scratchRoot(projectPath), path.resolve(projectPath, target));
}

/** True when every path-like argument of the segment stays inside the scratch directory. */
export function confinedToScratch(projectPath: string, segment: string): boolean {
  const args = argPaths(segment);
  if (args.length === 0) return false;
  const root = scratchRoot(projectPath);
  return args.every((arg) => Classifier.isInside(root, path.resolve(projectPath, arg)));
}

/**
 * The *shape* of a command: what it does, with the particulars removed (PE-10). Paths, quoted
 * strings and numbers become placeholders; the programs, their flags and the pipeline survive.
 *
 *   `find /a/b -maxdepth 1 -name '*.py' | xargs wc -l`
 *   → `find <path> -maxdepth <n> -name <str> | xargs wc -l`
 *
 * This is what a human's "yes, allow that" is remembered as, so the same kind of command does not
 * ask again while a different one still does.
 */
export function commandShape(command: string): string {
  const segments = splitSegments(command)
    .filter((segment) => !isAssignmentOnly(segment))
    .map((segment) =>
      segment
        .replace(/"[^"]*"|'[^']*'/g, "<str>")
        .replace(/(^|\s)([~.]{0,2}\/|\$[A-Za-z_])\S*/g, "$1<path>")
        .replace(/(^|\s)\d+(\.\d+)?([smhdkKMG]B?)?(?=\s|$)/g, "$1<n>")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((segment) => segment.length > 0);
  return segments.join(" | ");
}

export class Classifier {
  private readonly table: Map<ActionClass, RegExp[]>;
  private readonly scanBytes: number;

  constructor(
    extraMatchers: Record<string, string[] | undefined> = {},
    options: { scriptScanBytes?: number } = {},
  ) {
    this.scanBytes = options.scriptScanBytes ?? 65536;
    const merged: Record<string, string[]> = { ...DEFAULT_MATCHERS };
    for (const [cls, patterns] of Object.entries(extraMatchers)) {
      if (!patterns?.length) continue;
      merged[cls] = [...(merged[cls] ?? []), ...patterns];
    }
    this.table = compile(merged);
  }

  /**
   * True when every command in a chain is read-only and none of them is disqualified. The
   * unanimity matters: `echo hi && some-unknown-tool` must not pass as a read because its first
   * word is harmless.
   */
  private isReadOnlyChain(candidate: string): boolean {
    const readOnly = this.table.get("project_read") ?? [];
    const chain = splitSegments(candidate);
    return (
      chain.length > 0 &&
      !chain.some(disqualifiesReadOnly) &&
      chain.every(
        (segment) => isAssignmentOnly(segment) || readOnly.some((re) => re.test(segment)),
      )
    );
  }

  /**
   * Whether a request modifies what it touches. Used only to tell a read of a knowledge base
   * from a write into one; a request whose intent is unclear counts as writing, so the
   * cautious branch is the default.
   */
  private looksLikeWriting(input: ClassifyInput, candidates: string[]): boolean {
    const kind = (input.kind ?? "").toLowerCase();
    if (["read", "search", "fetch_file"].includes(kind)) return false;
    if (["edit", "write", "move", "delete"].includes(kind)) return true;
    if (candidates.length === 0) return kind.length > 0;
    // A candidate that is a read-only chain end to end is a read; the segments are checked
    // individually so a chain is not judged by its first command alone.
    if (candidates.some((candidate) => this.isReadOnlyChain(candidate))) return false;
    return candidates.some((candidate) => {
      if (/>>?\s*\S/.test(candidate)) return true;
      for (const cls of ["project_write", "delete"] as ActionClass[]) {
        if ((this.table.get(cls) ?? []).some((re) => re.test(candidate))) return true;
      }
      return !/^(cat|less|more|head|tail|grep|rg|ls|find|wc|diff)\b/i.test(candidate);
    });
  }

  /**
   * Does the request write to *this particular path*? "The command writes somewhere" is not
   * precise enough once a project may read an area (PE-09): `cp <area>/x ./x` writes into the
   * project and only reads the area. A path the ACP request itself declared is judged by the tool
   * kind, as before; a path found inside a command is a write only when it is a write target.
   */
  private writesTo(input: ClassifyInput, candidates: string[], target: string): boolean {
    const declared = (input.paths ?? []).some(
      (p) => path.resolve(input.projectPath, p) === path.resolve(input.projectPath, target),
    );
    if (declared || candidates.length === 0) return this.looksLikeWriting(input, candidates);
    const resolved = path.resolve(input.projectPath, target);
    return candidates
      .flatMap((candidate) => writeTargets(candidate))
      .some((written) => path.resolve(input.projectPath, written) === resolved);
  }

  /** True when `target` resolves inside `root`. Relative paths resolve against root. */
  static isInside(root: string, target: string): boolean {
    const base = path.resolve(root);
    const resolved = path.resolve(base, target);
    return resolved === base || resolved.startsWith(base + path.sep);
  }

  /**
   * What an escaping path means (§7.1). Shared material in the workspace is not simply
   * "outside": the system's own configuration is `credentials` whatever the pack says, and a
   * knowledge base is readable by everyone but writable only by its curation project.
   */
  private classifyEscape(input: ClassifyInput, target: string, writing: boolean): Classification {
    const workspace = input.workspacePath;
    if (!workspace) {
      return { class: "outside_workspace", reason: `path outside the project: ${target}` };
    }
    const resolved = path.resolve(input.projectPath, target);

    for (const configured of ["agents", "templates"]) {
      if (Classifier.isInside(path.join(workspace, configured), resolved)) {
        return {
          class: "credentials",
          reason: `path reconfigures the system: ${target}`,
        };
      }
    }
    if (resolved === path.join(workspace, "vault.yaml")) {
      return { class: "credentials", reason: `path is the credentials vault: ${target}` };
    }

    // A directory this project was explicitly allowed to read (PE-09). Checked after the two
    // absolute prohibitions above and before anything else, so an area can never be declared over
    // the system's own configuration even if a row said so.
    for (const area of input.readAreas ?? []) {
      if (!Classifier.isInside(area, resolved)) continue;
      if (!writing) {
        return { class: "project_read", reason: `read of a declared area: ${target}` };
      }
      return {
        class: "outside_workspace",
        reason: `an area is read-only; writing to ${target} is not allowed (PE-09)`,
      };
    }

    const knowledgeRoot = path.join(workspace, "knowledge");
    if (Classifier.isInside(knowledgeRoot, resolved)) {
      if (!writing) {
        return { class: "project_read", reason: `read of curated knowledge: ${target}` };
      }
      const writable = input.writableKnowledgeBase;
      if (writable && Classifier.isInside(path.join(knowledgeRoot, writable), resolved)) {
        return { class: "knowledge_write", reason: `write into the project's base: ${target}` };
      }
      return {
        class: "outside_workspace",
        reason: `write into a knowledge base this project does not own: ${target}`,
      };
    }

    return { class: "outside_workspace", reason: `path outside the project: ${target}` };
  }

  /**
   * The code a segment is about to run, or undefined when the segment does not run a script.
   * A file is read up to `scanBytes`; a body that cannot be read comes back with empty text and
   * the caller treats that as `other` (a human), never as `script_exec`.
   */
  private scriptBody(segment: string, projectPath: string): ScriptBody | undefined {
    const inline = SCRIPT_INLINE_RE.exec(segment);
    if (inline) return { source: "inline", text: inline[2] ?? "" };
    if (SCRIPT_HEREDOC_RE.test(segment)) {
      // The heredoc body arrives in the same string when the adapter sends a multi-line command.
      const body = segment.slice(segment.indexOf("<<"));
      return { source: "inline", text: body };
    }
    const file = SCRIPT_FILE_RE.exec(segment);
    if (!file) return undefined;
    const target = file[2];
    if (!target || /^-/.test(target)) return undefined;
    // `bash -c` and friends are handled above; a bare interpreter with no file is not a script run.
    if (!/[./]/.test(target) && !/\.[A-Za-z0-9]+$/.test(target)) return undefined;

    const resolved = path.resolve(projectPath, target);
    if (!Classifier.isInside(projectPath, resolved)) {
      // Left for the escape check, which already ran; be explicit rather than reading it.
      return { source: "file", target, text: "" };
    }
    try {
      if (statSync(resolved).size > this.scanBytes) return { source: "file", target, text: "" };
      const fd = openSync(resolved, "r");
      try {
        const buffer = Buffer.alloc(this.scanBytes);
        const read = readSync(fd, buffer, 0, this.scanBytes, 0);
        return { source: "file", target, text: buffer.subarray(0, read).toString("utf8") };
      } finally {
        closeSync(fd);
      }
    } catch {
      return { source: "file", target, text: "" };
    }
  }

  /**
   * Classify a script run by its body (PE-07). An unreadable, empty or oversized body is `other`:
   * the point of the class is that the code was inspected, so "could not inspect" is a human.
   */
  private classifyScript(input: ClassifyInput, segment: string, body: ScriptBody): Classification {
    const where = body.source === "file" ? `script ${body.target}` : "inline code";
    if (!body.text.trim()) {
      return {
        class: "other",
        reason: `${where} could not be read before running it: ${segment.slice(0, 80)}`,
      };
    }

    // URLs first: their paths are not this machine's paths (§7.1c).
    const withoutUrls = body.text.replace(URLS, " ");
    for (const match of withoutUrls.matchAll(SCRIPT_BODY_PATHS)) {
      const target = match[2];
      if (!target) continue;
      if (!Classifier.isInside(input.projectPath, path.resolve(input.projectPath, target))) {
        return this.classifyEscape(input, target, true);
      }
    }

    for (const [cls, re, why] of SCRIPT_BODY_FAMILIES) {
      const hit = re.exec(body.text);
      if (hit) {
        return { class: cls, reason: `${where} ${why} (${hit[0].slice(0, 40)})` };
      }
    }

    return {
      class: "script_exec",
      reason: `${where}, body inspected and confined to the project`,
      scriptPaths: scriptFileCandidates(body.text),
    };
  }

  classify(input: ClassifyInput): Classification {
    const candidates = [input.command, ...(input.commands ?? [])]
      .map((c) => (c ?? "").trim())
      .filter((c) => c.length > 0);

    // Path escapes win over everything (PE-02), including paths hidden inside a command.
    const declaredPaths = [
      ...(input.paths ?? []),
      ...candidates.flatMap((candidate) => pathsInCommand(candidate)),
    ];
    const escaping = declaredPaths.find((p) => !Classifier.isInside(input.projectPath, p));
    if (escaping) {
      return this.classifyEscape(input, escaping, this.writesTo(input, candidates, escaping));
    }

    if (candidates.length > 0) {
      // Every command a chain actually runs, plus the raw strings: a matcher shipped by a pack
      // may well have been written against a whole command line.
      const parts = candidates.flatMap((c) => splitSegments(c));
      // The raw line is kept because a pack's matcher may have been written against a whole
      // command line — with the harmless redirects removed, as in the split parts (§7.1c).
      const segments = [...candidates.map(stripDevNull), ...parts];

      // Housekeeping inside the scratch directory is not a deletion (PE-08): an agent that
      // tidies up after itself must not need a human. Only when every segment is a removal and
      // every one of them stays inside the scratch directory — a chain that mixes it with
      // anything else keeps the ordinary "worst segment wins" answer.
      const removalPatterns = this.table.get("delete") ?? [];
      const runs = parts.length > 0 ? parts : candidates;
      if (
        runs.length > 0 &&
        runs.every(
          (segment) =>
            removalPatterns.some((re) => re.test(segment)) &&
            confinedToScratch(input.projectPath, segment),
        )
      ) {
        return {
          class: "project_write",
          reason: `housekeeping inside ${SCRATCH_REL}: ${runs[0]?.slice(0, 120)}`,
        };
      }

      // COMMAND_ORDER is ordered by danger, so the outer loop makes the most dangerous
      // match win across all segments. It is split in two around script inspection: a
      // dangerous match on the command line still wins outright, but `exec_check`,
      // `git_local` and `project_write` must not swallow `node x.mjs` before its body has
      // been read (PE-07) — `node` matches `exec_check` by its first word alone.
      const dangerous = COMMAND_ORDER.slice(0, COMMAND_ORDER.indexOf("exec_check"));
      const benign = COMMAND_ORDER.slice(COMMAND_ORDER.indexOf("exec_check"));

      const matchInOrder = (order: ActionClass[]): Classification | undefined => {
        for (const cls of order) {
          if (cls === "project_read") continue; // handled below: it needs unanimity
          const patterns = this.table.get(cls) ?? [];
          for (const segment of segments) {
            // Credentials are judged on what the command does with the value, so the places where
            // a variable is only tested for presence are removed first (§7.1b).
            const subject = cls === "credentials" ? stripPresenceTests(segment) : segment;
            const hit = patterns.find((re) => re.test(subject));
            if (hit && cls === "deps_install" && installsIntoScratch(input.projectPath, segment)) {
              // Into the scratch directory: it is swept when the run ends, so it changes nothing
              // for the next one and the reason for the gate does not apply (PE-08, ST-03).
              return {
                class: "project_write",
                reason: `install confined to ${SCRATCH_REL}, swept at the end of the run`,
              };
            }
            if (hit) {
              return {
                class: cls,
                reason: `command matched ${cls}: ${hit.source} (${segment.slice(0, 120)})`,
              };
            }
          }
        }
        return undefined;
      };

      const dangerousHit = matchInOrder(dangerous);
      if (dangerousHit) return dangerousHit;

      // Running the agent's own code (PE-07): read the body and let it decide the class. The
      // worst answer across the scripts in a chain wins, and `other` (could not inspect) is
      // worse than `script_exec`.
      const scriptVerdicts: Classification[] = [];
      for (const segment of runs) {
        const body = this.scriptBody(segment, input.projectPath);
        if (body) scriptVerdicts.push(this.classifyScript(input, segment, body));
      }
      if (scriptVerdicts.length > 0) {
        return (
          scriptVerdicts.find((v) => v.class !== "script_exec" && v.class !== "other") ??
          scriptVerdicts.find((v) => v.class === "other") ??
          scriptVerdicts[0]!
        );
      }

      const benignHit = matchInOrder(benign);
      if (benignHit) return benignHit;

      // `project_read` is the one class that needs unanimity: a chain is read-only only if
      // every command in it is. Otherwise `echo hi && some-unknown-tool` would pass as a read
      // because its first word is harmless. Unanimity is checked per candidate, because the
      // candidates are alternative renderings of the same request — the literal command and a
      // prose description of it — and only the literal one is a command line at all.
      if (candidates.some((candidate) => this.isReadOnlyChain(candidate))) {
        return {
          class: "project_read",
          reason: `read-only command: ${candidates[0]?.slice(0, 120)}`,
        };
      }

      return { class: "other", reason: `unmatched command: ${candidates[0]?.slice(0, 120)}` };
    }

    switch ((input.kind ?? "").toLowerCase()) {
      case "read":
      case "search":
      case "fetch_file":
        return { class: "project_read", reason: "read inside the project" };
      case "edit":
      case "write":
      case "move":
        return { class: "project_write", reason: "write inside the project" };
      case "delete":
        return { class: "delete", reason: "delete request" };
      case "fetch":
        return { class: "network", reason: "network fetch" };
      case "execute":
        return { class: "other", reason: "execution without a command string" };
      default:
        return { class: "other", reason: `unclassified kind: ${input.kind ?? "none"}` };
    }
  }
}
