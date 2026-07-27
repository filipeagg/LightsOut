/**
 * The credentials vault (VT-01..06, DESIGN §18).
 *
 * `vault.yaml` in the workspace root, git-ignored, mode 600. Values are read here and reach a
 * run only as environment variables of the adapter process; nothing else in the system ever
 * returns one, which is why the browser cannot leak one (VT-03).
 */
import { chmod, readFile } from "node:fs/promises";
import path from "node:path";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import { writeFileDurable } from "../workspace/durable.js";
import { slugify } from "../ids.js";
import {
  envVarName,
  normaliseEntries,
  toView,
  vaultFileLenientSchema,
  type VaultEntry,
  type VaultEntryView,
} from "./schema.js";

export const VAULT_FILE = "vault.yaml";

export type ResolvedVault = {
  /** Entries the run may use, without their values. */
  index: VaultEntryView[];
  /** Environment variables to add to the adapter process. */
  env: Record<string, string>;
  /** Entry ids and field names actually resolved, for the audit rows (VT-05). */
  reads: { entryId: string; fields: string[] }[];
  /** Entries excluded because the pack requires test_only credentials (VT-06). */
  refused: { entryId: string; reason: string }[];
};

/**
 * The hosts this run has credentials for (VT-07). A project given a token for an API is a project
 * meant to call that API; these are the hosts that justifies, and no others.
 */
export function vaultHosts(resolved: ResolvedVault): string[] {
  const hosts = new Set<string>();
  for (const entry of resolved.index) {
    if (!entry.base_url) continue;
    try {
      hosts.add(new URL(entry.base_url).host);
    } catch {
      continue; // a base_url that is not a URL grants nothing
    }
  }
  return [...hosts];
}

export class Vault {
  constructor(private readonly workspace: string) {}

  get file(): string {
    return path.join(this.workspace, VAULT_FILE);
  }

  /** Entries as stored. Only the resolver and the writer call this. */
  async readAll(): Promise<VaultEntry[]> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      return [];
    }
    const raw = loadYaml(text);
    if (raw === null || raw === undefined) return [];
    // VT-08: an id in an older shape is repaired, not a reason to fail every run in the system.
    return normaliseEntries(vaultFileLenientSchema.parse(raw).entries, slugify);
  }

  /**
   * The id for a new entry, from its label (VT-08). Derived rather than asked for: it ends up
   * inside `LO_VAULT_<ENTRY>_<FIELD>`, and that is the system's arithmetic, not the user's.
   */
  async idForLabel(label: string): Promise<string> {
    const base = slugify(label);
    const taken = new Set((await this.readAll()).map((entry) => entry.id));
    if (!taken.has(base)) return base;
    for (let n = 2; n < 100; n += 1) {
      if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
    }
    throw new Error(`too many entries labelled like ${label}`);
  }

  /** Everything the panel and the MCP tools may see (VT-03). */
  async listViews(): Promise<VaultEntryView[]> {
    return (await this.readAll()).map(toView);
  }

  /**
   * Create or update an entry. A field omitted from `fields` keeps its stored value; a field
   * set to null clears it. There is no route that reads a value back out (§18).
   */
  async put(
    rawId: string,
    patch: Partial<Omit<VaultEntry, "id" | "fields">> & {
      fields?: Record<string, string | null>;
    },
  ): Promise<VaultEntryView> {
    // VT-08: the canonical form, whoever is calling. Stored ids are already canonical after
    // `readAll`, so for an edit this is a no-op; for anything else it keeps the invariant.
    const id = slugify(rawId);
    const entries = await this.readAll();
    const index = entries.findIndex((entry) => entry.id === id);
    const current: VaultEntry =
      index >= 0
        ? entries[index]!
        : { id, label: id, auth: "none", test_only: false, scope: ["*"], fields: {} };

    const fields = { ...current.fields };
    for (const [name, value] of Object.entries(patch.fields ?? {})) {
      if (value === null) delete fields[name];
      else fields[name] = value;
    }

    const { fields: _ignored, ...rest } = patch;
    const next: VaultEntry = { ...current, ...rest, id, fields };
    if (index >= 0) entries[index] = next;
    else entries.push(next);

    await this.write(entries);
    return toView(next);
  }

  async remove(id: string): Promise<boolean> {
    const entries = await this.readAll();
    const remaining = entries.filter((entry) => entry.id !== id);
    if (remaining.length === entries.length) return false;
    await this.write(remaining);
    return true;
  }

  private async write(entries: VaultEntry[]): Promise<void> {
    // Durable: a credential the user typed once must not be lost to an abnormal container exit
    // (§11.2b, and the note in workspace/durable.ts about what that cost a knowledge base).
    await writeFileDurable(this.file, dumpYaml({ entries }, { lineWidth: 120 }));
    // The rename does not carry a mode, so it is applied afterwards either way.
    await chmod(this.file, 0o600).catch(() => undefined);
  }

  /**
   * What a run gets: entries in scope for the project, filtered by the pack's `test_only`
   * requirement, as an index for the prompt and as environment variables for the adapter.
   */
  async resolveForRun(options: {
    projectId: string;
    testOnlyRequired: boolean;
  }): Promise<ResolvedVault> {
    const resolved: ResolvedVault = { index: [], env: {}, reads: [], refused: [] };

    for (const entry of await this.readAll()) {
      const inScope =
        entry.scope.includes("*") || entry.scope.includes(options.projectId);
      if (!inScope) continue;

      if (options.testOnlyRequired && !entry.test_only) {
        resolved.refused.push({
          entryId: entry.id,
          reason: "this agent's pack only reaches test_only credentials (VT-06)",
        });
        continue;
      }

      resolved.index.push(toView(entry));
      const fields = Object.keys(entry.fields).filter((name) => entry.fields[name]);
      for (const name of fields) {
        resolved.env[envVarName(entry.id, name)] = entry.fields[name]!;
      }
      if (fields.length > 0) resolved.reads.push({ entryId: entry.id, fields });
    }

    return resolved;
  }
}

/**
 * The vault index as it appears in the prompt: labels, URLs, notes and the variable names —
 * never a value (VT-02). An agent that needs an entry which is absent or empty opens a doubt
 * naming the entry and the fields it needs (VT-04).
 */
export function renderVaultIndex(resolved: ResolvedVault): string {
  if (resolved.index.length === 0 && resolved.refused.length === 0) return "";
  const lines = [
    "Credentials available to this run. The values are already in your environment under the",
    "variable names below; they are never printed here. Read them from the environment, never",
    "echo them, and never write one into a file. If an entry you need is missing or its value",
    "is empty, raise a doubt naming the entry id and the fields you need instead of guessing.",
    "",
  ];
  for (const entry of resolved.index) {
    lines.push(`- ${entry.id} — ${entry.label}${entry.test_only ? " (test only)" : ""}`);
    if (entry.base_url) lines.push(`  base_url: ${entry.base_url}`);
    lines.push(`  auth: ${entry.auth}`);
    if (entry.notes) lines.push(`  notes: ${entry.notes}`);
    for (const field of entry.fields) {
      lines.push(
        `  ${field.name}: \$${envVarName(entry.id, field.name)}${field.present ? "" : " (EMPTY — raise a doubt)"}`,
      );
    }
  }
  for (const refused of resolved.refused) {
    lines.push(`- ${refused.entryId} — withheld: ${refused.reason}`);
  }
  lines.push("");
  return lines.join("\n");
}
