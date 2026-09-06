/** Per-project configuration `lightsout.yaml` (DESIGN §9.1, PM-01, PE-05). */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
import { z } from "zod";
import { policyPackSchema, type PolicyPack } from "../policy/schema.js";

/**
 * One phase of the project as the file states it (PM-13, DESIGN §9.7.1).
 *
 * TP-05 freezes a project's phases at creation: the template may change afterwards and the
 * project does not. That is exactly why the phases are written here rather than re-derived from
 * the template on the machine that adopts the project — re-materialising would hand the second
 * machine a quietly different project.
 */
export const phaseDeclarationSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    agent: z.string().min(1),
    instructions: z.string().default(""),
    deliverable: z.string().optional(),
    verify: z.string().optional(),
    gate: z.enum(["auto", "human"]).default("auto"),
    optional: z.boolean().default(false),
    repeatable: z.boolean().default(false),
  })
  .strict();

export type PhaseDeclaration = z.infer<typeof phaseDeclarationSchema>;

/** A workspace directory this project may reach outside its own (PE-09). */
export const areaDeclarationSchema = z
  .object({
    path: z.string().min(1),
    access: z.enum(["read", "write"]).default("read"),
    note: z.string().optional(),
  })
  .strict();

export type AreaDeclaration = z.infer<typeof areaDeclarationSchema>;

/**
 * What the project needs that its own repository cannot contain (PM-14).
 *
 * Ids only, on both lists. A repository is pushed to a remote more people can read than can run
 * the project, so the vault appears here as names and nowhere as values (NF-02, VT-09); the
 * field names travel in the bundle instead, which is handed to a person deliberately.
 */
export const requiresDeclarationSchema = z
  .object({
    knowledge: z.array(z.string().min(1)).default([]),
    vault: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type RequiresDeclaration = z.infer<typeof requiresDeclarationSchema>;

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
    /**
     * The half of the file that says what the project *is* rather than how it is run (PM-13).
     * Every field is optional and defaulted, because every `lightsout.yaml` written before this
     * requirement lacks all of them and none of that is a reason to reject a project.
     */
    context: z.string().default(""),
    template: z.string().optional(),
    template_reason: z.string().optional(),
    phases: z.array(phaseDeclarationSchema).default([]),
    areas: z.array(areaDeclarationSchema).default([]),
    requires: requiresDeclarationSchema.default({ knowledge: [], vault: [] }),
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
