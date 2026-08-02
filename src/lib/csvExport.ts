import Papa from "papaparse";
import type { VaultItem } from "../types";

/**
 * Formats vérifiés auprès des sources officielles (pas devinés) :
 * - Bitwarden : en-tête documenté sur bitwarden.com/help/condition-bitwarden-import
 *   `folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp`
 * - KeePassXC : sortie réelle de `keepassxc-cli export -f csv` (PR officielle
 *   keepassxreboot/keepassxc#3278) : `"Group","Title","Username","Password","URL","Notes"`
 *   (KeePassXC n'exporte pas nativement de colonne TOTP — le code 2FA est
 *   donc replié dans `Notes` pour ne pas perdre de donnée, plutôt que
 *   d'ajouter une colonne non standard que l'import pourrait ignorer).
 *
 * Aucun des deux formats n'a de colonne "tags" : repliés dans `notes` pour
 * les deux exports, pour la même raison (pas de perte silencieuse).
 *
 * ⚠️ Ces fichiers contiennent tous les mots de passe **en clair** — c'est
 * inhérent au format CSV attendu par ces deux autres gestionnaires, pas une
 * negligence de cette app. À supprimer après import.
 */

function appendExtras(notes: string, tags: string[], extraFields: { label: string; value: string }[]): string {
  const parts = [notes];
  if (tags.length > 0) parts.push(`Tags: ${tags.join(", ")}`);
  for (const f of extraFields) parts.push(`${f.label}: ${f.value}`);
  return parts.filter(Boolean).join("\n");
}

export function exportBitwardenCsv(items: VaultItem[]): string {
  const rows = items.map((item) => {
    const totpField = item.custom_fields.find((f) => f.field_type === "totp");
    const otherFields = item.custom_fields.filter((f) => f.field_type !== "totp");
    return {
      folder: item.category,
      favorite: item.favorite ? "1" : "",
      type: item.item_type === "note" ? "note" : "login",
      name: item.title,
      notes: appendExtras(item.notes, item.tags, otherFields),
      fields: "",
      reprompt: "0",
      login_uri: item.url,
      login_username: item.username,
      login_password: item.password,
      login_totp: totpField?.value ?? "",
    };
  });
  return Papa.unparse(rows, {
    columns: ["folder", "favorite", "type", "name", "notes", "fields", "reprompt", "login_uri", "login_username", "login_password", "login_totp"],
  });
}

export function exportKeepassCsv(items: VaultItem[]): string {
  const rows = items.map((item) => {
    const extraFields = item.custom_fields.map((f) => ({
      label: f.field_type === "totp" ? "2FA" : f.label,
      value: f.value,
    }));
    return {
      Group: `Root/${item.category || "Général"}`,
      Title: item.title,
      Username: item.username,
      Password: item.password,
      URL: item.url,
      Notes: appendExtras(item.notes, item.tags, extraFields),
    };
  });
  return Papa.unparse(rows, { columns: ["Group", "Title", "Username", "Password", "URL", "Notes"] });
}

/** Encode une chaîne UTF-8 en base64, correctement (contrairement à
 * `btoa` seul, qui corrompt les caractères accentués) — pour réutiliser la
 * commande Rust `write_binary_file` existante sans en ajouter une nouvelle
 * juste pour du texte. */
export function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}
