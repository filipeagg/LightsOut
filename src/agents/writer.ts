/**
 * Panel-driven agent profile writing (AP-06..08, DESIGN §2).
 *
 * Every write lands in `$WORKSPACE/agents/<id>.yaml`. Editing a builtin therefore clones it
 * into the workspace, where it shadows the shipped one by id: the library in the image is
 * never touched, so `docker pull` keeps updating it under whatever the user changed, and
 * deleting the workspace copy brings the builtin back rather than losing the profile.
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { dump as dumpYaml } from "js-yaml";
import { agentProfileSchema, type AgentProfile } from "./schema.js";
import { AgentsLoader } from "./loader.js";

export type AgentPatch = Partial<Omit<AgentProfile, "id">> & { id?: string };

export type AgentSource = "builtin" | "workspace";

/** Where a loaded profile's definition currently comes from (AP-06 shows it in the editor). */
export async function agentSource(
  loader: AgentsLoader,
  id: string,
): Promise<AgentSource | undefined> {
  const file = path.join(loader.agentsDir, `${id}.yaml`);
  try {
    await readFile(file, "utf8");
    return "workspace";
  } catch {
    return loader.profile(id) ? "builtin" : undefined;
  }
}

export class AgentWriter {
  constructor(private readonly loader: AgentsLoader) {}

  private file(id: string): string {
    return path.join(this.loader.agentsDir, `${id}.yaml`);
  }

  /**
   * Create or update a workspace profile. `patch` is layered over whatever is loaded under
   * that id, so editing one field of a builtin does not require restating the rest — but what
   * lands on disk is a complete definition, because that is what the loader expects (§2).
   */
  async put(id: string, patch: AgentPatch): Promise<AgentProfile> {
    const current = this.loader.profile(id);
    const merged = agentProfileSchema.parse({
      ...(current ?? { name: id, engine: "claude" }),
      ...stripUndefined(patch),
      id,
    });

    const { id: _id, ...body } = merged;
    await writeFile(this.file(id), dumpYaml(body, { lineWidth: 100 }), "utf8");
    await this.loader.load();
    return this.loader.profileOrThrow(id);
  }

  /** Enable or disable without touching anything else (AP-07). */
  async setEnabled(id: string, enabled: boolean): Promise<AgentProfile> {
    if (!this.loader.profile(id)) throw new Error(`unknown agent profile: ${id}`);
    return this.put(id, { enabled });
  }

  /**
   * Delete the workspace copy. A builtin of the same id reappears underneath, which is the
   * point: this is "revert my changes", not "destroy the agent".
   */
  async remove(id: string): Promise<{ removed: boolean; revealedBuiltin: boolean }> {
    try {
      await rm(this.file(id));
    } catch {
      throw new Error(`${id} has no workspace copy to delete`);
    }
    await this.loader.load();
    return { removed: true, revealedBuiltin: this.loader.profile(id) !== undefined };
  }
}

/** A patch key set to undefined must not erase the value underneath it. */
function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}
