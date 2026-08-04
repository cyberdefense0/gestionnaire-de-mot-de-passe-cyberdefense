export type ItemType = "password" | "note" | "passkey";

/**
 * Métadonnées publiques d'une passkey (FIDO2/WebAuthn). Cette app ne réalise
 * AUCUNE cérémonie WebAuthn (création/assertion) ni intégration d'autofill
 * natif — c'est prévu côté extension navigateur séparée. Ce type sert
 * uniquement à stocker/consulter les métadonnées d'une passkey déjà créée
 * ailleurs (ou saisie manuellement), chiffrées comme le reste du vault.
 * Jamais de clé privée ici : une clé privée FIDO2 doit rester dans
 * l'authentificateur (TPM, clé matérielle, trousseau OS).
 */
export interface PasskeyData {
  credential_id: string;
  rp_id: string;
  rp_name: string;
  user_handle: string;
  public_key: string;
  algorithm: string;
}

/** Règle de génération de mot de passe mémorisée pour une entrée (ex: site bancaire sans symboles). */
export interface GenerationRule {
  length: number;
  uppercase: boolean;
  lowercase: boolean;
  numbers: boolean;
  symbols: boolean;
  alphanumeric_only: boolean;
  exclude_chars: string;
}

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
  /** ISO, ou null si jamais copiée depuis la création. Géré côté Rust (`mark_item_used`), déclenché à chaque copie du secret. */
  last_used_at: string | null;
  /** Présent uniquement pour item_type "passkey". */
  passkey: PasskeyData | null;
  /** Règle de génération mémorisée pour cette entrée (facultative). */
  generation_rule: GenerationRule | null;
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
  /** Force un pool alphanumérique (ignore `symbols`) — ex: sites bancaires. */
  alphanumeric_only: boolean;
  /** Caractères explicitement exclus du pool final (ex: "l1IO0"). */
  exclude_chars: string;
}

export const DEFAULT_GENERATOR_OPTIONS: GeneratorOptions = {
  length: 20,
  uppercase: true,
  lowercase: true,
  numbers: true,
  symbols: true,
  alphanumeric_only: false,
  exclude_chars: "",
};

/** Écrans possibles de l'application desktop. */
export type Screen =
  | "mode-select"
  | "local-create"
  | "local-unlock"
  | "cloud-signin"
  | "cloud-master-password"
  | "vault";
