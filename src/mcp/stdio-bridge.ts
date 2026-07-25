/**
 * Stdio ⇄ HTTP bridge for Claude Desktop (MC-01, DESIGN §10.1).
 *
 * Reads newline-delimited JSON-RPC from stdin, forwards each message to the container's /mcp
 * endpoint and writes the reply back to stdout. It holds no state and no database handle, so
 * the single-writer rule is preserved (ST-02): the orchestrator process remains the only writer.
 *
 * Claude Desktop config:
 *   { "mcpServers": { "lightsout": {
 *       "command": "docker",
 *       "args": ["exec","-i","lightsout","node","dist/mcp/stdio-bridge.js"] } } }
 */
const ENDPOINT = process.env.LO_MCP_URL ?? "http://127.0.0.1:8484/mcp";

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Pull the JSON payloads out of an SSE body: the transport may answer either way. */
function extractSse(body: string): string[] {
  const payloads: string[] = [];
  for (const block of body.split("\n\n")) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    if (data) payloads.push(data);
  }
  return payloads;
}

async function forward(message: string): Promise<void> {
  let parsed: { id?: unknown } | undefined;
  try {
    parsed = JSON.parse(message) as { id?: unknown };
  } catch {
    return; // not a JSON-RPC frame; ignore rather than crash the bridge
  }

  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: message,
    });

    // 202 Accepted: a notification with nothing to return.
    if (response.status === 202) return;

    const body = await response.text();
    if (!body.trim()) return;

    if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      for (const payload of extractSse(body)) write(payload);
      return;
    }
    write(body.trim());
  } catch (err) {
    if (parsed?.id === undefined || parsed.id === null) return; // nothing to answer
    write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: parsed.id,
        error: {
          code: -32000,
          message: `LightsOut is not reachable at ${ENDPOINT}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
      }),
    );
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim()) void forward(line.trim());
  }
});
process.stdin.on("end", () => {
  if (buffer.trim()) void forward(buffer.trim());
});
