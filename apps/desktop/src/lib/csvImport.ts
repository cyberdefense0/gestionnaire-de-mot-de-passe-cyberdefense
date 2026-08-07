import Papa from "papaparse";
import type { VaultItem, CustomField } from "../types";

export type ImportDraft = Omit<VaultItem, "id" | "created_at" | "updated_at" | "password_history" | "last_used_at">;

type Row = Record<string, string>;

function pick(row: Row, keys: string[]): string {
  for (const key of keys) {
    const found = Object.keys(row).find((k) => k.toLowerCase().trim() === key);
    if (found && row[found]) return row[found];
  }
  return "";
}

function detectSource(headers: string[]): "chrome" | "firefox" | "bitwarden" | "lastpass" | "generic" {
  const h = headers.map((x) => x.toLowerCase().trim());
  if (h.includes("login_uri") && h.includes("login_username") && h.includes("login_password")) return "bitwarden";
  if (h.includes("url") && h.includes("username") && h.includes("password") && h.includes("extra")) return "lastpass";
  if (h.includes("url") && h.includes("username") && h.includes("password") && h.includes("httprealm")) return "firefox";
  if (h.includes("name") && h.includes("url") && h.includes("username") && h.includes("password")) return "chrome";
  return "generic";
}

function mapRow(row: Row, source: ReturnType<typeof detectSource>): ImportDraft | null {
  const title = pick(row, ["name", "title", "nom"]) || pick(row, ["url", "login_uri"]) || "Sans titre";
  const username = pick(row, ["username", "login_username", "login"]);
  const password = pick(row, ["password", "login_password"]);
  if (!password && source !== "generic") return null; // ligne non pertinente (ex: entrée note Bitwarden)

  const url = pick(row, ["url", "login_uri"]);
  const notesRaw = pick(row, ["notes", "note", "extra"]);
  const category = pick(row, ["folder", "grouping", "grouping_name"]) || "Importé";
  const favorite = ["1", "true", "yes"].includes(pick(row, ["fav", "favorite"]).toLowerCase());
  const totp = pick(row, ["login_totp", "totp"]);

  const customFields: CustomField[] = [];
  if (totp) {
    customFields.push({ id: crypto.randomUUID(), label: "Code 2FA", value: totp, field_type: "totp" });
  }

  return {
    item_type: "password",
    title: title || "Sans titre",
    username,
    password,
    url,
    notes: notesRaw,
    category,
    tags: [],
    favorite,
    expires_at: "",
    custom_fields: customFields,
    attachments: [],
    passkey: null,
    generation_rule: null,
  };
}

export interface ImportPreview {
  source: string;
  drafts: ImportDraft[];
  skipped: number;
}

const SOURCE_LABELS: Record<string, string> = {
  chrome: "Chrome / Edge / Brave",
  firefox: "Firefox",
  bitwarden: "Bitwarden",
  lastpass: "LastPass",
  generic: "Format générique",
};

export function parseImportCsv(csvText: string): ImportPreview {
  const parsed = Papa.parse<Row>(csvText, { header: true, skipEmptyLines: true });
  const headers = parsed.meta.fields ?? [];
  const source = detectSource(headers);

  const drafts: ImportDraft[] = [];
  let skipped = 0;
  for (const row of parsed.data) {
    const draft = mapRow(row, source);
    if (draft) drafts.push(draft);
    else skipped++;
  }

  return { source: SOURCE_LABELS[source] ?? source, drafts, skipped };
}
