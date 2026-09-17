/**
 * Import CSV avec résolution de conflits.
 *
 * Flux :
 *   1. L'utilisateur choisit un fichier CSV.
 *   2. Parsing + détection du format (Chrome/Firefox/Bitwarden/LastPass/générique).
 *   3. `ConflictResolver` gère les doublons → Ignorer / Remplacer / Garder les deux.
 *   4. Les entrées "Remplacer" passent par `vaultApi.updateItemsBulk` (une seule
 *      écriture disque pour N entrées — remplace la boucle O(n) précédente).
 *   5. Les entrées "Ajouter" passent par `vaultApi.importItems` en une seule écriture.
 */
import { useState } from "react";
import { vaultApi, type VaultSnapshot } from "../lib/tauri";
import { parseImportCsv, type ImportPreview } from "../lib/csvImport";
import type { ImportDraft } from "../lib/csvImport";
import { useEscapeKey } from "../lib/useEscapeKey";
import { ConflictResolver } from "./ConflictResolver";
import type { VaultItem } from "../types";

interface Props {
  existingItems: VaultItem[];
  onClose: () => void;
  onImported: (snapshot: VaultSnapshot, count: number) => void;
}

type Step = "pick" | "preview" | "resolve" | "importing";

export function ImportCsv({ existingItems, onClose, onImported }: Props) {
  useEscapeKey(onClose);
  const [step, setStep] = useState<Step>("pick");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null);

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
      setStep("preview");
    } catch (e) {
      setError("Impossible de lire ce fichier CSV.");
      console.error(e);
    }
  };

  const goToResolve = () => setStep("resolve");

  const handleResolved = async (
    toAdd: ImportDraft[],
    toReplace: { id: string; row: ImportDraft }[]
  ) => {
    if (!preview) return;
    setStep("importing");
    const total = toAdd.length + toReplace.length;
    setImportProgress({ done: 0, total });

    try {
      let lastSnapshot: VaultSnapshot | null = null;
      let done = 0;

      // Remplacements : une seule écriture disque via update_items_bulk
      if (toReplace.length > 0) {
        const updatedItems: VaultItem[] = toReplace
          .map(({ id, row }) => {
            const existing = existingItems.find((i) => i.id === id);
            if (!existing) return null;
            return {
              ...existing,
              title: row.title || existing.title,
              username: row.username ?? existing.username,
              password: row.password ?? existing.password,
              url: row.url ?? existing.url,
              notes: row.notes ?? existing.notes,
              category: row.category || existing.category,
            } satisfies VaultItem;
          })
          .filter((x): x is VaultItem => x !== null);

        if (updatedItems.length > 0) {
          lastSnapshot = await vaultApi.updateItemsBulk(updatedItems);
          done += updatedItems.length;
          setImportProgress({ done, total });
        }
      }

      // Ajouts : une seule écriture disque pour toutes les nouvelles entrées
      if (toAdd.length > 0) {
        lastSnapshot = await vaultApi.importItems(toAdd);
        done += toAdd.length;
        setImportProgress({ done, total });
      }

      if (lastSnapshot) {
        onImported(lastSnapshot, total);
      } else {
        onClose();
      }
    } catch (e) {
      setError(String(e));
      setStep("preview");
      setImportProgress(null);
    }
  };

  if (step === "importing") {
    const p = importProgress;
    const pct = p && p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
    return (
      <div className="fixed inset-0 bg-base/90 backdrop-blur-sm flex items-center justify-center px-6 z-40">
        <div className="max-w-sm w-full bg-surface border border-edge rounded-2xl p-8 flex flex-col items-center gap-4 text-center">
          <span className="text-4xl">⏳</span>
          <p className="text-primary font-medium">Import en cours…</p>
          {p && (
            <>
              <div className="w-full h-2 rounded-full bg-surface-2 overflow-hidden">
                <div className="h-full rounded-full bg-brand transition-all duration-200" style={{ width: `${pct}%` }} />
              </div>
              <p className="text-sm text-muted">{p.done} / {p.total} entrée{p.total > 1 ? "s" : ""}</p>
            </>
          )}
        </div>
      </div>
    );
  }

  if (step === "resolve" && preview) {
    return (
      <ConflictResolver
        imported={preview.drafts}
        existing={existingItems}
        onResolved={handleResolved}
        onCancel={() => setStep("preview")}
      />
    );
  }

  return (
    <div className="fixed inset-0 bg-base/90 backdrop-blur-sm flex items-center justify-center px-6 z-40">
      <div className="max-w-lg w-full bg-surface border border-edge rounded-2xl p-7 max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-display text-2xl font-medium text-primary">Importer un fichier CSV</h2>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg text-muted hover:text-primary hover:bg-surface-2 transition-colors" title="Fermer (Échap)">✕</button>
        </div>
        <p className="text-sm text-muted mb-5">
          Détection automatique du format : Chrome, Edge, Brave, Firefox, Bitwarden, LastPass — ou générique.
        </p>

        {step === "pick" && (
          <button onClick={pickFile} className="border-2 border-dashed border-edge rounded-xl py-10 text-center text-sm text-muted hover:border-brand/50 hover:text-accent transition-colors">
            📂 Choisir un fichier .csv…
          </button>
        )}

        {step === "preview" && preview && (
          <div className="overflow-y-auto -mx-1 px-1 flex-1">
            <div className="mb-3 p-3 rounded-xl bg-base border border-edge text-sm">
              <p className="text-primary">Format détecté : <span className="text-accent font-medium">{preview.source}</span></p>
              <p className="text-muted mt-1">
                {preview.drafts.length} entrée{preview.drafts.length > 1 ? "s" : ""} prête{preview.drafts.length > 1 ? "s" : ""} à importer
                {preview.skipped > 0 ? ` (${preview.skipped} ligne(s) ignorée(s))` : ""}.
              </p>
              {existingItems.length > 0 && (
                <p className="text-muted mt-1 text-xs">
                  ℹ️ Votre coffre contient {existingItems.length} entrée{existingItems.length > 1 ? "s" : ""} — les doublons éventuels seront détectés à l'étape suivante.
                </p>
              )}
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

        {error && (
          <div className="mt-3 p-3 rounded-xl bg-signal-red/10 border border-signal-red/30">
            <p className="text-sm text-signal-red">⚠ {error}</p>
          </div>
        )}

        <div className="flex gap-3 mt-6">
          <button
            onClick={step === "preview" ? () => { setStep("pick"); setPreview(null); setError(null); } : onClose}
            className="flex-1 py-2.5 rounded-xl border border-edge text-sm text-muted hover:text-primary transition-colors"
          >
            {step === "preview" ? "← Choisir un autre fichier" : "Annuler"}
          </button>
          {step === "preview" && preview && (
            <button onClick={goToResolve} className="flex-1 py-2.5 rounded-xl bg-brand text-on-brand text-sm font-medium hover:bg-brand-hover transition-colors">
              {existingItems.length > 0 ? `Vérifier les conflits →` : `Importer ${preview.drafts.length} entrée${preview.drafts.length > 1 ? "s" : ""}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
