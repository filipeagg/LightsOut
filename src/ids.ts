/**
 * ULID generation (DESIGN §4: entity ids are ulids).
 * Implemented locally rather than pulling a dependency: 48-bit millisecond
 * timestamp + 80 bits of randomness, Crockford base32, lexicographically sortable.
 */
import { randomBytes } from "node:crypto";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32, no I L O U
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(ms: number): string {
  let out = "";
  let rest = ms;
  for (let i = 0; i < TIME_LEN; i++) {
    out = ENCODING[rest % 32] + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = randomBytes(RANDOM_LEN);
  let out = "";
  for (let i = 0; i < RANDOM_LEN; i++) {
    out += ENCODING[(bytes[i] ?? 0) % 32];
  }
  return out;
}

/** A 26-character ULID. Monotonic across calls within the same millisecond is not
 * guaranteed; the random part makes collisions negligible and ordering by time holds
 * at millisecond granularity, which is all the schema needs. */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

/** ISO-8601 UTC timestamp, the only time format stored in the database. */
export function nowIso(date: Date = new Date()): string {
  return date.toISOString();
}

/** Slugify a project name into an id that is also a valid directory name. */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!slug) throw new Error(`name produces an empty slug: ${JSON.stringify(name)}`);
  return slug;
}
