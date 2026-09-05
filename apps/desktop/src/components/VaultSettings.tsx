import { useState } from "react";
import { vaultApi } from "../lib/tauri";
import { ChangeMasterPassword } from "./ChangeMasterPassword";
import { useEscapeKey } from "../lib/useEscapeKey";
import { useAutoLockMinutes, AUTO_LOCK_OPTIONS } from "../lib/autoLock";
import { useLockOnBlur } from "../lib/lockOnBlur";
import { useAutoBackupSettings, AUTO_BACKUP_FREQUENCIES, AUTO_BACKUP_KEEP } from "../lib/autoBackup";
import { exportBitwardenCsv, exportKeepassCsv, utf8ToBase64 } from "../lib/csvExport";
import { checkForUpdate, installPendingUpdate } from "../lib/updater";
import { createEncryptedExport, readEncryptedExport, EncryptedExportError } from "../lib/encryptedExport";
import { useHibpMonitoringSettings, HIBP_CHECK_INTERVAL_HOURS } from "../lib/hibpMonitoring";
import { isMobilePlatform } from "../lib/platform";
import type { VaultItem } from "../types";
import type { VaultSnapshot } from "../lib/tauri";
import { PinSettings } from "./PinUnlock";

interface Props {
  items: VaultItem[];
  categories: string[];
  onImported: (snapshot: VaultSnapshot) => void;
  /** Ouvre le panneau statistiques (nouveau). */
  onShowStats?: () => void;
  onClose: () => void;
  /**
   * Mode embarqué (mobile bottom sheet) : supprime le wrapper `fixed inset-0`
   * et l'en-tête interne (titre + bouton ✕) qui sont déjà fournis par
   * MobileBottomNav. Le contenu est rendu directement, scrollable dans son
   * conteneur parent.
   */
  embedded?: boolean;
}

