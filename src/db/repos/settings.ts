/** Settings repository: small key/value store for runtime state that outlives a boot. */
import type { Db } from "../db.js";

export class SettingsRepo {
  constructor(private readonly db: Db) {}

  get(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  getJson<T>(key: string): T | undefined {
    const raw = this.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }

  setJson(key: string, value: unknown): void {
    this.set(key, JSON.stringify(value));
  }

  all(): Record<string, string> {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as {
      key: string;
      value: string;
    }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }
}
