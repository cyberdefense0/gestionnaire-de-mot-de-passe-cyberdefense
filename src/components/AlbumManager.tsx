import { useState } from "react";
import { useEscapeKey } from "../lib/useEscapeKey";

interface Props {
  categories: string[];
  itemCountByCategory: Record<string, number>;
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
  onRename: (oldName: string, newName: string) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
}

const DEFAULT_ALBUM = "Général";

export function AlbumManager({ categories, itemCountByCategory, onClose, onCreate, onRename, onDelete }: Props) {
  useEscapeKey(onClose);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(newName.trim());
      setNewName("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const startRename = (name: string) => {
    setRenaming(name);
    setRenameValue(name);
  };

  const submitRename = async (oldName: string) => {
    if (!renameValue.trim() || renameValue.trim() === oldName) {
      setRenaming(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onRename(oldName, renameValue.trim());
      setRenaming(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    setBusy(true);
    setError(null);
    try {
      await onDelete(name);
      setConfirmDelete(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-base/90 backdrop-blur-sm flex items-center justify-center px-6 z-40">
      <div className="max-w-md w-full bg-surface border border-edge rounded-2xl p-7 max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between mb-1">
          <h2 className="font-display text-2xl font-medium text-primary">Mes albums</h2>
          <button onClick={onClose} className="text-muted hover:text-primary text-sm px-2 py-1">
            Fermer
          </button>
        </div>
        <p className="text-sm text-muted mb-5">Organisez vos entrées par album (dossier).</p>

        <div className="space-y-2 overflow-y-auto mb-5 -mx-1 px-1">
          {categories.map((name) => (
            <div key={name} className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-edge bg-base">
              {renaming === name ? (
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submitRename(name)}
                  onBlur={() => submitRename(name)}
                  className="flex-1 bg-transparent text-sm text-primary outline-none border-b border-brand/50"
                />
              ) : (
                <span className="flex-1 text-sm text-primary truncate">{name}</span>
              )}
              <span className="text-xs text-muted shrink-0">{itemCountByCategory[name] ?? 0}</span>

              {name !== DEFAULT_ALBUM && renaming !== name && (
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => startRename(name)}
                    disabled={busy}
                    className="text-xs px-2 py-1 rounded-lg text-muted hover:text-accent hover:bg-surface-2 transition-colors"
                  >
                    Renommer
                  </button>
                  {confirmDelete === name ? (
                    <button
                      onClick={() => remove(name)}
                      disabled={busy}
                      className="text-xs px-2 py-1 rounded-lg bg-signal-red/10 text-signal-red border border-signal-red/30"
                    >
                      Confirmer
                    </button>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(name)}
                      disabled={busy}
                      className="text-xs px-2 py-1 rounded-lg text-muted hover:text-signal-red hover:bg-surface-2 transition-colors"
                    >
                      Supprimer
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        {error && <p className="text-sm text-signal-red mb-3">{error}</p>}

        <div className="flex gap-2 pt-4 border-t border-edge">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
            placeholder="Nom du nouvel album…"
            className="flex-1 px-3 py-2 rounded-xl border border-edge bg-base text-sm text-primary outline-none focus:border-brand/50"
          />
          <button
            onClick={create}
            disabled={busy || !newName.trim()}
            className="px-4 py-2 rounded-xl bg-brand text-on-brand text-sm font-medium hover:bg-brand-hover transition-colors disabled:opacity-50"
          >
            Créer
          </button>
        </div>
      </div>
    </div>
  );
}
