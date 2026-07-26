/**
 * Panel-driven template writing (TP-04, DESIGN §2).
 *
 * Same shadowing rule as agents: a write lands in `$WORKSPACE/templates/<id>.yaml` and
 * replaces the builtin of that id for this installation, while the shipped one stays in the
 * image. Editing a template never rewrites a running project — phases are frozen at creation
 * (TP-05) — so the blast radius of a mistake here is the next project, not the current one.
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { dump as dumpYaml } from "js-yaml";
import type { z } from "zod";
import { projectTemplateSchema, type ProjectTemplate } from "./schema.js";
import type { TemplatesLoader } from "./loader.js";

/**
 * The schema's *input* shape, not its output: a caller may omit `gate`, `optional` and
 * `repeatable` on a phase and let the defaults apply, which is what a form posts.
 */
export type TemplatePatch = Partial<
  Omit<z.input<typeof projectTemplateSchema>, "id">
>;

export class TemplateWriter {
  constructor(
    private readonly loader: TemplatesLoader,
    /** Same check the loader applies: an unknown or disabled agent makes a template unusable. */
    private readonly agentExists: (id: string) => boolean,
  ) {}

  private file(id: string): string {
    return path.join(this.loader.templatesDir, `${id}.yaml`);
  }

  async source(id: string): Promise<"builtin" | "workspace" | undefined> {
    try {
      await readFile(this.file(id), "utf8");
      return "workspace";
    } catch {
      return this.loader.get(id) ? "builtin" : undefined;
    }
  }

  /**
   * Create or update. The phase list is replaced wholesale when given, because reordering,
   * inserting and removing phases are all the same edit from the panel's point of view.
   */
  async put(id: string, patch: TemplatePatch): Promise<ProjectTemplate> {
    const current = this.loader.get(id);
    const merged = projectTemplateSchema.parse({
      ...(current ?? { name: id, phases: [] }),
      ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
      id,
    });

    // Validate against the live agent library before writing: a template saved unusable is a
    // trap that only shows up when someone tries to create a project from it (TP-03, AP-07).
    const missing = merged.phases
      .map((phase) => phase.agent)
      .filter((agent, index, all) => all.indexOf(agent) === index)
      .filter((agent) => !this.agentExists(agent));
    if (missing.length > 0) {
      throw new Error(`unknown or disabled agent(s): ${missing.join(", ")}`);
    }

    const { id: _id, ...body } = merged;
    await writeFile(this.file(id), dumpYaml(body, { lineWidth: 100 }), "utf8");
    await this.loader.load();
    return this.loader.getOrThrow(id);
  }

  /** Delete the workspace copy; a builtin of the same id reappears underneath. */
  async remove(id: string): Promise<{ removed: boolean; revealedBuiltin: boolean }> {
    try {
      await rm(this.file(id));
    } catch {
      throw new Error(`${id} has no workspace copy to delete`);
    }
    await this.loader.load();
    return { removed: true, revealedBuiltin: this.loader.get(id) !== undefined };
  }
}
