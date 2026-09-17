import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import type { VaultItem, GeneratorOptions } from "../types";

/**
 * Toutes les opérations sensibles (dérivation de clé, chiffrement,
 * déchiffrement, accès disque) se font côté Rust — voir src-tauri/src/lib.rs
 * et vault-core/src/lib.rs. Le frontend ne manipule que des VaultItem en
 * clair une fois le vault déverrouillé, jamais le master password après
 * l'appel initial, jamais la clé de chiffrement.
 */

export interface VaultSnapshot {
  items: VaultItem[];
  categories: string[];
  /** ISO, ou null si l'utilisateur n'a jamais confirmé avoir sauvegardé son kit de récupération. */
  recoveryKitConfirmedAt: string | null;
}

export interface CreateVaultResult extends VaultSnapshot {
  recoveryCode: string;
}

export type ItemDraft = Omit<VaultItem, "id" | "created_at" | "updated_at" | "password_history" | "last_used_at">;

export const vaultApi = {
  vaultExists: (path: string): Promise<boolean> => invoke("vault_exists", { path }),

  pickNewVaultPath: (): Promise<string | null> =>
    save({ title: "Créer le coffre", defaultPath: "mon-coffre.vault", filters: [{ name: "Coffre", extensions: ["vault"] }] }),

  pickExistingVaultPath: async (): Promise<string | null> => {
    const result = await open({
      title: "Sélectionner un coffre",
      multiple: false,
      directory: false,
      filters: [{ name: "Coffre", extensions: ["vault"] }],
    });
    return Array.isArray(result) ? result[0] ?? null : result;
  },

  pickCsvFile: async (): Promise<string | null> => {
    const result = await open({
      title: "Sélectionner un fichier CSV",
      multiple: false,
      directory: false,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    return Array.isArray(result) ? result[0] ?? null : result;
  },

  pickBackupDestination: (): Promise<string | null> =>
    save({
      title: "Exporter une sauvegarde",
      defaultPath: `coffre-sauvegarde-${new Date().toISOString().slice(0, 10)}.vault`,
      filters: [{ name: "Coffre", extensions: ["vault"] }],
    }),

  pickImageDestination: (): Promise<string | null> =>
    save({
      title: "Enregistrer l'image du kit de récupération",
      defaultPath: "coffre-kit-de-recuperation.png",
      filters: [{ name: "Image PNG", extensions: ["png"] }],
    }),

  pickQrCodeDestination: (): Promise<string | null> =>
    save({
      title: "Enregistrer le QR code du kit de récupération",
      defaultPath: "coffre-kit-de-recuperation-qr.png",
      filters: [{ name: "Image PNG", extensions: ["png"] }],
    }),

  pickCarrierImage: async (): Promise<string | null> => {
    const result = await open({
      title: "Choisir une image porteuse",
      multiple: false,
      directory: false,
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "bmp"] }],
    });
    return Array.isArray(result) ? result[0] ?? null : result;
  },

  pickStegoOutputDestination: (): Promise<string | null> =>
    save({
      title: "Enregistrer l'image contenant le coffre caché",
      defaultPath: "photo-coffre-cache.png",
      filters: [{ name: "Image PNG", extensions: ["png"] }],
    }),

  pickStegoImageToExtract: async (): Promise<string | null> => {
    const result = await open({
      title: "Choisir l'image contenant le coffre caché",
      multiple: false,
      directory: false,
      filters: [{ name: "Image PNG", extensions: ["png"] }],
    });
    return Array.isArray(result) ? result[0] ?? null : result;
  },

  pickStegoExtractDestination: (): Promise<string | null> =>
    save({
      title: "Enregistrer le coffre extrait",
      defaultPath: "coffre-extrait.vault",
      filters: [{ name: "Coffre", extensions: ["vault"] }],
    }),

  pickCsvExportDestination: (defaultPath: string): Promise<string | null> =>
    save({
      title: "Exporter vers un fichier CSV",
      defaultPath,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    }),

  pickEncryptedExportDestination: (): Promise<string | null> =>
    save({
      title: "Exporter une sauvegarde chiffrée (.json)",
      defaultPath: `coffre-export-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "Export chiffré Coffre", extensions: ["json"] }],
    }),

  pickEncryptedExportToImport: async (): Promise<string | null> => {
    const result = await open({
      title: "Sélectionner un export chiffré (.json)",
      multiple: false,
      directory: false,
      filters: [{ name: "Export chiffré Coffre", extensions: ["json"] }],
    });
    return Array.isArray(result) ? result[0] ?? null : result;
  },

  createLocalVault: (path: string, masterPassword: string): Promise<CreateVaultResult> =>
    invoke("create_local_vault", { path, masterPassword }),

  unlockLocalVault: (path: string, masterPassword: string): Promise<VaultSnapshot> =>
    invoke("unlock_local_vault", { path, masterPassword }),

  unlockLocalVaultWithRecovery: (path: string, recoveryCode: string): Promise<VaultSnapshot> =>
    invoke("unlock_local_vault_with_recovery", { path, recoveryCode }),

  lockVault: (): Promise<void> => invoke("lock_vault"),

  addItem: (item: ItemDraft): Promise<VaultSnapshot> => invoke("add_item", { item }),

  importItems: (items: ItemDraft[]): Promise<VaultSnapshot> => invoke("import_items", { items }),

  /** Mise à jour groupée — une seule écriture disque pour N entrées.
   * Utilisé par l'import CSV (ConflictResolver, option "Remplacer"). */
  updateItemsBulk: (items: VaultItem[]): Promise<VaultSnapshot> => invoke("update_items_bulk", { items }),

  updateItem: (item: VaultItem): Promise<VaultSnapshot> => invoke("update_item", { item }),

  toggleFavorite: (id: string): Promise<VaultSnapshot> => invoke("toggle_favorite", { id }),

  deleteItem: (id: string): Promise<VaultSnapshot> => invoke("delete_item", { id }),
  markItemUsed: (id: string): Promise<VaultSnapshot> => invoke("mark_item_used", { id }),

  bulkDeleteItems: (ids: string[]): Promise<VaultSnapshot> => invoke("bulk_delete_items", { ids }),
  bulkSetCategory: (ids: string[], category: string): Promise<VaultSnapshot> =>
    invoke("bulk_set_category", { ids, category }),
  bulkAddTag: (ids: string[], tag: string): Promise<VaultSnapshot> => invoke("bulk_add_tag", { ids, tag }),

  createAlbum: (name: string): Promise<VaultSnapshot> => invoke("create_album", { name }),
  renameAlbum: (oldName: string, newName: string): Promise<VaultSnapshot> =>
    invoke("rename_album", { oldName, newName }),
  deleteAlbum: (name: string): Promise<VaultSnapshot> => invoke("delete_album", { name }),

  verifyMasterPassword: (candidate: string): Promise<boolean> =>
    invoke("verify_master_password_cmd", { candidate }),

  changeMasterPassword: (newPassword: string): Promise<void> =>
    invoke("change_master_password_cmd", { newPassword }),

  generatePassword: (options: GeneratorOptions): Promise<string> =>
    invoke("generate_password_cmd", { options }),

  exportBackup: (destination: string): Promise<void> => invoke("export_backup", { destination }),

  pickBackupFolder: async (): Promise<string | null> => {
    const result = await open({ title: "Choisir un dossier pour les sauvegardes automatiques", directory: true });
    return Array.isArray(result) ? result[0] ?? null : result;
  },

  autoBackup: (folder: string, keep: number): Promise<string> => invoke("auto_backup", { folder, keep }),

  confirmRecoveryKitSaved: (): Promise<VaultSnapshot> => invoke("confirm_recovery_kit_saved"),

  readTextFile: (path: string): Promise<string> => invoke("read_text_file", { path }),

  writeBinaryFile: (path: string, base64Data: string): Promise<void> =>
    invoke("write_binary_file", { path, base64Data }),

  readBinaryFile: (path: string): Promise<string> => invoke("read_binary_file", { path }),

  // ── Biométrie (trousseau OS) ──────────────────────────────────────────────
  // Ces commandes délèguent la protection du master password au trousseau OS
  // natif (Windows Credential Manager, macOS Keychain, libsecret Linux).
  // L'accès peut être conditionné à un geste biométrique si l'utilisateur
  // a configuré Windows Hello / Touch ID sur son compte OS.
  keyring: {
    save: (masterPassword: string): Promise<void> =>
      invoke("keyring_save_master_password", { masterPassword }),
    get: (): Promise<string | null> =>
      invoke("keyring_get_master_password"),
    delete: (): Promise<void> =>
      invoke("keyring_delete_master_password"),
    isConfigured: (): Promise<boolean> =>
      invoke("keyring_is_configured"),
  },
};

/** true si l'app tourne bien dans une webview Tauri (et pas un navigateur classique en dev) */
export function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}
