/**
 * Panel-driven knowledge writing (KB-01, KB-05, DESIGN §17).
 *
 * There is no builtin layer here: a base belongs to the installation. Writes go straight into
 * `$WORKSPACE/knowledge/<id>/`, and every document path is checked against the base directory
 * before it is touched, because the id and the path both arrive from a browser.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { dump as dumpYaml } from "js-yaml";
import {
  knowledgeManifestSchema,
  type KnowledgeManifest,
} from "./schema.js";
import { INDEX_FILE, MANIFEST_FILE, type KnowledgeLoader } from "./loader.js";

export type ManifestPatch = Partial<Omit<KnowledgeManifest, "id">>;

export class KnowledgeWriter {
  constructor(private readonly loader: KnowledgeLoader) {}

  private dir(baseId: string): string {
    const target = path.resolve(this.loader.knowledgeDir, baseId);
    const root = path.resolve(this.loader.knowledgeDir);
    if (path.dirname(target) !== root) {
      throw new Error(`invalid knowledge base id: ${baseId}`);
    }
    return target;
  }

  /** Create a base, or update its manifest. An index.md is seeded so injection has one (§17.2). */
  async putManifest(baseId: string, patch: ManifestPatch): Promise<KnowledgeManifest> {
    const current = this.loader.get(baseId)?.manifest;
    const manifest = knowledgeManifestSchema.parse({
      ...(current ?? { name: baseId, kind: "other" }),
      ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
      id: baseId,
      updated: patch.updated ?? new Date().toISOString().slice(0, 10),
    });

    const dir = this.dir(baseId);
    await mkdir(dir, { recursive: true });
    const { id: _id, ...body } = manifest;
    await writeFile(path.join(dir, MANIFEST_FILE), dumpYaml(body, { lineWidth: 100 }), "utf8");
    if (!current) {
      await writeFile(
        path.join(dir, INDEX_FILE),
        `# ${manifest.name}\n\nOne line per document, saying what is in it.\n`,
        "utf8",
      );
    }
    await this.loader.load();
    return this.loader.getOrThrow(baseId).manifest;
  }

  /** Write one Markdown document inside the base. */
  async putDocument(baseId: string, file: string, content: string): Promise<string> {
    const dir = this.dir(baseId);
    const target = path.resolve(dir, file);
    if (target !== dir && !target.startsWith(dir + path.sep)) {
      throw new Error(`path escapes the knowledge base: ${file}`);
    }
    if (path.extname(target).toLowerCase() !== ".md") {
      throw new Error("a knowledge document must be a .md file");
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    await this.loader.load();
    return path.relative(dir, target);
  }

  /**
   * Delete a base. Refused while a project has it attached: a project's prompts would start
   * quietly missing context, which is worse than an error (KB-03).
   */
  async remove(baseId: string, attachedTo: string[]): Promise<void> {
    if (attachedTo.length > 0) {
      throw new Error(
        `${baseId} is attached to ${attachedTo.join(", ")}; detach it first (KB-03)`,
      );
    }
    await rm(this.dir(baseId), { recursive: true, force: true });
    await this.loader.load();
  }
}
