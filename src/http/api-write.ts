/**
 * The mutating HTTP surface (WP-02, SU-05, DESIGN §12.1b).
 *
 * Every route here is the same three lines: parse the body with zod, call one action with
 * `actor='panel'`, return what it gave back. The rules — what may be launched, what may be
 * deleted, what a disabled agent does — live in `src/control/actions.ts` and nowhere else, so
 * the browser and Claude Desktop cannot end up enforcing different ones.
 *
 * Enumerated here and nowhere else, and bound to localhost like the rest of the API (WP-09).
 */
import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Actions } from "../control/actions.js";
import { DOC_NAMES } from "../control/actions.js";
import { failure, success, type Envelope } from "../mcp/envelope.js";

export type WriteDeps = { actions: Actions };

/**
 * The same envelope the read API and the MCP tools use. A refusal is a 409 with a reason, not
 * a 500: "this agent is disabled" is an answer, not a crash.
 */
async function envelope(
  reply: FastifyReply,
  handler: () => Promise<Record<string, unknown>>,
): Promise<Envelope> {
  try {
    return success(await handler());
  } catch (err) {
    const body = failure(err);
    const code = !body.ok ? body.error.code : "INTERNAL";
    reply.code(code === "NOT_FOUND" ? 404 : code === "INVALID_INPUT" ? 400 : 409);
    return body;
  }
}

const idParam = z.object({ id: z.string().min(1) });
const engineSchema = z.enum(["claude", "codex"]);
const reasoningSchema = z.enum(["minimal", "low", "medium", "high"]);

const agentBody = z.object({
  name: z.string().min(1).optional(),
  engine: engineSchema.optional(),
  model: z.string().min(1).optional(),
  reasoning: reasoningSchema.optional(),
  instructions: z.string().optional(),
  policy: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).optional(),
  include: z.array(z.string().min(1)).optional(),
  advisor: z.boolean().optional(),
  enabled: z.boolean().optional(),
  deliverable: z.string().min(1).optional(),
});

const phaseBody = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  agent: z.string().min(1),
  instructions: z.string().min(1),
  deliverable: z.string().min(1).optional(),
  verify: z.string().min(1).optional(),
  gate: z.enum(["auto", "human"]).optional(),
  optional: z.boolean().optional(),
  repeatable: z.boolean().optional(),
});

const templateBody = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  requires_writable_knowledge: z.boolean().optional(),
  phases: z.array(phaseBody).min(1).optional(),
});

