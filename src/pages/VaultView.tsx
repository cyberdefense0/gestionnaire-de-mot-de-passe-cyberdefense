import { useEffect, useMemo, useState, useCallback, useRef, type ReactNode } from "react";
import type { VaultItem } from "../types";
import { vaultApi } from "../lib/tauri";
import type { VaultSnapshot } from "../lib/tauri";
import { VaultItemCard } from "../components/VaultItemCard";
import { VaultItemForm } from "../components/VaultItemForm";
import { AlbumManager } from "../components/AlbumManager";
import { SecurityAudit } from "../components/SecurityAudit";
import { ImportCsv } from "../components/ImportCsv";
import { VaultSettings } from "../components/VaultSettings";

interface Props {
  initialItems: VaultItem[];
  initialCategories: string[];
  initialRecoveryKitConfirmedAt: string | null;
  onLocked: () => void;
}

const AUTO_LOCK_MS = 5 * 60 * 1000; // 5 minutes d'inactivité
const CLIPBOARD_CLEAR_MS = 20 * 1000; // 20 secondes
const ALL_ALBUMS = "__all__";
const FAVORITES_ALBUM = "__favorites__";
/** Au-delà de ce nombre de jours sans confirmation, on rappelle à l'utilisateur
 * de vérifier qu'il a toujours accès à son kit de récupération. */
const RECOVERY_KIT_REMINDER_DAYS = 90;

type SortMode = "favorites" | "name" | "recent";

