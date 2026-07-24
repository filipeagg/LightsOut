/**
 * Container HEALTHCHECK probe (RT-06). Exit 0 only if the process answers
 * /health. Auth problems are reported, not fatal: an unauthenticated engine must
 * be visible in the panel, not a crash-looping container (RT-04).
 */
const port = Number(process.env.LO_PORT_INTERNAL ?? 8484);

try {
  const res = await fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) {
    console.error(`health endpoint returned ${res.status}`);
    process.exit(1);
  }
  const body = (await res.json()) as { database?: { ok?: boolean } };
  if (body.database && body.database.ok === false) {
    console.error("database not ok");
    process.exit(1);
  }
  process.exit(0);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
