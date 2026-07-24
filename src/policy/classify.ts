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
};

export type Classification = {
  class: ActionClass;
  /** Why this class was chosen, for the audit row and for doubts. */
  reason: string;
};

/** Built-in matcher table (DESIGN §7.2 ships defaults; packs extend it). */
export const DEFAULT_MATCHERS: Record<string, string[]> = {
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
];

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

  /** True when `target` resolves inside `root`. Relative paths resolve against root. */
  static isInside(root: string, target: string): boolean {
    const base = path.resolve(root);
    const resolved = path.resolve(base, target);
    return resolved === base || resolved.startsWith(base + path.sep);
  }

  classify(input: ClassifyInput): Classification {
    const escaping = (input.paths ?? []).find(
      (p) => !Classifier.isInside(input.projectPath, p),
    );
    if (escaping) {
      return {
        class: "outside_workspace",
        reason: `path outside the project: ${escaping}`,
      };
    }

    const candidates = [input.command, ...(input.commands ?? [])]
      .map((c) => (c ?? "").trim())
      .filter((c) => c.length > 0);

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
