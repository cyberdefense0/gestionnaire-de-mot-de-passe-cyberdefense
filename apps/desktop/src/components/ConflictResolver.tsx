/**
 * Résolution de conflits lors d'un import CSV sur un coffre non vide.
 * Détecte les doublons (même URL normalisée + même username OU même titre)
 * et propose : Ignorer / Remplacer / Garder les deux.
 */
import { useState, useMemo } from "react";
import type { VaultItem } from "../types";
import type { ImportDraft as ImportedRow } from "../lib/csvImport";

export type ConflictResolution = "ignore" | "replace" | "keep-both";

export interface ConflictEntry {
  imported: ImportedRow;
  existing: VaultItem;
  resolution: ConflictResolution;
}

interface Props {
  imported: ImportedRow[];
  existing: VaultItem[];
  onResolved: (
    toAdd: ImportedRow[],
    toReplace: { id: string; row: ImportedRow }[]
  ) => void;
  onCancel: () => void;
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

function normalizeTitle(t: string): string {
  return t.trim().toLowerCase().replace(/\s+/g, " ");
}

export function ConflictResolver({ imported, existing, onResolved, onCancel }: Props) {
  // Détection des conflits
  const conflicts = useMemo<ConflictEntry[]>(() => {
    const result: ConflictEntry[] = [];
    for (const row of imported) {
      let match: VaultItem | undefined;
      // 1. Même URL + même username
      if (row.url && row.username) {
        const rowHost = normalizeUrl(row.url);
        match = existing.find(
          (e) =>
            e.url && normalizeUrl(e.url) === rowHost &&
            e.username.trim().toLowerCase() === row.username.trim().toLowerCase()
        );
      }
      // 2. Même titre (fallback)
      if (!match && row.title) {
        match = existing.find(
          (e) => normalizeTitle(e.title) === normalizeTitle(row.title)
        );
      }
      if (match) {
        result.push({ imported: row, existing: match, resolution: "ignore" });
      }
    }
    return result;
  }, [imported, existing]);

  const conflictIds = useMemo(
    () => new Set(conflicts.map((c) => c.imported.title + c.imported.url + c.imported.username)),
    [conflicts]
  );

  const [resolutions, setResolutions] = useState<Map<string, ConflictResolution>>(
    () => new Map(conflicts.map((c) => [c.existing.id, "ignore"]))
  );

  const setRes = (id: string, res: ConflictResolution) =>
    setResolutions((m) => new Map(m).set(id, res));

  const noConflicts = imported.filter(
    (r) => !conflictIds.has(r.title + r.url + r.username)
  );

  const handleConfirm = () => {
    const toAdd: ImportedRow[] = [...noConflicts];
    const toReplace: { id: string; row: ImportedRow }[] = [];

    for (const conflict of conflicts) {
      const res = resolutions.get(conflict.existing.id) ?? "ignore";
      if (res === "keep-both") toAdd.push(conflict.imported);
      else if (res === "replace") toReplace.push({ id: conflict.existing.id, row: conflict.imported });
      // "ignore" → ne rien faire
    }

    onResolved(toAdd, toReplace);
  };

  if (conflicts.length === 0) {
    // Pas de conflit — appel immédiat
    handleConfirm();
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-primary/40 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="w-full max-w-xl bg-surface rounded-2xl border border-edge shadow-xl p-6 my-8">
        <h2 className="font-display text-xl font-medium text-primary mb-1">Doublons détectés</h2>
        <p className="text-sm text-muted mb-5">
          {conflicts.length} entrée{conflicts.length > 1 ? "s" : ""} du fichier importé correspondent à des entrées existantes.
          Choisissez quoi faire pour chacune.
        </p>

        <div className="space-y-4 max-h-[50vh] overflow-y-auto pr-1">
          {conflicts.map((c) => {
            const res = resolutions.get(c.existing.id) ?? "ignore";
            return (
              <div key={c.existing.id} className="p-4 rounded-xl border border-edge bg-base space-y-3">
                <div className="flex items-start gap-2">
                  <span className="text-base shrink-0">⚠️</span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-primary truncate">{c.imported.title}</p>
                    {c.imported.username && (
                      <p className="text-xs text-muted">{c.imported.username}</p>
                    )}
                    {c.imported.url && (
                      <p className="text-xs text-muted truncate">{c.imported.url}</p>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  {(["ignore", "replace", "keep-both"] as ConflictResolution[]).map((option) => (
                    <button
                      key={option}
                      onClick={() => setRes(c.existing.id, option)}
                      className={`py-2 rounded-lg border text-xs font-medium transition-colors ${
                        res === option
                          ? option === "replace"
                            ? "bg-signal-amber/10 border-signal-amber/50 text-signal-amber"
                            : option === "ignore"
                            ? "bg-brand/10 border-brand/30 text-accent"
                            : "bg-surface-2 border-edge-strong text-primary"
                          : "border-edge text-muted hover:text-primary hover:border-edge-strong"
                      }`}
                    >
                      {option === "ignore" && "Ignorer"}
                      {option === "replace" && "Remplacer"}
                      {option === "keep-both" && "Garder les deux"}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-muted">
                  {res === "ignore" && "L'entrée existante reste inchangée."}
                  {res === "replace" && "L'entrée existante sera mise à jour avec les données importées."}
                  {res === "keep-both" && "Les deux entrées seront conservées (doublon assumé)."}
                </p>
              </div>
            );
          })}
        </div>

        <div className="mt-5 flex items-center gap-3">
          <p className="text-xs text-muted flex-1">
            {noConflicts.length} entrée{noConflicts.length > 1 ? "s" : ""} sans conflit seront importées directement.
          </p>
          <button onClick={onCancel} className="px-4 py-2 rounded-xl border border-edge text-sm text-muted hover:text-primary">
            Annuler
          </button>
          <button onClick={handleConfirm} className="px-4 py-2 rounded-xl bg-brand text-on-brand text-sm font-medium hover:bg-brand-hover transition-colors">
            Confirmer l'import
          </button>
        </div>
      </div>
    </div>
  );
}
