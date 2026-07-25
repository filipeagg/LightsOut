/**
 * Interactive engine login inside the running container (RT-04, SU-04).
 *
 *   docker exec -it lightsout node dist/cli/login.js claude
 *   docker exec -it lightsout node dist/cli/login.js codex
 *   docker exec -i  lightsout node dist/cli/login.js codex --api-key   (key on stdin)
 *
 * The OAuth callback port is forwarded from the container's own address to its loopback, so the
 * published `127.0.0.1:1455` mapping reaches the CLI's listener. This works the same on Docker
 * Desktop and on a Linux engine: no host networking, no extra container.
 */
import { spawn } from "node:child_process";
import { loadConfig } from "../config.js";
import { startForwarder } from "../net/forwarder.js";

const CALLBACK_PORT = Number(process.env.LO_CALLBACK_PORT ?? 1455);

function run(command: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", (err) => {
      console.error(`[login] cannot run ${command}: ${err.message}`);
      resolve(127);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<void> {
  const engine = (process.argv[2] ?? "").toLowerCase();
  if (engine !== "claude" && engine !== "codex") {
    console.error("usage: node dist/cli/login.js <claude|codex> [--api-key|--console|--token]");
    process.exit(2);
  }
  loadConfig(); // fail fast on a broken environment

  const mode = process.argv[3] ?? "";
  const forwarder = await startForwarder(CALLBACK_PORT, (line) => console.error(`[login] ${line}`));
  if (forwarder.addresses.length === 0) {
    console.error(
      "[login] no external address to forward from; the browser callback may not arrive",
    );
  }

  try {
    let code: number;
    if (engine === "claude") {
      if (mode === "--token") code = await run("claude", ["setup-token"]);
      else if (mode === "--console") code = await run("claude", ["auth", "login", "--console"]);
      else code = await run("claude", ["auth", "login", "--claudeai"]);
    } else if (mode === "--api-key") {
      code = await run("codex", ["login", "--with-api-key"]);
    } else {
      code = await run("codex", ["login"]);
    }

    console.error(`[login] ${engine} exited with ${code}`);
    // Report the resulting state so the caller does not have to guess.
    await run(engine === "claude" ? "claude" : "codex", engine === "claude" ? ["auth", "status"] : ["login", "status"]);
    process.exit(code);
  } finally {
    await forwarder.close();
  }
}

main().catch((err: unknown) => {
  console.error("[login] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