export function registerWriteRoutes(app: FastifyInstance, deps: WriteDeps): void {
  const { actions } = deps;
  const body = <S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> =>
    schema.parse(raw ?? {});

  // --- Agents (AP-06..08) --------------------------------------------------

  /** Create or clone: a POST with an id that is a builtin writes the workspace copy (§2). */
  app.post("/api/agents", async (request, reply) =>
    envelope(reply, async () => {
      const input = body(agentBody.extend({ id: z.string().min(1) }), request.body);
      const { id, ...patch } = input;
      return { agent: await actions.writeAgent("panel", id, patch) };
    }),
  );

  app.put("/api/agents/:id", async (request, reply) =>
    envelope(reply, async () => {
      const { id } = idParam.parse(request.params);
      return { agent: await actions.writeAgent("panel", id, body(agentBody, request.body)) };
    }),
  );

  app.post("/api/agents/:id/enabled", async (request, reply) =>
    envelope(reply, async () => {
      const { id } = idParam.parse(request.params);
      const { enabled } = body(z.object({ enabled: z.boolean() }), request.body);
      return { agent: await actions.setAgentEnabled("panel", id, enabled) };
    }),
  );

  app.delete("/api/agents/:id", async (request, reply) =>
    envelope(reply, async () => {
      const { id } = idParam.parse(request.params);
      return actions.deleteAgent("panel", id);
    }),
  );

  app.post("/api/agents/reload", async (_request, reply) =>
    envelope(reply, async () => actions.reloadAgents("panel")),
  );

  // --- Templates (TP-04) ---------------------------------------------------

  app.post("/api/templates", async (request, reply) =>
    envelope(reply, async () => {
      const input = body(templateBody.extend({ id: z.string().min(1) }), request.body);
      const { id, ...patch } = input;
      return { template: await actions.writeTemplate("panel", id, patch) };
    }),
  );

  app.put("/api/templates/:id", async (request, reply) =>
    envelope(reply, async () => {
      const { id } = idParam.parse(request.params);
      return {
        template: await actions.writeTemplate("panel", id, body(templateBody, request.body)),
      };
    }),
  );

  app.delete("/api/templates/:id", async (request, reply) =>
    envelope(reply, async () => {
      const { id } = idParam.parse(request.params);
      return actions.deleteTemplate("panel", id);
    }),
  );

  // --- Knowledge (KB-01..03) ----------------------------------------------

  const manifestBody = z.object({
    name: z.string().min(1).optional(),
    kind: z
      .enum(["technical", "functional", "organisational", "market", "other"])
      .optional(),
    /** `hard` makes the base binding: an agent may not decide against it (KB-11). */
    enforcement: z.enum(["advisory", "hard"]).optional(),
    description: z.string().optional(),
    tags: z.array(z.string().min(1)).optional(),
    owner: z.string().optional(),
    /** A folder in the workspace to read the documents from; `null` unlinks (KB-08). */
    source: z.string().min(1).nullable().optional(),
  });

  app.post("/api/knowledge", async (request, reply) =>
    envelope(reply, async () => {
      const input = body(manifestBody.extend({ id: z.string().min(1) }), request.body);
      const { id, ...patch } = input;
      return { base: await actions.writeKnowledge("panel", id, patch) };
    }),
  );

  app.put("/api/knowledge/:baseId", async (request, reply) =>
    envelope(reply, async () => {
      const { baseId } = z.object({ baseId: z.string().min(1) }).parse(request.params);
      return { base: await actions.writeKnowledge("panel", baseId, body(manifestBody, request.body)) };
    }),
  );

  app.put("/api/knowledge/:baseId/doc", async (request, reply) =>
    envelope(reply, async () => {
      const { baseId } = z.object({ baseId: z.string().min(1) }).parse(request.params);
      const input = body(
        z.object({ file: z.string().min(1), content: z.string() }),
        request.body,
      );
      return actions.writeKnowledgeDoc("panel", baseId, input.file, input.content);
    }),
  );

  /** Turn a folder of documents into a base, writing only what is missing (KB-10). */
  app.post("/api/knowledge/adopt", async (request, reply) =>
    envelope(reply, async () => {
      const input = body(
        manifestBody.omit({ source: true }).extend({
          folder: z.string().min(1),
          id: z.string().min(1).optional(),
        }),
        request.body,
      );
      const { folder, ...patch } = input;
      return actions.adoptKnowledge("panel", folder, patch);
    }),
  );

  app.delete("/api/knowledge/:baseId/doc", async (request, reply) =>
    envelope(reply, async () => {
      const { baseId } = z.object({ baseId: z.string().min(1) }).parse(request.params);
      const { file } = body(z.object({ file: z.string().min(1) }), request.body);
      return actions.deleteKnowledgeDoc("panel", baseId, file);
    }),
  );

  app.delete("/api/knowledge/:baseId", async (request, reply) =>
    envelope(reply, async () => {
      const { baseId } = z.object({ baseId: z.string().min(1) }).parse(request.params);
      return actions.deleteKnowledge("panel", baseId);
    }),
  );

  // --- Vault (VT-01..03). Values go in, never out. -------------------------

  app.put("/api/vault/:entryId", async (request, reply) =>
    envelope(reply, async () => {
      const { entryId } = z.object({ entryId: z.string().min(1) }).parse(request.params);
      const input = body(
        z.object({
          label: z.string().min(1).optional(),
          base_url: z.string().optional(),
          auth: z
            .enum(["none", "basic", "bearer", "api_key", "oauth2_client_credentials"])
            .optional(),
          test_only: z.boolean().optional(),
          scope: z.array(z.string().min(1)).optional(),
          notes: z.string().optional(),
          // A field omitted keeps its stored value; null clears it (§18).
          fields: z.record(z.string(), z.string().nullable()).optional(),
        }),
        request.body,
      );
      return { entry: await actions.writeVaultEntry("panel", entryId, input) };
    }),
  );

  app.delete("/api/vault/:entryId", async (request, reply) =>
    envelope(reply, async () => {
      const { entryId } = z.object({ entryId: z.string().min(1) }).parse(request.params);
      return actions.deleteVaultEntry("panel", entryId);
    }),
  );

  // --- Projects and phases (TP-05..08, DO-04) ------------------------------

  app.post("/api/projects", async (request, reply) =>
    envelope(reply, async () => {
      // Checked before the schema, so the answer is the sentence a person needs rather than a
      // dump of validation issues (PM-09).
      const raw = (request.body ?? {}) as { context?: unknown };
      if (typeof raw.context !== "string" || !raw.context.trim()) {
        throw new Error(
          "a context brief is required (PM-09): what is this project for? " +
            "goal, actors, systems involved, constraints, definition of done, what is out of scope",
        );
      }
      const input = body(
        z.object({
          name: z.string().min(1),
          // PM-09: no project without a brief, whatever the template.
          context: z.string().min(1),
          remote: z.string().optional(),
          verify: z.string().optional(),
          push: z.enum(["auto", "manual", "never"]).optional(),
          defaultAgent: z.string().optional(),
          template: z.string().optional(),
          knowledge: z.array(z.string().min(1)).optional(),
          writableKnowledge: z.string().optional(),
        }),
        request.body,
      );
      const result = await actions.createProject("panel", input);
      return {
        project: {
          id: result.project.id,
          name: result.project.name,
          path: result.project.path,
        },
        created: result.created,
        phases: result.phases,
        knowledge: result.knowledge,
      };
    }),
  );

  app.post("/api/projects/:id/knowledge", async (request, reply) =>
    envelope(reply, async () => {
      const { id } = idParam.parse(request.params);
      const input = body(
        z.object({ baseId: z.string().min(1), writable: z.boolean().optional() }),
        request.body,
      );
      return actions.attachKnowledge("panel", id, input.baseId, input.writable ?? false);
    }),
  );

  app.delete("/api/projects/:id/knowledge/:baseId", async (request, reply) =>
    envelope(reply, async () => {
      const params = z
        .object({ id: z.string().min(1), baseId: z.string().min(1) })
        .parse(request.params);
      return actions.detachKnowledge("panel", params.id, params.baseId);
    }),
  );

  app.post("/api/projects/:id/phases", async (request, reply) =>
    envelope(reply, async () => {
      const { id } = idParam.parse(request.params);
      const input = body(
        z.object({
          title: z.string().min(1),
          agentId: z.string().min(1),
          instructions: z.string().min(1),
          position: z.number().int().min(0).optional(),
          deliverable: z.string().min(1).optional(),
          verifyCmd: z.string().min(1).optional(),
          gate: z.enum(["auto", "human"]).optional(),
        }),
        request.body,
      );
      const phase = actions.addPhase("panel", id, input);
      return { phaseId: phase.id, ref: phase.phase_id, position: phase.position };
    }),
  );

  /**
   * Phases are addressed by their ulid here, not by project + ref: the panel already has the
   * row it is rendering, and a URL that cannot be built by guessing is one fewer way to act
   * on the wrong project.
   */
  app.post("/api/phases/:phaseId/launch", async (request, reply) =>
    envelope(reply, async () => {
      const { phaseId } = z.object({ phaseId: z.string().min(1) }).parse(request.params);
      // OR-10: both required, here as in MCP.
      const input = body(
        z.object({ input: z.string().min(1), expects: z.string().min(1) }),
        request.body,
      );
      const phase = phaseOrThrow(actions, phaseId);
      return actions.launchPhase("panel", phase.project_id, phase.id, {
        request: input.input,
        expects: input.expects,
      });
    }),
  );

  app.post("/api/phases/:phaseId/skip", async (request, reply) =>
    envelope(reply, async () => {
      const { phaseId } = z.object({ phaseId: z.string().min(1) }).parse(request.params);
      const phase = phaseOrThrow(actions, phaseId);
      const skipped = await actions.skipPhase("panel", phase.project_id, phase.id);
      return { phaseId: skipped.id, ref: skipped.phase_id, status: skipped.status };
    }),
  );

  // Abort: the queue goes and the running session is stopped too (OR-06, §5.4).
  app.post("/api/runs/:id/abort", async (request, reply) =>
    envelope(reply, async () => {
      const { id } = idParam.parse(request.params);
      return actions.abortRun("panel", { runId: id });
    }),
  );

  // Stop: only this run, chain left paused (OR-09). Sent with no body, like the other buttons.
  app.post("/api/runs/:id/stop", async (request, reply) =>
    envelope(reply, async () => {
      const { id } = idParam.parse(request.params);
      return actions.stopRun("panel", { runId: id });
    }),
  );

  app.post("/api/projects/:id/resume", async (request, reply) =>
    envelope(reply, async () => {
      const { id } = idParam.parse(request.params);
      return actions.resumeChain("panel", { projectId: id });
    }),
  );

  app.post("/api/doubts/:id/answer", async (request, reply) =>
    envelope(reply, async () => {
      const { id } = idParam.parse(request.params);
      const input = body(
        z.object({ choice: z.string().min(1), note: z.string().optional() }),
        request.body,
      );
      return actions.answerDoubt("panel", { doubtId: id, ...input });
    }),
  );

  app.post("/api/projects/:id/doc", async (request, reply) =>
    envelope(reply, async () => {
      const { id } = idParam.parse(request.params);
      const input = body(
        z.object({ doc: z.enum(DOC_NAMES), content: z.string() }),
        request.body,
      );
      return actions.writeDoc("panel", id, input.doc, input.content);
    }),
  );

  // The context brief (PM-09): the one field a project cannot be without, and the one most
  // likely to need correcting once the work has started.
  app.post("/api/projects/:id/context", async (request, reply) =>
    envelope(reply, async () => {
      const { id } = idParam.parse(request.params);
      const input = body(z.object({ context: z.string().min(1) }), request.body);
      return actions.setProjectContext("panel", id, input.context);
    }),
  );

  // Read-only workspace areas (PE-09).
  app.post("/api/projects/:id/areas", async (request, reply) =>
    envelope(reply, async () => {
      const { id } = idParam.parse(request.params);
      const input = body(
        z.object({ path: z.string().min(1), note: z.string().optional() }),
        request.body,
      );
      return actions.addArea("panel", id, input);
    }),
  );

  app.delete("/api/projects/:id/areas/:area", async (request, reply) =>
    envelope(reply, async () => {
      const { id, area } = z
        .object({ id: z.string().min(1), area: z.string().min(1) })
        .parse(request.params);
      return actions.removeArea("panel", id, decodeURIComponent(area));
    }),
  );

  // --- Retiring a project (PM-08) ------------------------------------------

  app.post("/api/projects/:id/archived", async (request, reply) =>
    envelope(reply, async () => {
      const { id } = idParam.parse(request.params);
      const { archived } = body(
        z.object({ archived: z.boolean().default(true) }),
        request.body,
      );
      return { project: actions.archiveProject("panel", id, archived) };
    }),
  );

  /** Irreversible, so the body has to name the project (WP-11). */
  app.delete("/api/projects/:id", async (request, reply) =>
    envelope(reply, async () => {
      const { id } = idParam.parse(request.params);
      const input = body(
        z.object({ confirm: z.string().min(1), keepFiles: z.boolean().optional() }),
        request.body,
      );
      return actions.deleteProject("panel", id, input);
    }),
  );
}

/** Resolve a phase by its ulid, so the route can name the project it belongs to. */
function phaseOrThrow(actions: Actions, phaseId: string) {
  const phase = actions.phase(phaseId);
  if (!phase) throw new Error(`phase not found: ${phaseId}`);
  return phase;
}
