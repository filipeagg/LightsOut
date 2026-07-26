/**
 * ACP permission request → action class (PE-01, PE-02, DESIGN §7.1).
 *
 * Inputs: the tool-call kind, the requested path, and the command string. Path escapes win
 * over everything: anything resolving outside the project directory is `outside_workspace`
 * regardless of what the command looks like (PE-02).
 */
import path from "node:path";
import type { ActionClass } from "./schema.js";

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
};

export type Classification = {
  class: ActionClass;
  /** Why this class was chosen, for the audit row and for doubts. */
  reason: string;
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
    "^(cd|pushd|popd|true|false|sleep)\\b",
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
    "\\b(ANTHROPIC_API_KEY|OPENAI_API_KEY|GIT_TOKEN|GITHUB_TOKEN|AWS_SECRET|PASSWORD)\\b",
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
 * Strip what sits between the separator and the command itself — subshell and group brackets,
 * negation, and leading environment assignments — so `(cd x && FOO=1 npm test)` is matched as
 * `npm test`. `sudo` and friends are deliberately left in place: they are not noise.
 */
function normalizeSegment(segment: string): string {
  let out = segment.trim();
  out = out.replace(/^[({\s]+/, "").replace(/[)}\s;]+$/, "");
  out = out.replace(/^!\s*/, "");
  out = out.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "");
  return out.trim();
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
  return found;
}

export class Classifier {
  private readonly table: Map<ActionClass, RegExp[]>;

  constructor(extraMatchers: Record<string, string[] | undefined> = {}) {
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
      chain.every((segment) => readOnly.some((re) => re.test(segment)))
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
      return this.classifyEscape(input, escaping, this.looksLikeWriting(input, candidates));
    }

    if (candidates.length > 0) {
      // Every command a chain actually runs, plus the raw strings: a matcher shipped by a pack
      // may well have been written against a whole command line.
      const parts = candidates.flatMap((c) => splitSegments(c));
      const segments = [...candidates, ...parts];

      // COMMAND_ORDER is ordered by danger, so the outer loop makes the most dangerous
      // match win across all segments.
      for (const cls of COMMAND_ORDER) {
        if (cls === "project_read") continue; // handled below: it needs unanimity
        const patterns = this.table.get(cls) ?? [];
        for (const segment of segments) {
          const hit = patterns.find((re) => re.test(segment));
          if (hit) {
            return {
              class: cls,
              reason: `command matched ${cls}: ${hit.source} (${segment.slice(0, 120)})`,
            };
          }
        }
      }

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
