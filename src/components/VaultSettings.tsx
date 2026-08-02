import { useState } from "react";
import { vaultApi } from "../lib/tauri";
import { ChangeMasterPassword } from "./ChangeMasterPassword";
import { useEscapeKey } from "../lib/useEscapeKey";
import { useAutoLockMinutes, AUTO_LOCK_OPTIONS } from "../lib/autoLock";
import { useLockOnBlur } from "../lib/lockOnBlur";
import { useAutoBackupSettings, AUTO_BACKUP_FREQUENCIES, AUTO_BACKUP_KEEP } from "../lib/autoBackup";
import { exportBitwardenCsv, exportKeepassCsv, utf8ToBase64 } from "../lib/csvExport";
import { checkForUpdate, installPendingUpdate } from "../lib/updater";
import type { VaultItem } from "../types";

interface Props {
  items: VaultItem[];
  onClose: () => void;
}

export function VaultSettings({ items, onClose }: Props) {
  useEscapeKey(onClose);
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

  return (
    <div className="fixed inset-0 bg-base/90 backdrop-blur-sm flex items-center justify-center px-6 z-40">
      <div className="max-w-md w-full bg-surface border border-edge rounded-2xl p-7">
        <div className="flex items-center justify-between mb-6">
          <h2 className="font-display text-2xl font-medium text-primary">Paramètres du coffre</h2>
          <button onClick={onClose} className="text-muted hover:text-primary text-sm px-2 py-1">
            Fermer
          </button>
        </div>

        <div className="space-y-2">
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
            <button
              onClick={() => setLockOnBlur(!lockOnBlur)}
              className={`shrink-0 w-11 h-6 rounded-full transition-colors relative ${lockOnBlur ? "bg-brand" : "bg-edge-strong"}`}
            >
              <span
                className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform ${lockOnBlur ? "translate-x-5" : "translate-x-0.5"}`}
              />
            </button>
          </div>
          <div className="p-4 rounded-xl border border-edge bg-base space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-primary">Sauvegardes automatiques</p>
                <p className="text-xs text-muted mt-0.5">
                  Copie datée du coffre chiffré vers un dossier de votre choix, à intervalle régulier. Les {AUTO_BACKUP_KEEP} plus récentes sont conservées, les plus anciennes sont supprimées automatiquement.
                </p>
              </div>
              <button
                onClick={() => updateAutoBackup({ enabled: !autoBackup.enabled })}
                disabled={!autoBackup.folder}
                className={`shrink-0 w-11 h-6 rounded-full transition-colors relative disabled:opacity-40 ${
                  autoBackup.enabled ? "bg-brand" : "bg-edge-strong"
                }`}
              >
                <span
                  className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                    autoBackup.enabled ? "translate-x-5" : "translate-x-0.5"
                  }`}
                />
              </button>
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
          </div>
          <SettingRow
            title="Changer le master password"
            description="Met à jour le mot de passe qui protège le chiffrement de votre coffre."
            action="Modifier"
            onClick={() => setShowChangePassword(true)}
          />
          <SettingRow
            title="Exporter une sauvegarde chiffrée"
            description="Copie de votre fichier .vault, toujours entièrement chiffrée, vers un autre emplacement."
            action="Exporter"
            onClick={exportBackup}
          />
          <div className="p-4 rounded-xl border border-edge bg-base space-y-2">
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
          </div>
          <div className="p-4 rounded-xl border border-edge bg-base space-y-2">
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
          </div>
        </div>

        {exportStatus && <p className="text-sm text-accent mt-4">{exportStatus}</p>}
      </div>
    </div>
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
