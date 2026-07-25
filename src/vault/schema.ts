/** Credentials vault schema (VT-01, DESIGN §18). */
import { z } from "zod";

export const vaultAuthSchema = z.enum([
  "none",
  "basic",
  "bearer",
  "api_key",
  "oauth2_client_credentials",
]);

export const vaultEntrySchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "entry id must be lowercase alphanumeric with -"),
    label: z.string().min(1),
    base_url: z.string().optional(),
    auth: vaultAuthSchema.default("none"),
    /** Only entries flagged test_only are reachable from a test_only_required pack (VT-06). */
    test_only: z.boolean().default(false),
    /** Project ids this entry is offered to, or ["*"] for all. */
    scope: z.array(z.string().min(1)).default(["*"]),
    notes: z.string().optional(),
    /** Values live here and only here. They never reach the prompt or the API (VT-02, VT-03). */
    fields: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export const vaultFileSchema = z
  .object({ entries: z.array(vaultEntrySchema).default([]) })
  .strict();

export type VaultAuth = z.infer<typeof vaultAuthSchema>;
export type VaultEntry = z.infer<typeof vaultEntrySchema>;
export type VaultFile = z.infer<typeof vaultFileSchema>;

/** What the panel and the MCP tools may see: field names and whether a value is set. */
export type VaultEntryView = Omit<VaultEntry, "fields"> & {
  fields: { name: string; present: boolean }[];
};

export function toView(entry: VaultEntry): VaultEntryView {
  const { fields, ...rest } = entry;
  return {
    ...rest,
    fields: Object.entries(fields).map(([name, value]) => ({
      name,
      present: value.length > 0,
    })),
  };
}

/**
 * Environment variable an entry's field is injected as: `LO_VAULT_<ENTRY>_<FIELD>` (§18).
 * Non-alphanumerics become underscores so an id with dashes still yields a legal name.
 */
export function envVarName(entryId: string, field: string): string {
  const clean = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return `LO_VAULT_${clean(entryId)}_${clean(field)}`;
}
