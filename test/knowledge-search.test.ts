/**
 * KB-13: curated knowledge is queryable, and the tools say so where a client cannot miss it.
 *
 * The failure being closed, three times over: a client read the tool list, saw "runs coding agents
 * unattended" and administration verbs, and answered questions about EFEMIS and about market news
 * from a project's source code or the web — with the curated base one call away.
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { KnowledgeLoader } from "../src/knowledge/loader.js";
import { registerTools, type McpDeps } from "../src/mcp/tools.js";

let workspace: string;
let loader: KnowledgeLoader;

const write = async (relative: string, body: string) => {
  const file = path.join(workspace, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body, "utf8");
};

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "lo-kb13-"));
  await write(
    "knowledge/efemis/knowledge.yaml",
    "id: efemis\nname: EFEMIS\nkind: technical\ndescription: EFEMIS product and API\n",
  );
  await write(
    "knowledge/efemis/producto/menu.md",
    "# Menu\n\nsections: Parcelario, Tareas, Almacén\nnote: el Vademécum vive bajo Maestros\n",
  );
  await write("knowledge/efemis/tecnico/api.md", "auth: bearer token\nbase_url: /api\n");
  await write(
    "knowledge/mercado/knowledge.yaml",
    "id: mercado\nname: Mercado\nkind: market\ndescription: Precios y noticias de frutas y hortalizas\n",
  );
  await write("knowledge/mercado/2026-07.md", "noticia: los precios del tomate suben un 4%\n");
  loader = new KnowledgeLoader(workspace);
  await loader.load();
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("searching curated knowledge (KB-13)", () => {
  it("finds the document that mentions the phrase, labelled by base and file", async () => {
    const hits = await loader.search("Parcelario");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ baseId: "efemis", kind: "technical", file: "producto/menu.md" });
    expect(hits[0]?.excerpt).toContain("Parcelario");
  });

  it("ignores case and accents, because the documents are Spanish and the question is typed fast", async () => {
    expect((await loader.search("vademecum"))[0]?.file).toBe("producto/menu.md");
    expect((await loader.search("ALMACEN"))[0]?.file).toBe("producto/menu.md");
  });

  it("searches every base unless told otherwise", async () => {
    expect((await loader.search("precios")).map((h) => h.baseId)).toEqual(["mercado"]);
    expect(await loader.search("precios", { baseId: "efemis" })).toEqual([]);
  });

  it("reports one hit per document, not one per line", async () => {
    await write("knowledge/mercado/2026-06.md", "noticia: precios\nnoticia: precios de nuevo\n");
    await loader.load();
    const hits = await loader.search("precios");
    expect(hits.map((h) => h.file).sort()).toEqual(["2026-06.md", "2026-07.md"]);
  });

  it("returns nothing for what is not there, and nothing for an empty query", async () => {
    expect(await loader.search("kubernetes")).toEqual([]);
    expect(await loader.search("   ")).toEqual([]);
  });

  it("refuses an unknown base by name, with the ones that exist", async () => {
    await expect(loader.search("x", { baseId: "nope" })).rejects.toThrow(/efemis, mercado/);
  });

  it("honours a limit so a common word cannot return the whole workspace", async () => {
    expect(await loader.search("noticia", { limit: 1 })).toHaveLength(1);
  });
});

/** Descriptions as the client sees them, with no server and no handler ever called. */
function descriptions(deps: Partial<McpDeps>): Map<string, string> {
  const found = new Map<string, string>();
  const server = {
    registerTool(name: string, config: { description?: string }) {
      found.set(name, config?.description ?? "");
    },
  };
  registerTools(server as never, deps as McpDeps);
  return found;
}

describe("the tool list says knowledge answers questions (KB-13)", () => {
  it("names the bases this install has in every knowledge tool's description", () => {
    const described = descriptions({ knowledge: loader });
    for (const name of ["list_knowledge", "read_knowledge", "search_knowledge"]) {
      const text = described.get(name);
      expect(text, `${name} is not registered`).toBeDefined();
      expect(text, `${name} does not name the bases`).toContain("efemis (technical)");
      expect(text).toContain("mercado (market)");
      // The description carries the gist of the manifest, which is what makes a question match.
      expect(text).toContain("noticias");
    }
  });

  it("tells the client these are answers, not administration", () => {
    const text = descriptions({ knowledge: loader }).get("search_knowledge") ?? "";
    expect(text).toMatch(/product/);
    expect(text).toMatch(/before a project's code or the web/);
  });

  it("registers without a knowledge loader at all, and says nothing about bases", () => {
    // mcp-parity registers with `{}` as deps; a description that threw would break the tool list.
    const text = descriptions({}).get("search_knowledge") ?? "";
    expect(text).toMatch(/Search the curated knowledge/);
    expect(text).not.toMatch(/Bases here now/);
  });
});
