export type ItemType = "password" | "note";

export type CustomFieldType = "text" | "password" | "email" | "url" | "totp";

export interface CustomField {
  id: string;
  label: string;
  value: string;
  field_type: CustomFieldType;
}

export interface Attachment {
  id: string;
  filename: string;
  mime: string;
  data_base64: string;
}

/** Ancienne valeur de `password`, conservée quand le mot de passe change réellement. */
export interface PasswordHistoryEntry {
  password: string;
  /** Date ISO à laquelle ce mot de passe a cessé d'être actif. */
  changed_at: string;
}

export interface VaultItem {
  id: string;
  item_type: ItemType;
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  category: string;
  /** Tags libres, multiples, indépendants de `category` (un seul album par entrée). */
  tags: string[];
  favorite: boolean;
  /** Date ISO (yyyy-mm-dd) de rotation prévue, chaîne vide = pas d'échéance */
  expires_at: string;
  custom_fields: CustomField[];
  attachments: Attachment[];
  /** Géré côté Rust (voir `update_item`) : jamais écrit directement par le frontend. */
  password_history: PasswordHistoryEntry[];
  created_at: string;
  updated_at: string;
}

export type VaultMode = "local" | "cloud";

export interface GeneratorOptions {
  length: number;
  uppercase: boolean;
  lowercase: boolean;
  numbers: boolean;
  symbols: boolean;
}

export const DEFAULT_GENERATOR_OPTIONS: GeneratorOptions = {
  length: 20,
  uppercase: true,
  lowercase: true,
  numbers: true,
  symbols: true,
};

/** Écrans possibles de l'application desktop. */
export type Screen =
  | "mode-select"
  | "local-create"
  | "local-unlock"
  | "cloud-signin"
  | "cloud-master-password"
  | "vault";