export function VaultSettings({ items, categories, onImported, onShowStats, onClose, embedded }: Props) {
  useEscapeKey(embedded ? () => {} : onClose);
  // Première passe mobile : le vault vit dans le stockage privé de l'app,
  // pas de sélecteur de fichier natif façon desktop — toutes les sections
  // ci-dessous qui dépendent d'un choix d'emplacement (sauvegardes,
  // export/import CSV, export chiffré .json, mises à jour via le plugin
  // updater absent sur mobile) sont masquées plutôt que proposées puis en
  // échec silencieux. Voir lib/platform.ts et DEV_NOTES.md.
  const mobile = isMobilePlatform();
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [csvExportStatus, setCsvExportStatus] = useState<string | null>(null);
  const { minutes: autoLockMinutes, setMinutes: setAutoLockMinutes } = useAutoLockMinutes();
  const { enabled: lockOnBlur, setEnabled: setLockOnBlur } = useLockOnBlur();
  const { settings: autoBackup, update: updateAutoBackup } = useAutoBackupSettings();
  const [pickingFolder, setPickingFolder] = useState(false);
  const [updateCheckStatus, setUpdateCheckStatus] = useState<string | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const { settings: hibpMonitoring, update: updateHibpMonitoring } = useHibpMonitoringSettings();

  // --- Export chiffré indépendant (.json), mot de passe dédié — roadmap §2.2 ---
  const [showEncryptedExport, setShowEncryptedExport] = useState(false);
  const [showEncryptedImport, setShowEncryptedImport] = useState(false);
  const [exportPassword, setExportPassword] = useState("");
  const [exportPasswordConfirm, setExportPasswordConfirm] = useState("");
  const [importPassword, setImportPassword] = useState("");
  const [encryptedExportStatus, setEncryptedExportStatus] = useState<string | null>(null);
  const [encryptedImportStatus, setEncryptedImportStatus] = useState<string | null>(null);
  const [busyEncrypted, setBusyEncrypted] = useState(false);

  const runEncryptedExport = async () => {
    setEncryptedExportStatus(null);
    if (exportPassword !== exportPasswordConfirm) {
      setEncryptedExportStatus("Les deux mots de passe d'export ne correspondent pas.");
      return;
    }
    setBusyEncrypted(true);
    try {
      const dest = await vaultApi.pickEncryptedExportDestination();
      if (!dest) return;
      const json = await createEncryptedExport(items, categories, exportPassword);
      await vaultApi.writeBinaryFile(dest, utf8ToBase64(json));
      setEncryptedExportStatus("Export chiffré créé avec succès. Conservez le mot de passe d'export séparément — il n'est ni stocké ni récupérable.");
      setExportPassword("");
      setExportPasswordConfirm("");
    } catch (e) {
      setEncryptedExportStatus(`Échec : ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusyEncrypted(false);
    }
  };

  const runEncryptedImport = async () => {
    setEncryptedImportStatus(null);
    setBusyEncrypted(true);
    try {
      const path = await vaultApi.pickEncryptedExportToImport();
      if (!path) return;
      const fileContent = await vaultApi.readTextFile(path);
      const payload = await readEncryptedExport(fileContent, importPassword);
      const drafts = payload.items.map((item) => ({
        item_type: item.item_type,
        title: item.title,
        username: item.username,
        password: item.password,
        url: item.url,
        notes: item.notes,
        category: item.category,
        tags: item.tags,
        favorite: item.favorite,
        expires_at: item.expires_at,
        custom_fields: item.custom_fields,
        attachments: item.attachments,
        passkey: item.passkey,
        generation_rule: item.generation_rule,
      }));
      const snapshot = await vaultApi.importItems(drafts);
      onImported(snapshot);
      setEncryptedImportStatus(`${drafts.length} entrée(s) importée(s) avec succès.`);
      setImportPassword("");
      setShowEncryptedImport(false);
    } catch (e) {
      setEncryptedImportStatus(e instanceof EncryptedExportError ? e.message : `Échec : ${e}`);
    } finally {
      setBusyEncrypted(false);
    }
  };

  const checkUpdateManually = async () => {
    setCheckingUpdate(true);
    setUpdateCheckStatus(null);
    try {
      const info = await checkForUpdate();
      setUpdateCheckStatus(info ? `Version ${info.version} disponible !` : "Vous avez déjà la dernière version.");
    } finally {
      setCheckingUpdate(false);
    }
  };

  const installUpdateManually = async () => {
    setInstallingUpdate(true);
    try {
      await installPendingUpdate();
    } catch (e) {
      setUpdateCheckStatus(`Échec de la mise à jour : ${e}`);
      setInstallingUpdate(false);
    }
  };

  const exportCsv = async (format: "bitwarden" | "keepass") => {
    setCsvExportStatus(null);
    try {
      const defaultPath = format === "bitwarden" ? "coffre-export-bitwarden.csv" : "coffre-export-keepass.csv";
      const dest = await vaultApi.pickCsvExportDestination(defaultPath);
      if (!dest) return;
      const csv = format === "bitwarden" ? exportBitwardenCsv(items) : exportKeepassCsv(items);
      await vaultApi.writeBinaryFile(dest, utf8ToBase64(csv));
      setCsvExportStatus(`Export ${format === "bitwarden" ? "Bitwarden" : "KeePass"} réussi — pensez à supprimer ce fichier après import (les mots de passe y sont en clair).`);
    } catch (e) {
      setCsvExportStatus(`Échec de l'export : ${e}`);
    }
  };

  const chooseBackupFolder = async () => {
    setPickingFolder(true);
    try {
      const folder = await vaultApi.pickBackupFolder();
      if (folder) updateAutoBackup({ folder, enabled: true });
    } finally {
      setPickingFolder(false);
    }
  };

  const exportBackup = async () => {
    setExportStatus(null);
    const dest = await vaultApi.pickBackupDestination();
    if (!dest) return;
    try {
      await vaultApi.exportBackup(dest);
      setExportStatus("Sauvegarde créée avec succès.");
    } catch (e) {
      setExportStatus(`Échec : ${e}`);
    }
  };

  if (showChangePassword) {
    return <ChangeMasterPassword onClose={() => setShowChangePassword(false)} />;
  }

  // En mode embarqué (bottom sheet mobile), on rend le contenu directement
  // sans wrapper fixed/modal — MobileBottomNav fournit déjà le cadre,
  // le titre et le bouton de fermeture.
  const content = (
    <>
      {/* En-tête interne : affiché uniquement hors mode embarqué */}
      {!embedded && (
        <div className="flex items-center justify-between mb-6 shrink-0">
          <h2 className="font-display text-2xl font-medium text-primary">Paramètres du coffre</h2>
          <div className="flex items-center gap-2">
            {onShowStats && (
              <button
                onClick={onShowStats}
                className="text-xs px-3 py-1.5 rounded-lg border border-edge text-muted hover:text-accent hover:border-brand/40 transition-colors"
                title="Statistiques du coffre"
              >
                📊 Statistiques
              </button>
            )}
            <button
              onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-muted hover:text-primary hover:bg-surface-2 transition-colors"
              title="Fermer (Échap)"
            >
              ✕
            </button>
          </div>
        </div>
      )}
      {/* Bouton Statistiques en mode embarqué (l'en-tête interne est masqué) */}
      {embedded && onShowStats && (
        <div className="px-5 pt-3 pb-1">
          <button
            onClick={onShowStats}
            className="text-xs px-3 py-1.5 rounded-lg border border-edge text-muted hover:text-accent hover:border-brand/40 transition-colors"
            title="Statistiques du coffre"
          >
            📊 Statistiques
          </button>
        </div>
      )}

      <div className={`space-y-2 ${embedded ? "px-5 py-4" : "overflow-y-auto pr-1 -mr-1"}`}>
          <div className="flex items-center justify-between gap-4 p-4 rounded-xl border border-edge bg-base">
            <div className="min-w-0">
              <p className="text-sm font-medium text-primary">Verrouillage automatique</p>
              <p className="text-xs text-muted mt-0.5">
                Verrouille le coffre après cette durée d'inactivité. Raccourci <code>Ctrl/Cmd+L</code> pour verrouiller immédiatement à tout moment.
              </p>
            </div>
            <select
              value={autoLockMinutes}
              onChange={(e) => setAutoLockMinutes(Number(e.target.value))}
              className="shrink-0 text-xs px-3 py-2 rounded-lg border border-edge bg-surface text-primary outline-none focus:border-brand/50"
            >
              {AUTO_LOCK_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m === 0 ? "Jamais" : `${m} min`}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center justify-between gap-4 p-4 rounded-xl border border-edge bg-base">
            <div className="min-w-0">
              <p className="text-sm font-medium text-primary">Verrouiller si la fenêtre perd le focus</p>
              <p className="text-xs text-muted mt-0.5">
                Couvre la mise en veille de l'écran et le verrouillage de session, mais se déclenche aussi sur un simple changement de fenêtre (Alt+Tab). Désactivé par défaut pour cette raison.
              </p>
            </div>
            <ToggleSwitch checked={lockOnBlur} onChange={() => setLockOnBlur(!lockOnBlur)} />
          </div>
          {!mobile && <div className="p-4 rounded-xl border border-edge bg-base space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-primary">Sauvegardes automatiques</p>
                <p className="text-xs text-muted mt-0.5">
                  Copie datée du coffre chiffré vers un dossier de votre choix, à intervalle régulier. Les {AUTO_BACKUP_KEEP} plus récentes sont conservées, les plus anciennes sont supprimées automatiquement.
                </p>
              </div>
              <ToggleSwitch
                checked={autoBackup.enabled}
                onChange={() => updateAutoBackup({ enabled: !autoBackup.enabled })}
                disabled={!autoBackup.folder}
              />
            </div>

            <button
              onClick={chooseBackupFolder}
              disabled={pickingFolder}
              className="w-full text-left text-xs px-3 py-2.5 rounded-lg border border-edge bg-surface text-muted hover:border-brand/50 transition-colors truncate disabled:opacity-50"
            >
              📁 {autoBackup.folder ?? "Choisir un dossier de destination…"}
            </button>

            {autoBackup.folder && (
              <div className="flex items-center justify-between gap-3">
                <select
                  value={autoBackup.frequencyHours}
                  onChange={(e) => updateAutoBackup({ frequencyHours: Number(e.target.value) })}
                  className="text-xs px-3 py-2 rounded-lg border border-edge bg-surface text-primary outline-none focus:border-brand/50"
                >
                  {AUTO_BACKUP_FREQUENCIES.map((f) => (
                    <option key={f.hours} value={f.hours}>
                      {f.label}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-muted">
                  {autoBackup.lastBackupAt
                    ? `Dernière : ${new Date(autoBackup.lastBackupAt).toLocaleDateString("fr-FR")}`
                    : "Aucune sauvegarde effectuée pour l'instant"}
                </span>
              </div>
            )}
          </div>}
          <div className="flex items-center justify-between gap-4 p-4 rounded-xl border border-edge bg-base">
            <div className="min-w-0">
              <p className="text-sm font-medium text-primary">Surveillance HIBP continue</p>
              <p className="text-xs text-muted mt-0.5">
                Revérifie automatiquement vos mots de passe contre les fuites connues (Have I Been Pwned, k-anonymat — voir audit de sécurité) toutes les {HIBP_CHECK_INTERVAL_HOURS}h tant que le coffre est ouvert. Notification native uniquement pour une <em>nouvelle</em> compromission.
                {hibpMonitoring.lastCheckAt && (
                  <> Dernière vérification : {new Date(hibpMonitoring.lastCheckAt).toLocaleString("fr-FR")}.</>
                )}
              </p>
            </div>
            <ToggleSwitch checked={hibpMonitoring.enabled} onChange={() => updateHibpMonitoring({ enabled: !hibpMonitoring.enabled })} />
          </div>
          <PinSettings
            onVerifyMasterPassword={async (mp) => {
              try {
                return await vaultApi.verifyMasterPassword(mp);
              } catch {
                return false;
              }
            }}
          />
          <SettingRow
            title="Changer le master password"
            description="Met à jour le mot de passe qui protège le chiffrement de votre coffre."
            action="Modifier"
            onClick={() => setShowChangePassword(true)}
          />
          {!mobile && <SettingRow
            title="Exporter une sauvegarde chiffrée"
            description="Copie de votre fichier .vault, toujours entièrement chiffrée, vers un autre emplacement."
            action="Exporter"
            onClick={exportBackup}
          />}
          {!mobile && <div className="p-4 rounded-xl border border-edge bg-base space-y-2">
            <p className="text-sm font-medium text-primary">Export chiffré indépendant (.json)</p>
            <p className="text-xs text-muted">
              Format de migration/restauration léger (items + albums), chiffré en AES-256-GCM avec un{" "}
              <strong>mot de passe d'export dédié</strong>, différent du master password — pratique pour transférer vos
              données vers une autre instance sans copier tout le fichier <code>.vault</code>. Ce mot de passe n'est
              jamais stocké : sans lui, l'export n'est plus récupérable.
            </p>
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => {
                  setShowEncryptedExport((v) => !v);
                  setShowEncryptedImport(false);
                }}
                className="flex-1 text-xs py-2 rounded-lg border border-edge text-accent hover:border-brand/50 transition-colors"
              >
                Exporter…
              </button>
              <button
                onClick={() => {
                  setShowEncryptedImport((v) => !v);
                  setShowEncryptedExport(false);
                }}
                className="flex-1 text-xs py-2 rounded-lg border border-edge text-accent hover:border-brand/50 transition-colors"
              >
                Restaurer…
              </button>
            </div>

            {showEncryptedExport && (
              <div className="space-y-2 pt-2 border-t border-edge">
                <input
                  type="password"
                  value={exportPassword}
                  onChange={(e) => setExportPassword(e.target.value)}
                  placeholder="Mot de passe d'export (8 caractères min.)"
                  className="input text-xs"
                />
                <input
                  type="password"
                  value={exportPasswordConfirm}
                  onChange={(e) => setExportPasswordConfirm(e.target.value)}
                  placeholder="Confirmer le mot de passe d'export"
                  className="input text-xs"
                />
                <button
                  onClick={runEncryptedExport}
                  disabled={busyEncrypted || exportPassword.length < 8}
                  className="w-full text-xs py-2 rounded-lg bg-brand/10 border border-brand/30 text-accent-strong hover:bg-brand/20 transition-colors disabled:opacity-50"
                >
                  {busyEncrypted ? "Export en cours…" : "Choisir la destination et exporter"}
                </button>
              </div>
            )}
            {showEncryptedImport && (
              <div className="space-y-2 pt-2 border-t border-edge">
                <p className="text-xs text-signal-amber">
                  ⚠️ Les entrées de ce fichier seront <strong>ajoutées</strong> à votre coffre actuel (pas de remplacement).
                </p>
                <input
                  type="password"
                  value={importPassword}
                  onChange={(e) => setImportPassword(e.target.value)}
                  placeholder="Mot de passe d'export du fichier"
                  className="input text-xs"
                />
                <button
                  onClick={runEncryptedImport}
                  disabled={busyEncrypted || !importPassword}
                  className="w-full text-xs py-2 rounded-lg bg-brand/10 border border-brand/30 text-accent-strong hover:bg-brand/20 transition-colors disabled:opacity-50"
                >
                  {busyEncrypted ? "Import en cours…" : "Choisir le fichier et restaurer"}
                </button>
              </div>
            )}
            {encryptedExportStatus && (
              <p className={`text-xs ${encryptedExportStatus.startsWith("Échec") ? "text-signal-red" : "text-signal-green"}`}>{encryptedExportStatus}</p>
            )}
            {encryptedImportStatus && (
              <p className={`text-xs ${encryptedImportStatus.startsWith("Échec") ? "text-signal-red" : "text-signal-green"}`}>{encryptedImportStatus}</p>
            )}
          </div>}
          {!mobile && <div className="p-4 rounded-xl border border-edge bg-base space-y-2">
            <p className="text-sm font-medium text-primary">Exporter vers un autre gestionnaire</p>
            <p className="text-xs text-muted">
              ⚠️ Contrairement aux exports ci-dessus, ces fichiers contiennent tous vos mots de passe <strong>en clair</strong> — c'est
              le format attendu par ces gestionnaires, pas un choix de cette app. À supprimer après import.
            </p>
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => exportCsv("bitwarden")}
                className="flex-1 text-xs py-2 rounded-lg border border-edge text-accent hover:border-brand/50 transition-colors"
              >
                Vers Bitwarden (CSV)
              </button>
              <button
                onClick={() => exportCsv("keepass")}
                className="flex-1 text-xs py-2 rounded-lg border border-edge text-accent hover:border-brand/50 transition-colors"
              >
                Vers KeePass (CSV)
              </button>
            </div>
            {csvExportStatus && (
              <p className={`text-xs ${csvExportStatus.startsWith("Échec") ? "text-signal-red" : "text-signal-green"}`}>{csvExportStatus}</p>
            )}
          </div>}
          {!mobile && <div className="p-4 rounded-xl border border-edge bg-base space-y-2">
            <p className="text-sm font-medium text-primary">Mises à jour</p>
            <p className="text-xs text-muted">
              Vérifié automatiquement à l'ouverture du coffre. Vous pouvez aussi vérifier manuellement ici.
            </p>
            <div className="flex gap-2">
              <button
                onClick={checkUpdateManually}
                disabled={checkingUpdate || installingUpdate}
                className="flex-1 text-xs py-2 rounded-lg border border-edge text-accent hover:border-brand/50 transition-colors disabled:opacity-50"
              >
                {checkingUpdate ? "Vérification…" : "Vérifier les mises à jour"}
              </button>
              {updateCheckStatus?.includes("disponible") && (
                <button
                  onClick={installUpdateManually}
                  disabled={installingUpdate}
                  className="flex-1 text-xs py-2 rounded-lg bg-brand/10 border border-brand/30 text-accent-strong hover:bg-brand/20 transition-colors disabled:opacity-50"
                >
                  {installingUpdate ? "Installation…" : "Installer et redémarrer"}
                </button>
              )}
            </div>
            {updateCheckStatus && (
              <p className={`text-xs ${updateCheckStatus.startsWith("Échec") ? "text-signal-red" : "text-muted"}`}>{updateCheckStatus}</p>
            )}
          </div>}
          {mobile && (
            <p className="text-xs text-muted p-4">
              Sauvegardes, exports CSV/chiffrés et mises à jour automatiques ne sont pas encore disponibles sur mobile
              dans cette première version — à venir dans une prochaine passe.
            </p>
          )}
        </div>

        {exportStatus && <p className={`text-sm text-accent mt-4 ${embedded ? "px-5" : ""}`}>{exportStatus}</p>}
      </>
  );

  // Mode modal desktop : enveloppé dans le fond semi-transparent + boîte centrée
  if (!embedded) {
    return (
      <div className="fixed inset-0 bg-base/90 backdrop-blur-sm flex items-center justify-center px-6 z-40">
        <div className="max-w-md w-full max-h-[85vh] bg-surface border border-edge rounded-2xl p-7 flex flex-col">
          {content}
        </div>
      </div>
    );
  }

  // Mode embarqué (bottom sheet mobile) : contenu directement, sans wrapper
  return content;
}

/**
 * Interrupteur on/off. Retour utilisateur : la version précédente (bouton +
 * span positionné en `absolute` sans `left` explicite, seulement une
 * translation) faisait sortir le curseur de son rail — sans point de
 * départ fixe, la position "statique" d'un absolu peut varier selon le
 * contexte de layout. Ici, position de départ explicite (`left-0.5`) et
 * décalage calculé en pixels réels (pas de dépendance à l'échelle
 * d'espacement Tailwind), donc toujours contenu dans le rail quel que soit
 * l'état.
 */
function ToggleSwitch({ checked, onChange, disabled }: { checked: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      disabled={disabled}
      className={`shrink-0 w-11 h-6 rounded-full transition-colors relative disabled:opacity-40 ${
        checked ? "bg-brand" : "bg-edge-strong"
      }`}
    >
      <span
        className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform"
        style={{ transform: checked ? "translateX(20px)" : "translateX(0px)" }}
      />
    </button>
  );
}

function SettingRow({ title, description, action, onClick }: { title: string; description: string; action: string; onClick: () => void }) {
  return (
    <div className="flex items-center justify-between gap-4 p-4 rounded-xl border border-edge bg-base">
      <div className="min-w-0">
        <p className="text-sm font-medium text-primary">{title}</p>
        <p className="text-xs text-muted mt-0.5">{description}</p>
      </div>
      <button
        onClick={onClick}
        className="shrink-0 text-xs px-3 py-2 rounded-lg border border-edge text-accent hover:border-brand/50 transition-colors"
      >
        {action}
      </button>
    </div>
  );
}
