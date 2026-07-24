/** Per-project configuration `lightsout.yaml` (DESIGN §9.1, PM-01, PE-05). */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
import { z } from "zod";
import { policyPackSchema, type PolicyPack } from "../policy/schema.js";

export const projectConfigSchema = z
  .object({
    name: z.string().min(1).optional(),
    /** Verify gate command; empty means no gate (OR-04). */
    verify: z.string().default(""),
    push: z.enum(["auto", "manual", "never"]).default("manual"),
    /** Inline override pack, merged as the top layer (PE-05). */
    policy: z
      .object({
        rules: policyPackSchema.shape.rules,
        matchers: policyPackSchema.shape.matchers.optional(),
      })
      .partial()
      .optional(),
    remote: z.string().default(""),
    /** Agent profile used when a task does not name one. */
    default_agent: z.string().optional(),
  })
  .strict();

export type ProjectConfig = z.infer<typeof projectConfigSchema>;

export const CONFIG_FILE = "lightsout.yaml";

export type LoadedProjectConfig = {
  config: ProjectConfig;
  /** The inline policy override as a pack, when present. */
  pack?: PolicyPack;
};

/** Read and validate `lightsout.yaml`; a missing file yields defaults. */
export async function readProjectConfig(projectPath: string): Promise<LoadedProjectConfig> {
  let raw: unknown;
  try {
    raw = loadYaml(await readFile(path.join(projectPath, CONFIG_FILE), "utf8"));
  } catch {
    return { config: projectConfigSchema.parse({}) };
  }
  const config = projectConfigSchema.parse(raw ?? {});
  if (!config.policy?.rules?.length) return { config };
  return {
    config,
    pack: policyPackSchema.parse({
      id: "project",
      rules: config.policy.rules,
      matchers: config.policy.matchers ?? {},
    }),
  };
}
