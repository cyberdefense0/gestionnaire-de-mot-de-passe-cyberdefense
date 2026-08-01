import { useState } from "react";
import { vaultApi, type VaultSnapshot } from "../lib/tauri";
import { parseImportCsv, type ImportPreview } from "../lib/csvImport";
import { useEscapeKey } from "../lib/useEscapeKey";

interface Props {
  onClose: () => void;
  onImported: (snapshot: VaultSnapshot, count: number) => void;
}

export function ImportCsv({ onClose, onImported }: Props) {
  useEscapeKey(onClose);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const pickFile = async () => {
    setError(null);
    const path = await vaultApi.pickCsvFile();
    if (!path) return;
    try {
      const content = await vaultApi.readTextFile(path);
      const result = parseImportCsv(content);
      if (result.drafts.length === 0) {
        setError("Aucune entrée exploitable trouvée dans ce fichier.");
        return;
      }
      setPreview(result);
    } catch (e) {
      setError("Impossible de lire ce fichier CSV.");
      console.error(e);
    }
  };

  const confirmImport = async () => {
    if (!preview) return;
    setLoading(true);
    try {
      const snapshot = await vaultApi.importItems(preview.drafts);
      onImported(snapshot, preview.drafts.length);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-base/90 backdrop-blur-sm flex items-center justify-center px-6 z-40">
      <div className="max-w-lg w-full bg-surface border border-edge rounded-2xl p-7 max-h-[85vh] flex flex-col">
        <h2 className="font-display text-2xl font-medium mb-2 text-primary">Importer un fichier CSV</h2>
        <p className="text-sm text-muted mb-5">
          Détection automatique du format : Chrome, Edge, Brave, Firefox, Bitwarden, LastPass — ou générique.
        </p>

        {!preview ? (
          <button
            onClick={pickFile}
            className="border-2 border-dashed border-edge rounded-xl py-10 text-center text-sm text-muted hover:border-brand/50 hover:text-accent transition-colors"
          >
            Choisir un fichier .csv…
          </button>
        ) : (
          <div className="overflow-y-auto -mx-1 px-1">
            <div className="mb-3 p-3 rounded-xl bg-base border border-edge text-sm">
              <p className="text-primary">
                Format détecté : <span className="text-accent">{preview.source}</span>
              </p>
              <p className="text-muted mt-1">
                {preview.drafts.length} entrée{preview.drafts.length > 1 ? "s" : ""} prête
                {preview.drafts.length > 1 ? "s" : ""} à importer
                {preview.skipped > 0 ? ` (${preview.skipped} ligne(s) ignorée(s))` : ""}.
              </p>
            </div>
            <div className="space-y-1.5 mb-4">
              {preview.drafts.slice(0, 8).map((d, i) => (
                <div key={i} className="px-3 py-2 rounded-lg border border-edge bg-base text-sm flex items-center justify-between gap-2">
                  <span className="text-primary truncate">{d.title}</span>
                  <span className="text-xs text-muted truncate">{d.username || "—"}</span>
                </div>
              ))}
              {preview.drafts.length > 8 && (
                <p className="text-xs text-muted text-center py-1">… et {preview.drafts.length - 8} autres</p>
              )}
            </div>
          </div>
        )}

        {error && <p className="text-sm text-signal-red mt-3">{error}</p>}

        <div className="flex gap-3 mt-6">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-edge text-sm text-muted hover:text-primary transition-colors">
            Annuler
          </button>
          {preview && (
            <button
              onClick={confirmImport}
              disabled={loading}
              className="flex-1 py-2.5 rounded-xl bg-brand text-on-brand text-sm font-medium hover:bg-brand-hover transition-colors disabled:opacity-50"
            >
              {loading ? "Import…" : `Importer ${preview.drafts.length} entrée(s)`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
