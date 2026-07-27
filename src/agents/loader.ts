/**
 * Agent profile loading (AP-01..04) and policy pack loading (PE-05).
 *
 * Two layers (DESIGN §2, BA-01). `builtin/agents/` and `builtin/policies/` ship inside the
 * image and are read first; `$WORKSPACE/agents/*.yaml` and `$WORKSPACE/agents/policies/*.yaml`
 * are read second and replace a builtin of the same id wholesale — no field merge, because a
 * shadowing file is a complete definition, so what the panel wrote is what runs.
 *
 * `builtin/` is never written to at runtime, so pulling a new image updates the library
 * without touching anything the user changed. Nothing is seeded into the workspace any more:
 * the library is present without copying it, and a copy would silently shadow future updates.
 * Invalid files are rejected with a reason and kept in the report; a bad file never takes the
 * loader down (AP-02).
 */
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
// js-yaml 5 is ESM with named exports only: there is no default export.
import { load as loadYaml } from "js-yaml";
import { agentProfileSchema, type AgentProfile, type RejectedProfile } from "./schema.js";
import { policyPackSchema, type PolicyPack } from "../policy/schema.js";

export type AgentsSnapshot = {
  profiles: Map<string, AgentProfile>;
  packs: Map<string, PolicyPack>;
  rejected: RejectedProfile[];
  /** Shared instruction fragments by file stem, for `include` (AP-04). */
  fragments: Map<string, string>;
};

export type LoadReport = {
  loaded: number;
  packs: number;
  /** How many of the loaded profiles came from the workspace, shadowing or adding (AP-01). */
  fromWorkspace: number;
  rejected: RejectedProfile[];
};

const YAML_EXT = new Set([".yaml", ".yml"]);

/** `builtin/` sits next to `dist/` in the image and next to `src/` in the repo. */
export function builtinDir(kind: "agents" | "policies" | "templates"): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "builtin", kind);
}

