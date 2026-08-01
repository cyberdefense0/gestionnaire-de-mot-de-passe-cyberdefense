import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import type { VaultItem, GeneratorOptions } from "../types";

/**
 * Toutes les opérations sensibles (dérivation de clé, chiffrement,
 * déchiffrement, accès disque) se font côté Rust — voir src-tauri/src/lib.rs
 * et vault-core/src/lib.rs. Le frontend ne manipule que des VaultItem en
 * clair une fois le vault déverrouillé, jamais le master password après
 * l'appel initial, jamais la clé de chiffrement.
 *
 * Les boîtes de dialogue de fichier (pick*) appellent directement le plugin
 * JS (asynchrone, basé sur des promesses) plutôt qu'une commande Rust
 * "bloquante" : sur Linux, appeler une API de dialogue GTK bloquante depuis
 * une commande Rust peut geler l'application ("ne répond pas") si elle
 * s'exécute sur le mauvais thread. L'appel direct depuis le frontend évite
 * complètement ce problème et c'est l'approche recommandée par Tauri.
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

export type ItemDraft = Omit<VaultItem, "id" | "created_at" | "updated_at" | "password_history">;

export const vaultApi = {
  /** Ouvre la boîte de dialogue "Enregistrer sous" pour choisir où créer le fichier .vault */
  pickNewVaultPath: (): Promise<string | null> =>
    save({ title: "Créer le coffre", defaultPath: "mon-coffre.vault", filters: [{ name: "Coffre", extensions: ["vault"] }] }),

  /** Ouvre la boîte de dialogue "Ouvrir" pour sélectionner un fichier .vault existant */
  pickExistingVaultPath: async (): Promise<string | null> => {
    const result = await open({
      title: "Sélectionner un coffre",
      multiple: false,
      directory: false,
      filters: [{ name: "Coffre", extensions: ["vault"] }],
    });
    return Array.isArray(result) ? result[0] ?? null : result;
  },

  /** Boîte de dialogue pour choisir où déposer un fichier CSV à importer */
  pickCsvFile: async (): Promise<string | null> => {
    const result = await open({
      title: "Sélectionner un fichier CSV",
      multiple: false,
      directory: false,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    return Array.isArray(result) ? result[0] ?? null : result;
  },

  /** Boîte de dialogue pour choisir la destination d'une sauvegarde chiffrée */
  pickBackupDestination: (): Promise<string | null> =>
    save({
      title: "Exporter une sauvegarde",
      defaultPath: `coffre-sauvegarde-${new Date().toISOString().slice(0, 10)}.vault`,
      filters: [{ name: "Coffre", extensions: ["vault"] }],
    }),

  /** Boîte de dialogue pour choisir où enregistrer l'image du kit de récupération */
  pickImageDestination: (): Promise<string | null> =>
    save({
      title: "Enregistrer l'image du kit de récupération",
      defaultPath: "coffre-kit-de-recuperation.png",
      filters: [{ name: "Image PNG", extensions: ["png"] }],
    }),

  /** Boîte de dialogue pour choisir où enregistrer le QR code du kit de récupération */
  pickQrCodeDestination: (): Promise<string | null> =>
    save({
      title: "Enregistrer le QR code du kit de récupération",
      defaultPath: "coffre-kit-de-recuperation-qr.png",
      filters: [{ name: "Image PNG", extensions: ["png"] }],
    }),

  createLocalVault: (path: string, masterPassword: string): Promise<CreateVaultResult> =>
    invoke("create_local_vault", { path, masterPassword }),

  unlockLocalVault: (path: string, masterPassword: string): Promise<VaultSnapshot> =>
    invoke("unlock_local_vault", { path, masterPassword }),

  unlockLocalVaultWithRecovery: (path: string, recoveryCode: string): Promise<VaultSnapshot> =>
    invoke("unlock_local_vault_with_recovery", { path, recoveryCode }),

  lockVault: (): Promise<void> => invoke("lock_vault"),

  addItem: (item: ItemDraft): Promise<VaultSnapshot> => invoke("add_item", { item }),

  importItems: (items: ItemDraft[]): Promise<VaultSnapshot> => invoke("import_items", { items }),

  updateItem: (item: VaultItem): Promise<VaultSnapshot> => invoke("update_item", { item }),

  toggleFavorite: (id: string): Promise<VaultSnapshot> => invoke("toggle_favorite", { id }),

  deleteItem: (id: string): Promise<VaultSnapshot> => invoke("delete_item", { id }),

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

  /** À appeler après que l'utilisateur confirme avoir sauvegardé/imprimé son kit de récupération
   * (à la création, ou en réponse au rappel périodique affiché dans VaultView). */
  confirmRecoveryKitSaved: (): Promise<VaultSnapshot> => invoke("confirm_recovery_kit_saved"),

  readTextFile: (path: string): Promise<string> => invoke("read_text_file", { path }),

  writeBinaryFile: (path: string, base64Data: string): Promise<void> =>
    invoke("write_binary_file", { path, base64Data }),
};

/** true si l'app tourne bien dans une webview Tauri (et pas un navigateur classique en dev) */
export function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}
