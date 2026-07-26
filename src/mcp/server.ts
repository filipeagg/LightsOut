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
import { registerTools, type McpDeps } from "./tools.js";

export const MCP_PATH = "/mcp";

/**
 * What the client is told before it has called anything (MC-09, DESIGN §10.0). Short on purpose:
 * it is in context for every conversation, and the detail is one `guide` call away.
 */
export const SERVER_INSTRUCTIONS = `LightsOut runs coding agents unattended, in a container, over a
folder on this machine. You drive it; you do not do the work yourself.

Four nouns: a PROJECT is a folder with its own git, docs and context brief. A PHASE is one durable
step of its plan. A CHAIN is the queue of tasks, one at a time per project. An AGENT is a profile
(engine, model, policy, instructions), not a process.

Rules that are expensive to get wrong:
- Every launch states the request for this run AND what is expected back (\`expects\`). Both are
  required, including intermediate phases and relaunches; a launch without them is refused.
- Launches return immediately. Poll project_status, or status_card for a compact view.
- A doubt is a decision the agent cannot make alone — not an error. list_doubts, answer_doubt.
- A policy denial is an answer, mediated by the engine. If an agent needs to read something outside
  its project, declare a read-only area (add_area) rather than weakening anything.
- The workspace is the user's own folder: call resolve_path before telling anyone where a file is.
- Documents the system reads back are machine-first: key: value, no prose.
- A profile's engine and model are defaults; any launch may override them (list_agents.models).
- Nothing that serves runs in an agent's terminal: it never returns. preview_start gives a URL.

Call guide{} for the list of sections and guide{topic:"overview"} to learn the system. The live
view for a person is the panel at http://127.0.0.1:8484.`;

export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer(
    { name: "lightsout", version: deps.version },
    {
      instructions: SERVER_INSTRUCTIONS,
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
