/**
 * Back the database up before a migration that rebuilds a table.
 *
 * `VACUUM INTO` rather than a file copy: SQLite in WAL mode keeps committed data in a side file,
 * so copying lightsout.db alone can silently lose the most recent writes. The copy is opened again
 * and checked, because a backup nobody verified is a hope.
 *
 *   docker exec lightsout node /opt/lightsout/scripts/backup-db.mjs pre-v9
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";

const label = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const target = `/data/backup/lightsout.${label}.db`;
mkdirSync("/data/backup", { recursive: true });

const live = new Database(process.env.LO_DB ?? "/data/lightsout.db", { readonly: true });
live.exec(`VACUUM INTO '${target}'`);
live.close();

const copy = new Database(target, { readonly: true });
const version = copy.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v;
const integrity = copy.pragma("integrity_check")[0].integrity_check;
const projects = copy.prepare("SELECT COUNT(*) AS n FROM projects").get().n;
const doubts = copy.prepare("SELECT COUNT(*) AS n FROM doubts").get().n;
copy.close();

console.log(
  JSON.stringify({ target, schema: version, integrity, projects, doubts }, null, 2),
);
if (integrity !== "ok") process.exit(1);
