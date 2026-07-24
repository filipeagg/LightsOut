// Copy non-TypeScript build assets into dist/ (tsc ignores them).
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const assets = [["src/db/schema.sql", "dist/db/schema.sql"]];

for (const [from, to] of assets) {
  await mkdir(path.dirname(path.join(root, to)), { recursive: true });
  await cp(path.join(root, from), path.join(root, to));
  console.log(`copied ${from} -> ${to}`);
}
