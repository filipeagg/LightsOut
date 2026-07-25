#!/usr/bin/env node
/**
 * LightsOut desktop extension: stdio ⇄ HTTP bridge (MC-01, SU-09).
 *
 * Claude Desktop runs this with its bundled Node. It forwards newline-delimited JSON-RPC from
 * stdin to the container's MCP endpoint on 127.0.0.1 and writes the replies back. No
 * dependencies, no state, no database handle: the container stays the only writer (ST-02).
 *
 * A remote custom connector cannot serve this purpose, because Claude reaches remote MCP
 * servers from Anthropic's cloud, which has no route to the user's localhost.
 */
const ENDPOINT = process.env.LO_MCP_URL || "http://127.0.0.1:8484/mcp";

function write(line) {
  process.stdout.write(line + "\n");
}

/** Pull JSON payloads out of an SSE body: the transport may answer either way. */
function extractSse(body) {
  const payloads = [];
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

async function forward(message) {
  let parsed;
  try {
    parsed = JSON.parse(message);
  } catch {
    return; // not a JSON-RPC frame
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

    if (response.status === 202) return; // notification, nothing to answer
    const body = await response.text();
    if (!body.trim()) return;

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream")) {
      for (const payload of extractSse(body)) write(payload);
      return;
    }
    write(body.trim());
  } catch (err) {
    if (parsed.id === undefined || parsed.id === null) return;
    write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: parsed.id,
        error: {
          code: -32000,
          message:
            "LightsOut is not running on this machine (" +
            ENDPOINT +
            "). Start it and try again: " +
            (err && err.message ? err.message : String(err)),
        },
      }),
    );
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (line.trim()) void forward(line.trim());
  }
});
process.stdin.on("end", () => {
  if (buffer.trim()) void forward(buffer.trim());
});
