#!/usr/bin/env node
/**
 * `lo-serve` — the static server LightsOut ships for prototypes (PV-04, DESIGN §21.3).
 *
 * Two problems it exists for, both of which an agent cannot fix from inside the page it wrote:
 * a prototype fetching an API it was not served from is blocked by the browser before the request
 * is made, and a server bound to the container's localhost is unreachable however the port is
 * published. So this one answers permissive CORS headers, handles the preflight, and binds
 * whatever it is told to.
 *
 * No dependencies on purpose: it has to work in a project whose own dependencies are half
 * installed, which is exactly when someone wants to look at a page.
 *
 *   node dist/preview/serve.js --root . --port 5170 --host 0.0.0.0 --proxy /api=http://host:8080
 */
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import { URL } from "node:url";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

export type ServeOptions = {
  root: string;
  port: number;
  host: string;
  /** Path prefix → upstream origin, forwarded so the page talks to one origin. */
  proxies: { prefix: string; target: string }[];
  /** Serve index.html for unknown paths: what a client-side router needs. */
  spa: boolean;
};

export function parseArgs(argv: string[]): ServeOptions {
  const options: ServeOptions = {
    root: process.cwd(),
    port: 5170,
    host: "0.0.0.0",
    proxies: [],
    spa: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    // Not `split("=", 2)`: JavaScript's limit truncates instead of keeping the remainder, which
    // turns `--proxy=/api=http://x` into `/api` and silently drops the upstream.
    const arg = argv[i]!;
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const value = inline ?? argv[i + 1];
    const consume = () => {
      if (inline === undefined) i += 1;
      return value ?? "";
    };
    if (flag === "--root") options.root = path.resolve(consume());
    else if (flag === "--port") options.port = Number(consume());
    else if (flag === "--host") options.host = consume();
    else if (flag === "--spa") options.spa = true;
    else if (flag === "--proxy") {
      const spec = consume();
      const at = spec.indexOf("=");
      if (at < 1) throw new Error(`--proxy expects <prefix>=<upstream>, got: ${spec}`);
      options.proxies.push({ prefix: spec.slice(0, at), target: spec.slice(at + 1) });
    }
  }
  return options;
}

/** The headers that make a cross-origin fetch from the prototype work at all. */
function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Max-Age", "86400");
}

/**
 * Resolve a URL path to a file inside the root, or undefined when it escapes.
 * Path traversal is checked here rather than trusted: this listens on a published port.
 */
export function resolveFile(root: string, urlPath: string): string | undefined {
  const decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  const resolved = path.resolve(root, `.${path.posix.normalize(decoded)}`);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return undefined;
  try {
    const stat = statSync(resolved);
    if (stat.isDirectory()) {
      const index = path.join(resolved, "index.html");
      return statSync(index).isFile() ? index : undefined;
    }
    return resolved;
  } catch {
    return undefined;
  }
}

function proxy(
  req: IncomingMessage,
  res: ServerResponse,
  target: string,
  prefix: string,
): void {
  const upstream = new URL(req.url!.slice(prefix.length) || "/", target);
  const forwarded = httpRequest(
    upstream,
    { method: req.method, headers: { ...req.headers, host: upstream.host } },
    (answer) => {
      cors(res);
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    },
  );
  forwarded.on("error", (err) => {
    cors(res);
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(`lo-serve: upstream ${target} did not answer: ${err.message}\n`);
  });
  req.pipe(forwarded);
}

export function createServeServer(options: ServeOptions) {
  return createServer((req, res) => {
    cors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    const hit = options.proxies.find((p) => req.url?.startsWith(p.prefix));
    if (hit) return proxy(req, res, hit.target, hit.prefix);

    let file = resolveFile(options.root, req.url ?? "/");
    if (!file && options.spa) file = resolveFile(options.root, "/index.html");
    if (!file) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return res.end("lo-serve: not found\n");
    }

    res.writeHead(200, {
      "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      // A prototype is edited constantly; a cached asset is a bug report that is not real.
      "cache-control": "no-store",
    });
    createReadStream(file).pipe(res);
  });
}

// Only when run directly, so the module can be imported by a test.
if (process.argv[1] && process.argv[1].endsWith("serve.js")) {
  const options = parseArgs(process.argv.slice(2));
  createServeServer(options).listen(options.port, options.host, () => {
    process.stdout.write(
      `lo-serve: ${options.root} on http://${options.host}:${options.port}` +
        (options.proxies.length
          ? `, proxying ${options.proxies.map((p) => `${p.prefix} → ${p.target}`).join(", ")}`
          : "") +
        "\n",
    );
  });
}
