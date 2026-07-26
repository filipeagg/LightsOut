/** BA-07, BA-08: machine-first documents, and the check that says when one drifts. */
import { describe, expect, it } from "vitest";
import {
  HUMAN_MARKER,
  compactionBlock,
  deliverablePath,
  lintDocument,
  measureDocument,
} from "../src/projects/deliverable.js";
import { PROTOCOL_BLOCK, PROTOCOL_VERSION } from "../src/acp/prompt.js";

const MACHINE_FIRST = `# ANALYSIS :: demo
meta.doc: ANALYSIS
meta.updated: 2026-07-26
meta.passes: 6
meta.status: blocked
meta.blocked_on: sources_missing

## gaps

| id | gap | needs | source | confidence |
|---|---|---|---|---|
| G-1 | endpoint list unknown | sources/ populated | doc/OPEN-QUESTIONS.md#q.4 | high |
| G-2 | auth flow unknown | sources/ populated | doc/OPEN-QUESTIONS.md#q.5 | medium |

## facts

f.1.claim: base efemis holds 38 undocumented fields
f.1.kind: preference
f.1.source: knowledge:efemis/tecnico/api.md
f.1.confidence: medium
f.2.claim: the project has no sources directory
f.2.kind: constraint
f.2.source: code:.
f.2.confidence: high
`;

/** The shape of the real 40 KB deliverable that caused BA-07: a chronicle, in prose. */
const CHRONICLE = `# ANALYSIS — demo

Fase: chain "demo" 1/2 — "Read the system until you understand it".
Pasada sexta de la misma fecha. Las seis pasadas han quedado bloqueadas por el mismo motivo,
aunque la sexta no exactamente por el mismo, como se explica más abajo en la sección 1bis.

Estado: la fase sigue bloqueada porque el código fuente no está presente en el directorio
sources, de modo que el análisis solicitado no se ha podido llevar a cabo en esta pasada.

Lo que sí se entrega en su lugar queda recogido más abajo, etiquetado para que nadie lo
confunda con hallazgos obtenidos leyendo el código, que es lo que se pedía originalmente.

Consecuencia operativa, y es la razón de ser de esta sección: el agente no tiene ninguna vía
propia para obtener el código, de manera que cada relanzamiento reproduce este documento sin
añadir información nueva de ninguna clase, como ya se ha dicho antes.

Consecuencia operativa, y es la razón de ser de esta sección: el agente no tiene ninguna vía
propia para obtener el código, de manera que cada relanzamiento reproduce este documento sin
añadir información nueva de ninguna clase, como ya se ha dicho antes.
`;

describe("the machine-first check (BA-08)", () => {
  it("passes a key-value document with tables", () => {
    const lint = lintDocument(MACHINE_FIRST);
    expect(lint.ok).toBe(true);
    expect(lint.reasons).toEqual([]);
    expect(lint.metrics.structureRatio).toBe(1);
    expect(lint.metrics.longestParagraph).toBe(0);
  });

  it("fails the document that caused the rule, and says why", () => {
    const lint = lintDocument(CHRONICLE);
    expect(lint.ok).toBe(false);
    expect(lint.reasons.join(" ")).toMatch(/key: value/);
    expect(lint.reasons.join(" ")).toMatch(/prose lines/);
    expect(lint.reasons.join(" ")).toMatch(/paragraph/);
    expect(lint.metrics.duplicationRatio).toBeGreaterThan(0);
  });

  it("catches a document that appends the same block pass after pass", () => {
    const pass = [
      "## pass",
      "checked: sources directory",
      "result: missing",
      "action: none available",
      "next: a person populates sources/",
    ].join("\n");
    const lint = lintDocument(
      ["meta.doc: ANALYSIS", "meta.passes: 6", ...Array.from({ length: 6 }, () => pass)].join(
        "\n",
      ),
    );
    expect(lint.ok).toBe(false);
    expect(lint.reasons.join(" ")).toMatch(/repeats itself/);
  });

  it("never judges size: bytes and lines are reported, not thresholds", () => {
    const big = `${MACHINE_FIRST}\n${Array.from({ length: 4000 }, (_, i) => `f.${i + 3}.claim: fact ${i}\nf.${i + 3}.source: code:src/a.ts:${i}`).join("\n")}\n`;
    const lint = lintDocument(big);
    expect(lint.metrics.bytes).toBeGreaterThan(150_000);
    expect(lint.ok).toBe(true);
  });

  it("skips a document that declares itself prose for a human", () => {
    const lint = lintDocument(`${HUMAN_MARKER}\n${CHRONICLE}`);
    expect(lint.exempt).toBe(true);
    expect(lint.ok).toBe(true);
  });

  it("does not judge a document too short to have a shape", () => {
    expect(lintDocument("# NOTES\n\nJust a couple of sentences, written quickly.\n").ok).toBe(
      true,
    );
  });

  it("counts fenced blocks and the managed PLAN.md lines as structure", () => {
    const doc = [
      "meta.doc: CONTRACTS",
      "meta.updated: 2026-07-26",
      "e.1.request:",
      "```",
      "GET /api/things HTTP/1.1",
      "Authorization: Bearer …",
      "a line of payload that is long enough to look like prose if it were read as prose",
      "```",
      "- [x] one  <!-- lo:t_1 -->",
      "- [ ] two  <!-- lo:t_2 -->",
      "- [ ] three  <!-- lo:t_3 -->",
      "e.1.status_codes: 200,404",
      "e.1.verified: true",
      "e.1.source: probes/things.py",
    ].join("\n");
    const metrics = measureDocument(doc);
    expect(metrics.structureRatio).toBe(1);
    expect(lintDocument(doc).ok).toBe(true);
  });
});

describe("what the check applies to (BA-07, §20.2)", () => {
  const workspace = "/workspace";
  const project = "/workspace/projects/demo";

  it("measures our own Markdown deliverables, including one in a knowledge base", () => {
    expect(deliverablePath(workspace, project, "doc/ANALYSIS.md")).toBe(
      "/workspace/projects/demo/doc/ANALYSIS.md",
    );
    expect(deliverablePath(workspace, project, "workspace:knowledge/efemis/index.md")).toBe(
      "/workspace/knowledge/efemis/index.md",
    );
  });

  it("leaves alone anything that is not ours to judge", () => {
    // A description rather than a path, a glob, and another output format.
    expect(deliverablePath(workspace, project, "a working prototype")).toBeUndefined();
    expect(deliverablePath(workspace, project, "workspace:knowledge/*/index.md")).toBeUndefined();
    expect(deliverablePath(workspace, project, "doc/report.pdf")).toBeUndefined();
    expect(deliverablePath(workspace, project, "src/app.ts")).toBeUndefined();
    expect(deliverablePath(workspace, project, null)).toBeUndefined();
  });
});

describe("the feedback the next run gets", () => {
  it("tells the agent to compact before adding, with the numbers", () => {
    const lint = lintDocument(CHRONICLE);
    const block = compactionBlock("doc/ANALYSIS.md", lint);
    expect(block).toContain("file: doc/ANALYSIS.md");
    expect(block).toContain("problem.1:");
    expect(block).toMatch(/before adding anything new/);
  });

  it("is stated in the protocol block, which is versioned", () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(3);
    expect(PROTOCOL_BLOCK).toContain("key: value");
    expect(PROTOCOL_BLOCK).toContain("Supersede in place");
    expect(PROTOCOL_BLOCK).toContain(HUMAN_MARKER);
  });
});
