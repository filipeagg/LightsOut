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

export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer(
    { name: "lightsout", version: deps.version },
    {
      instructions:
        "LightsOut orchestrates coding agents. Launch work with launch_task or launch_chain, " +
        "then poll project_status. Doubts are decisions the agents need from a human: list them " +
        "with list_doubts and settle them with answer_doubt. Everything else is read-only.",
    },
  );
  registerTools(server, deps);
  return server;
}

/**
 * Mount POST/GET/DELETE /mcp on the existing Fastify server. A fresh server and transport per
 * request keeps the stateless promise literal and avoids cross-request bleed.
 */
export async function mountMcp(app: FastifyInstance, deps: McpDeps): Promise<void> {
  const handler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
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
