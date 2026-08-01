import { useState } from "react";
import { vaultApi } from "../lib/tauri";
import { ChangeMasterPassword } from "./ChangeMasterPassword";
import { useEscapeKey } from "../lib/useEscapeKey";

interface Props {
  onClose: () => void;
}

export function VaultSettings({ onClose }: Props) {
  useEscapeKey(onClose);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);

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
