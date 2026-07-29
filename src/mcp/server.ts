/**
 * MCP server over streamable HTTP (MC-01, DESIGN §10.1).
 *
 * Stateless transport: every request carries its own initialize, so there is no session state
 * to lose and the stdio bridge can stay a dumb proxy. Bound to localhost like the rest of the
 * HTTP surface (WP-09); the pilot builds no auth.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { KnowledgeBase } from "../knowledge/loader.js";
import { registerTools, type McpDeps } from "./tools.js";

export const MCP_PATH = "/mcp";

/**
 * What the client is told before it has called anything (MC-09, DESIGN §10.0). Short on purpose:
 * it is in context for every conversation, and the detail is one `guide` call away.
 *
 * Split in two so the curated bases can be named between the rules and the closing line
 * (§10.0d): a client that reads "efemis (technical)" here stops inferring that a question about
 * EFEMIS is a question about some project's code.
 */
const RULES = `LightsOut runs coding agents unattended, in a container, over a
folder on this machine. You drive it; you do not do the work yourself.

Four nouns: a PROJECT is a folder with its own git, docs and context brief. A PHASE is one durable
step of its plan. A CHAIN is the queue of tasks, one at a time per project. An AGENT is a profile
(engine, model, policy, instructions), not a process.

Rules that are expensive to get wrong:
- Every launch states the request for this run AND what is expected back (\`expects\`). Both are
  required, including intermediate phases and relaunches; a launch without them is refused.
- Launches return immediately. Poll project_status, or status_card for a compact view.
- A doubt is a decision the agent cannot make alone — not an error. list_doubts, answer_doubt.
- A policy denial is an answer. An agent that must read outside its project gets an area (add_area),
  not a weaker rule.
- The workspace is the user's own folder: call resolve_path before naming a file to anyone.
- Knowledge is a source in its own right: list_knowledge, then read_knowledge, answers a question
  about a product or a domain — check there before a project's code or the web.
- Documents the system reads back are machine-first: key: value, no prose. write_doc REPLACES;
  append_doc adds; patch_doc edits part.
- list_templates before create_project: a template brings phases, gates and frozen instructions,
  and "none" is an answer that carries its reason.
- A profile's engine and model are defaults; any launch may override them.
- Nothing that serves runs in an agent's terminal: it never returns. preview_start gives a URL.
- Correct a run in flight with steer_run rather than killing it. Recurring work is a trigger.`;

const CLOSING = `

Call guide{} for the list of sections and guide{topic:"overview"} to learn the system. The live
view for a person is the panel at http://127.0.0.1:8484.`;

/** The instructions of an install with no curated base: the rules and nothing to name. */
export const SERVER_INSTRUCTIONS = RULES + CLOSING;

/**
 * The same text with this install's curated bases named (§10.0d). Names only — id, kind and the
 * first words of the description — because the list is in context for every conversation and the
 * documents are one `list_knowledge` call away. Capped so an install with many bases cannot push
 * the rules out of sight.
 */
export function buildServerInstructions(bases: readonly KnowledgeBase[]): string {
  if (bases.length === 0) return SERVER_INSTRUCTIONS;
  const shown = bases.slice(0, MAX_NAMED_BASES);
  const named = shown.map((b) => `${b.manifest.id} (${b.manifest.kind})`).join(", ");
  const rest = bases.length - shown.length;
  const more = rest > 0 ? `, and ${rest} more` : "";
  return `${RULES}

Curated knowledge already on this install: ${named}${more}. Answer from these before reading a
project or the web.${CLOSING}`;
}

const MAX_NAMED_BASES = 8;

export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer(
    { name: "lightsout", version: deps.version },
    {
      // The loader's last snapshot: it loads at boot and every list_knowledge refreshes it, so a
      // base added on disk is named from the next conversation on (KB-01).
      instructions: buildServerInstructions(deps.knowledge?.list() ?? []),
    },
  );
  registerTools(server, deps);
  return server;
}

/**
 * Mount POST/GET/DELETE /mcp on the existing Fastify server. A fresh server and transport per
 * request keeps the stateless promise literal and avoids cross-request bleed.
 */
export async function mountMcp(
  app: FastifyInstance,
  deps: McpDeps,
  /** Called on every request; the wizard uses it to know Claude Desktop arrived (SU-03). */
  onRequest?: () => void,
): Promise<void> {
  const handler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    onRequest?.();
    const server = createMcpServer(deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.hijack(); // the transport owns the raw response from here on
    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (err) {
      app.log.error({ err }, "mcp request failed");
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json" });
        reply.raw.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
            id: null,
          }),
        );
      }
    } finally {
      reply.raw.on("close", () => {
        void transport.close();
        void server.close();
      });
    }
  };

  app.post(MCP_PATH, handler);
  app.get(MCP_PATH, handler);
  app.delete(MCP_PATH, handler);
  app.log.info(`mcp endpoint mounted at ${MCP_PATH}`);
}
