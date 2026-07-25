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
  delete: ["^rm\\b", "^rmdir\\b", "^find\\b.*-delete\\b", "^git\\s+clean\\b", "^truncate\\b"],
  network: [
    "^(curl|wget|http|https|nc|ncat|telnet|ssh|scp|rsync)\\b",
    "\\bpip\\s+download\\b",
    "^(npx|pnpx)\\b",
  ],
  credentials: [
    "\\b(ANTHROPIC_API_KEY|OPENAI_API_KEY|GIT_TOKEN|GITHUB_TOKEN|AWS_SECRET|PASSWORD)\\b",
    "(^|\\s)(cat|less|more|head|tail|grep)\\b.*(\\.env|\\.npmrc|id_rsa|credentials|\\.pem)\\b",
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
];

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
   * Whether a request modifies what it touches. Used only to tell a read of a knowledge base
   * from a write into one; a request whose intent is unclear counts as writing, so the
   * cautious branch is the default.
   */
  private looksLikeWriting(input: ClassifyInput, candidates: string[]): boolean {
    const kind = (input.kind ?? "").toLowerCase();
    if (["read", "search", "fetch_file"].includes(kind)) return false;
    if (["edit", "write", "move", "delete"].includes(kind)) return true;
    if (candidates.length === 0) return kind.length > 0;
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
      // COMMAND_ORDER is ordered by danger, so the outer loop makes the most dangerous
      // match win across all candidate strings.
      for (const cls of COMMAND_ORDER) {
        const patterns = this.table.get(cls) ?? [];
        for (const candidate of candidates) {
          const hit = patterns.find((re) => re.test(candidate));
          if (hit) {
            return {
              class: cls,
              reason: `command matched ${cls}: ${hit.source} (${candidate.slice(0, 120)})`,
            };
          }
        }
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