export function VaultView({ initialItems, initialCategories, initialRecoveryKitConfirmedAt, onLocked }: Props) {
  const [items, setItems] = useState<VaultItem[]>(initialItems);
  const [categories, setCategories] = useState<string[]>(initialCategories);
  const [recoveryKitConfirmedAt, setRecoveryKitConfirmedAt] = useState<string | null>(initialRecoveryKitConfirmedAt);
  const [recoveryReminderDismissed, setRecoveryReminderDismissed] = useState(false);
  const [query, setQuery] = useState("");
  const [activeAlbum, setActiveAlbum] = useState<string>(ALL_ALBUMS);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>("favorites");
  const [editing, setEditing] = useState<VaultItem | "new" | null>(null);
  const [showAlbumManager, setShowAlbumManager] = useState(false);
  const [showAudit, setShowAudit] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const lastActivity = useRef(Date.now());
  const clipboardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const favoriteCount = useMemo(() => items.filter((i) => i.favorite).length, [items]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const item of items) for (const t of item.tags) set.add(t);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [items]);

  const itemCountByCategory = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of items) counts[item.category] = (counts[item.category] ?? 0) + 1;
    return counts;
  }, [items]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((i) => {
      if (activeAlbum === FAVORITES_ALBUM && !i.favorite) return false;
      if (activeAlbum !== ALL_ALBUMS && activeAlbum !== FAVORITES_ALBUM && i.category !== activeAlbum) return false;
      if (activeTag && !i.tags.includes(activeTag)) return false;
      if (!q) return true;
      return (
        i.title.toLowerCase().includes(q) ||
        i.username.toLowerCase().includes(q) ||
        i.category.toLowerCase().includes(q) ||
        i.url.toLowerCase().includes(q) ||
        i.tags.some((t) => t.toLowerCase().includes(q)) ||
        (i.item_type === "note" && i.notes.toLowerCase().includes(q))
      );
    });
  }, [items, query, activeAlbum, activeTag]);

  const sorted = useMemo(() => {
    const list = [...filtered];
    switch (sortMode) {
      case "name":
        return list.sort((a, b) => a.title.localeCompare(b.title));
      case "recent":
        return list.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
      case "favorites":
      default:
        return list.sort((a, b) => {
          if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
          return a.title.localeCompare(b.title);
        });
    }
  }, [filtered, sortMode]);

  const grouped = useMemo(() => {
    if (activeAlbum !== ALL_ALBUMS) return [[activeAlbum === FAVORITES_ALBUM ? "Favoris" : activeAlbum, sorted] as [string, VaultItem[]]];
    if (sortMode !== "favorites") return [["Tous", sorted] as [string, VaultItem[]]];
    const map = new Map<string, VaultItem[]>();
    for (const item of sorted) {
      const list = map.get(item.category) ?? [];
      list.push(item);
      map.set(item.category, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [sorted, activeAlbum, sortMode]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  /** Garde items/categories/recoveryKitConfirmedAt synchronisés avec la
   * réponse Rust après chaque mutation — chaque commande renvoie l'état
   * complet plutôt qu'un diff, donc pas de risque de dérive. */
  const applySnapshot = (snapshot: { items: VaultItem[]; categories: string[]; recoveryKitConfirmedAt?: string | null }) => {
    setItems(snapshot.items);
    setCategories(snapshot.categories);
    if (snapshot.recoveryKitConfirmedAt !== undefined) setRecoveryKitConfirmedAt(snapshot.recoveryKitConfirmedAt);
  };

  const recoveryKitNeedsReminder = useMemo(() => {
    if (recoveryReminderDismissed) return false;
    if (!recoveryKitConfirmedAt) return true;
    const daysSince = (Date.now() - new Date(recoveryKitConfirmedAt).getTime()) / (1000 * 60 * 60 * 24);
    return daysSince > RECOVERY_KIT_REMINDER_DAYS;
  }, [recoveryKitConfirmedAt, recoveryReminderDismissed]);

  const confirmRecoveryKitReminder = async () => {
    const snapshot = await vaultApi.confirmRecoveryKitSaved();
    applySnapshot(snapshot);
    showToast("Merci — rappel remis à zéro pour 90 jours");
  };

  const lock = useCallback(async () => {
    await vaultApi.lockVault();
    onLocked();
  }, [onLocked]);

  // Verrouillage automatique après inactivité
  useEffect(() => {
    const bump = () => (lastActivity.current = Date.now());
    window.addEventListener("mousemove", bump);
    window.addEventListener("keydown", bump);
    window.addEventListener("click", bump);

    const interval = setInterval(() => {
      if (Date.now() - lastActivity.current > AUTO_LOCK_MS) {
        lock();
      }
    }, 5000);

    return () => {
      window.removeEventListener("mousemove", bump);
      window.removeEventListener("keydown", bump);
      window.removeEventListener("click", bump);
      clearInterval(interval);
    };
  }, [lock]);

  // Raccourcis clavier : Ctrl/Cmd+F recherche, Ctrl/Cmd+N nouvelle entrée
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key.toLowerCase() === "n") {
        e.preventDefault();
        setEditing("new");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const copySecret = async (item: VaultItem) => {
    const secret = item.item_type === "note" ? item.notes : item.password;
    await navigator.clipboard.writeText(secret);
    showToast(`${item.item_type === "note" ? "Contenu" : "Mot de passe"} copié — effacé dans ${CLIPBOARD_CLEAR_MS / 1000}s`);
    if (clipboardTimer.current) clearTimeout(clipboardTimer.current);
    clipboardTimer.current = setTimeout(async () => {
      const current = await navigator.clipboard.readText().catch(() => "");
      if (current === secret) {
        await navigator.clipboard.writeText("");
      }
    }, CLIPBOARD_CLEAR_MS);
  };

  const handleSave = async (draft: Omit<VaultItem, "id" | "created_at" | "updated_at" | "password_history">) => {
    if (editing && editing !== "new") {
      const snapshot = await vaultApi.updateItem({ ...editing, ...draft });
      applySnapshot(snapshot);
      showToast("Entrée mise à jour");
    } else {
      const snapshot = await vaultApi.addItem(draft);
      applySnapshot(snapshot);
      showToast(draft.item_type === "note" ? "Note ajoutée" : "Entrée ajoutée");
    }
    setEditing(null);
  };

  const handleDelete = async (id: string) => {
    const snapshot = await vaultApi.deleteItem(id);
    applySnapshot(snapshot);
    showToast("Entrée supprimée");
  };

  const handleToggleFavorite = async (id: string) => {
    const snapshot = await vaultApi.toggleFavorite(id);
    applySnapshot(snapshot);
  };

  const handleCreateAlbum = async (name: string) => {
    const snapshot = await vaultApi.createAlbum(name);
    applySnapshot(snapshot);
  };

  const handleRenameAlbum = async (oldName: string, newName: string) => {
    const snapshot = await vaultApi.renameAlbum(oldName, newName);
    applySnapshot(snapshot);
    if (activeAlbum === oldName) setActiveAlbum(newName);
  };

  const handleDeleteAlbum = async (name: string) => {
    const snapshot = await vaultApi.deleteAlbum(name);
    applySnapshot(snapshot);
    if (activeAlbum === name) setActiveAlbum(ALL_ALBUMS);
  };

  const handleImported = (snapshot: VaultSnapshot, count: number) => {
    applySnapshot(snapshot);
    setShowImport(false);
    showToast(`${count} entrée(s) importée(s)`);
  };

  return (
    <div className="min-h-screen bg-base text-primary">
      <header className="border-b border-edge sticky top-0 bg-base/95 backdrop-blur z-10">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center gap-3">
          <h1 className="font-display text-xl font-medium shrink-0">Coffre</h1>
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher… (Ctrl+F)"
            className="flex-1 px-4 py-2 rounded-lg border border-edge bg-surface text-sm outline-none focus:border-brand/50"
          />
          <select
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as SortMode)}
            title="Trier"
            className="hidden sm:block px-2 py-2 rounded-lg border border-edge bg-surface text-xs text-muted outline-none focus:border-brand/50 shrink-0"
          >
            <option value="favorites">Favoris d'abord</option>
            <option value="name">Nom (A→Z)</option>
            <option value="recent">Récemment modifié</option>
          </select>
          <button
            onClick={() => setEditing("new")}
            title="Nouvelle entrée (Ctrl+N)"
            className="px-4 py-2 rounded-lg bg-brand text-on-brand text-sm font-medium hover:bg-brand-hover transition-colors shrink-0"
          >
            + Ajouter
          </button>
          <IconHeaderButton title="Importer un CSV" onClick={() => setShowImport(true)}>
            <ImportIcon />
          </IconHeaderButton>
          <IconHeaderButton title="Audit de sécurité" onClick={() => setShowAudit(true)}>
            <ShieldIcon />
          </IconHeaderButton>
          <IconHeaderButton title="Paramètres" onClick={() => setShowSettings(true)}>
            <GearIcon />
          </IconHeaderButton>
          <IconHeaderButton title="Verrouiller" onClick={lock}>
            <LockIcon />
          </IconHeaderButton>
        </div>

        <div className="max-w-3xl mx-auto px-6 pb-3 flex items-center gap-2 overflow-x-auto">
          <AlbumPill active={activeAlbum === ALL_ALBUMS} onClick={() => setActiveAlbum(ALL_ALBUMS)}>
            Tous
          </AlbumPill>
          <AlbumPill active={activeAlbum === FAVORITES_ALBUM} onClick={() => setActiveAlbum(FAVORITES_ALBUM)}>
            ★ Favoris {favoriteCount > 0 && `(${favoriteCount})`}
          </AlbumPill>
          {categories.map((c) => (
            <AlbumPill key={c} active={activeAlbum === c} onClick={() => setActiveAlbum(c)}>
              {c}
            </AlbumPill>
          ))}
          <button
            onClick={() => setShowAlbumManager(true)}
            className="shrink-0 text-xs px-3 py-1.5 rounded-full border border-dashed border-edge-strong text-muted hover:text-accent hover:border-brand/50 transition-colors"
          >
            Gérer les albums
          </button>
        </div>

        {allTags.length > 0 && (
          <div className="max-w-3xl mx-auto px-6 pb-3 flex items-center gap-1.5 overflow-x-auto">
            <span className="text-xs text-muted shrink-0">Tags :</span>
            {allTags.map((t) => (
              <button
                key={t}
                onClick={() => setActiveTag(activeTag === t ? null : t)}
                className={`shrink-0 text-xs px-2.5 py-1 rounded-full border transition-colors ${
                  activeTag === t
                    ? "bg-accent/20 border-accent text-accent-strong"
                    : "border-edge text-muted hover:text-accent hover:border-brand/50"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        )}
      </header>

      {recoveryKitNeedsReminder && (
        <RecoveryKitReminderBanner
          neverConfirmed={!recoveryKitConfirmedAt}
          onConfirm={confirmRecoveryKitReminder}
          onDismiss={() => setRecoveryReminderDismissed(true)}
        />
      )}

      <main className="max-w-3xl mx-auto px-6 py-8">
        {items.length === 0 ? (
          <EmptyState onAdd={() => setEditing("new")} />
        ) : sorted.length === 0 ? (
          <p className="text-center text-muted text-sm py-16">Aucun résultat.</p>
        ) : (
          <div className="space-y-8">
            {grouped.map(([category, categoryItems]) => (
              <section key={category}>
                <h2 className="text-xs uppercase tracking-widest text-muted mb-3">{category}</h2>
                <div className="space-y-2">
                  {categoryItems.map((item) => (
                    <VaultItemCard
                      key={item.id}
                      item={item}
                      onEdit={() => setEditing(item)}
                      onDelete={() => handleDelete(item.id)}
                      onCopySecret={() => copySecret(item)}
                      onToggleFavorite={() => handleToggleFavorite(item.id)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>

      {editing && (
        <VaultItemForm
          initial={editing === "new" ? undefined : editing}
          categories={categories}
          defaultCategory={activeAlbum !== ALL_ALBUMS && activeAlbum !== FAVORITES_ALBUM ? activeAlbum : undefined}
          onCancel={() => setEditing(null)}
          onSave={handleSave}
        />
      )}

      {showAlbumManager && (
        <AlbumManager
          categories={categories}
          itemCountByCategory={itemCountByCategory}
          onClose={() => setShowAlbumManager(false)}
          onCreate={handleCreateAlbum}
          onRename={handleRenameAlbum}
          onDelete={handleDeleteAlbum}
        />
      )}

      {showAudit && (
        <SecurityAudit
          items={items}
          onClose={() => setShowAudit(false)}
          onOpenItem={(item) => {
            setShowAudit(false);
            setEditing(item);
          }}
        />
      )}

      {showImport && <ImportCsv onClose={() => setShowImport(false)} onImported={handleImported} />}

      {showSettings && <VaultSettings onClose={() => setShowSettings(false)} />}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2.5 rounded-xl bg-surface-2 border border-edge text-sm text-primary shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

function AlbumPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 text-xs px-3 py-1.5 rounded-full border transition-colors ${
        active
          ? "bg-brand text-on-brand border-brand"
          : "border-edge text-muted hover:text-primary hover:border-edge-strong"
      }`}
    >
      {children}
    </button>
  );
}

function IconHeaderButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="w-9 h-9 rounded-lg flex items-center justify-center text-muted hover:text-primary hover:bg-surface-2 transition-colors shrink-0"
    >
      {children}
    </button>
  );
}

function RecoveryKitReminderBanner({
  neverConfirmed,
  onConfirm,
  onDismiss,
}: {
  neverConfirmed: boolean;
  onConfirm: () => Promise<void>;
  onDismiss: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  const handleConfirm = async () => {
    setConfirming(true);
    try {
      await onConfirm();
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="border-b border-signal-amber/30 bg-signal-amber/10">
      <div className="max-w-3xl mx-auto px-6 py-2.5 flex items-center gap-3 flex-wrap">
        <span className="text-xs text-primary flex-1 min-w-[220px]">
          {neverConfirmed
            ? "⚠️ Avez-vous toujours accès à votre kit de récupération ? Sans lui, un master password oublié rend vos données irrécupérables."
            : "⚠️ Ça fait un moment — avez-vous toujours accès à votre kit de récupération ?"}
        </span>
        <button
          onClick={handleConfirm}
          disabled={confirming}
          className="shrink-0 text-xs px-3 py-1.5 rounded-lg bg-signal-amber/20 border border-signal-amber/40 text-primary hover:bg-signal-amber/30 transition-colors disabled:opacity-50"
        >
          {confirming ? "…" : "Oui, toujours en sécurité"}
        </button>
        <button onClick={onDismiss} className="shrink-0 text-xs text-muted hover:text-primary transition-colors">
          Plus tard
        </button>
      </div>
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="text-center py-20">
      <p className="text-muted text-sm mb-4">Votre coffre est vide pour l'instant.</p>
      <button onClick={onAdd} className="px-5 py-2.5 rounded-xl bg-brand text-on-brand text-sm font-medium hover:bg-brand-hover transition-colors">
        Ajouter votre première entrée
      </button>
    </div>
  );
}

function LockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}
function ShieldIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 2 4 5v6c0 5 3.5 8.5 8 11 4.5-2.5 8-6 8-11V5Z" />
    </svg>
  );
}
function ImportIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M4 21h16" />
    </svg>
  );
}