async function listYaml(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && YAML_EXT.has(path.extname(e.name).toLowerCase()))
      .map((e) => path.join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export class AgentsLoader {
  private snapshot: AgentsSnapshot = {
    profiles: new Map(),
    packs: new Map(),
    rejected: [],
    fragments: new Map(),
  };
  private pollTimer: NodeJS.Timeout | undefined;
  /** Fingerprint of the last loaded tree; a change in it is what triggers a reload. */
  private fingerprint = "";
  private polling = false;

  constructor(
    private readonly workspace: string,
    private readonly onReload?: (report: LoadReport) => void,
  ) {}

  get agentsDir(): string {
    return path.join(this.workspace, "agents");
  }

  get policiesDir(): string {
    return path.join(this.agentsDir, "policies");
  }

  get fragmentsDir(): string {
    return path.join(this.agentsDir, "fragments");
  }

  current(): AgentsSnapshot {
    return this.snapshot;
  }

  profile(id: string): AgentProfile | undefined {
    return this.snapshot.profiles.get(id);
  }

  profileOrThrow(id: string): AgentProfile {
    const found = this.profile(id);
    if (!found) {
      const known = [...this.snapshot.profiles.keys()].join(", ") || "none";
      throw new Error(`unknown agent profile: ${id} (available: ${known})`);
    }
    return found;
  }

  pack(id: string): PolicyPack | undefined {
    return this.snapshot.packs.get(id);
  }

  /** The packs a person may choose from: the three of PE-14, without the retired ids. */
  choosablePacks(): PolicyPack[] {
    return [...this.snapshot.packs.values()].filter((p) => !p.deprecated);
  }

  /**
   * The pack a profile actually runs under (PE-14, §7.2b): its pack, with the profile's own
   * `writeScopes` and `capabilities` laid over it.
   *
   * One function, because the alternative is the engine and the prompt disagreeing about what an
   * agent may do. A capability is prepended, since the engine takes the first matching rule; it
   * can only ever *allow* something the pack denied, never the reverse, and never anything on the
   * hard floor of PE-03 — `capabilities` is a two-value enum for exactly that reason.
   */
  packFor(profile: AgentProfile): PolicyPack | undefined {
    const base = this.pack(profile.policy);
    if (!base) return undefined;
    const scopes = profile.writeScopes?.length ? profile.writeScopes : base.write_scopes;
    const granted = (profile.capabilities ?? []).map((cls) => ({
      class: cls,
      verdict: "allow" as const,
      reason: `granted to ${profile.id} by its profile (PE-14)`,
    }));
    if (granted.length === 0 && scopes === base.write_scopes) return base;
    return { ...base, write_scopes: scopes, rules: [...granted, ...base.rules] };
  }

  async load(): Promise<LoadReport> {
    await mkdir(this.policiesDir, { recursive: true });

    const rejected: RejectedProfile[] = [];
    const fragments = new Map<string, string>();
    for (const file of await listYaml(this.fragmentsDir)) {
      fragments.set(path.basename(file).replace(/\.(ya?ml)$/i, ""), await readFile(file, "utf8"));
    }
    // Plain text fragments are allowed too: .md files next to the yaml ones.
    try {
      for (const entry of await readdir(this.fragmentsDir, { withFileTypes: true })) {
        if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".md") {
          fragments.set(
            entry.name.replace(/\.md$/i, ""),
            await readFile(path.join(this.fragmentsDir, entry.name), "utf8"),
          );
        }
      }
    } catch {
      // no fragments directory: fine
    }

    const profiles = new Map<string, AgentProfile>();
    let fromWorkspace = 0;
    // builtin first, workspace second: same id replaces, new id adds (DESIGN §2).
    for (const [layer, dir] of [
      ["builtin", builtinDir("agents")],
      ["workspace", this.agentsDir],
    ] as const) {
      for (const file of await listYaml(dir)) {
        try {
          const raw = loadYaml(await readFile(file, "utf8"));
          if (raw === null || typeof raw !== "object") {
            throw new Error("file is empty or not a YAML mapping");
          }
          const withDefaults = {
            id: path.basename(file).replace(/\.(ya?ml)$/i, ""),
            ...(raw as Record<string, unknown>),
          };
          const parsed = agentProfileSchema.parse(withDefaults);
          for (const fragment of parsed.include) {
            if (!fragments.has(fragment)) {
              throw new Error(`missing instruction fragment: ${fragment}`);
            }
          }
          if (layer === "workspace") fromWorkspace += 1;
          profiles.set(parsed.id, parsed);
        } catch (err) {
          rejected.push({
            file: layer === "builtin" ? path.join("builtin", path.basename(file)) : path.basename(file),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    const packs = new Map<string, PolicyPack>();
    for (const [layer, dir] of [
      ["builtin", builtinDir("policies")],
      ["workspace", this.policiesDir],
    ] as const) {
      for (const file of await listYaml(dir)) {
      try {
        const raw = loadYaml(await readFile(file, "utf8"));
        const withDefaults = {
          id: path.basename(file).replace(/\.(ya?ml)$/i, ""),
          ...((raw ?? {}) as Record<string, unknown>),
        };
        const parsed = policyPackSchema.parse(withDefaults);
        packs.set(parsed.id, parsed);
      } catch (err) {
        rejected.push({
          file: path.join(layer === "builtin" ? "builtin/policies" : "policies", path.basename(file)),
          error: err instanceof Error ? err.message : String(err),
        });
      }
      }
    }

    this.snapshot = { profiles, packs, rejected, fragments };
    this.fingerprint = await this.treeFingerprint();
    return {
      loaded: profiles.size,
      packs: packs.size,
      fromWorkspace,
      rejected,
    };
  }

  /**
   * Cheap signature of everything the loader reads: path, size and mtime of each file under
   * `agents/`. Bind mounts do not deliver reliable inotify events, so this is compared on a
   * poll instead of trusting the filesystem to tell us (AP-03, DESIGN §14.2).
   */
  private async treeFingerprint(): Promise<string> {
    const parts: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        try {
          const info = await stat(full);
          parts.push(`${full}:${info.size}:${info.mtimeMs}`);
        } catch {
          // vanished between readdir and stat: the next poll will see the final state
        }
      }
    };
    await walk(this.agentsDir);
    return parts.join("\n");
  }

  /** Resolved instructions: fragments first, then the profile's own text (AP-04). */
  instructionsFor(profile: AgentProfile): string {
    const parts = profile.include
      .map((name) => this.snapshot.fragments.get(name)?.trim())
      .filter((text): text is string => Boolean(text));
    if (profile.instructions.trim()) parts.push(profile.instructions.trim());
    return parts.join("\n\n");
  }

  /**
   * Pick up changes without a restart (AP-03). Polls the fingerprint every `pollMs` instead of
   * subscribing to filesystem events, which a Windows bind mount does not deliver reliably.
   */
  startWatching(pollMs = 2000): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, pollMs);
    this.pollTimer.unref?.();
  }

  /** One poll cycle: reload only when the tree actually changed. Exposed for tests. */
  async pollOnce(): Promise<boolean> {
    if (this.polling) return false;
    this.polling = true;
    try {
      const next = await this.treeFingerprint();
      if (next === this.fingerprint) return false;
      const report = await this.load();
      this.onReload?.(report);
      return true;
    } catch {
      // A transient read error must not kill the interval: the next poll retries.
      return false;
    } finally {
      this.polling = false;
    }
  }

  stopWatching(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }
}
