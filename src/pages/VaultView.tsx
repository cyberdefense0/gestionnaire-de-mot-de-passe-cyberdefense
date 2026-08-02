import { useEffect, useMemo, useState, useCallback, useRef, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { VaultItem } from "../types";
import { vaultApi } from "../lib/tauri";
import type { VaultSnapshot } from "../lib/tauri";
import { useAutoLockMinutes } from "../lib/autoLock";
import { useLockOnBlur } from "../lib/lockOnBlur";
import { useAutoBackupSettings, isAutoBackupDue, markAutoBackupDone, AUTO_BACKUP_KEEP } from "../lib/autoBackup";
import { notify } from "../lib/notifications";
import { checkForUpdate, installPendingUpdate, type UpdateInfo } from "../lib/updater";
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

/** Délai avant suppression réelle après un clic sur "Supprimer", pendant
 * lequel l'entrée est juste masquée et un "Annuler" reste possible. */
const UNDO_DELETE_MS = 6000;
const CLIPBOARD_CLEAR_MS = 20 * 1000; // 20 secondes
const ALL_ALBUMS = "__all__";
const FAVORITES_ALBUM = "__favorites__";
/** Au-delà de ce nombre de jours sans confirmation, on rappelle à l'utilisateur
 * de vérifier qu'il a toujours accès à son kit de récupération. */
const RECOVERY_KIT_REMINDER_DAYS = 90;

type SortMode = "favorites" | "name" | "recent";

interface Toast {
  message: string;
  action?: { label: string; onClick: () => void };
}

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
  const [toast, setToast] = useState<Toast | null>(null);
  const lastActivity = useRef(Date.now());
  const clipboardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const { minutes: autoLockMinutes } = useAutoLockMinutes();
  const { enabled: lockOnBlur } = useLockOnBlur();
  const { settings: autoBackupSettings } = useAutoBackupSettings();

  // Suppression avec "Annuler" : l'entrée est masquée immédiatement, la
  // suppression réelle côté Rust n'a lieu qu'après UNDO_DELETE_MS si
  // personne n'a annulé entre-temps.
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(new Set());
  const pendingDeleteTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Mise à jour automatique
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<{ downloaded: number; total: number | undefined } | null>(null);

  // Vérifie une mise à jour une seule fois à l'ouverture du coffre — pas de
  // vérification périodique en plus (une nouvelle version sort rarement
  // plusieurs fois dans la même session), et échoue silencieusement s'il
  // n'y a pas de réseau ou pas de build signé disponible (voir updater.ts).
  useEffect(() => {
    checkForUpdate().then((info) => {
      if (info) {
        setUpdateInfo(info);
        notify("Coffre — mise à jour disponible", `La version ${info.version} est prête à être installée.`);
      }
    });
  }, []);

  const handleInstallUpdate = async () => {
    setUpdateInstalling(true);
    setUpdateProgress({ downloaded: 0, total: undefined });
    try {
      await installPendingUpdate((downloaded, total) => setUpdateProgress({ downloaded, total }));
      // Si on arrive ici sans relance (cas rare selon plateforme), l'app
      // reste ouverte sur l'ancienne version en mémoire — au pire il faudra
      // la relancer manuellement, mais l'installation elle-même a réussi.
    } catch (e) {
      showToast(`Échec de la mise à jour : ${e}`);
      setUpdateInstalling(false);
      setUpdateProgress(null);
    }
  };

  // Sélection multiple
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

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
      if (pendingDeleteIds.has(i.id)) return false;
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
  }, [items, query, activeAlbum, activeTag, pendingDeleteIds]);

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

  const showToast = (message: string, action?: Toast["action"]) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ message, action });
    // Un toast avec action (ex: "Annuler") reste affiché aussi longtemps
    // que la fenêtre d'action correspondante (undo suppression) ; un toast
    // simple disparaît vite pour ne pas gêner.
    toastTimer.current = setTimeout(() => setToast(null), action ? UNDO_DELETE_MS : 2500);
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

  // Notification native en complément de la bannière (fonctionne même
  // fenêtre minimisée) — seulement au moment où le rappel devient actif,
  // pas à chaque re-render (dépendance sur la valeur du booléen).
  useEffect(() => {
    if (recoveryKitNeedsReminder) {
      notify(
        "Coffre — kit de récupération",
        "Avez-vous toujours accès à votre kit de récupération ? Sans lui, un master password oublié rend vos données irrécupérables."
      );
    }
  }, [recoveryKitNeedsReminder]);

  // Notification native pour les entrées qui expirent bientôt (≤7 jours) —
  // au plus une fois par jour, pour ne pas spammer à chaque contrôle
  // périodique (`coffre:lastExpiryNotification`, date seule, en localStorage).
  useEffect(() => {
    const check = () => {
      const soon = items.filter((i) => {
        if (!i.expires_at) return false;
        const remainingDays = (new Date(i.expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
        return remainingDays >= 0 && remainingDays <= 7;
      });
      if (soon.length === 0) return;

      const today = new Date().toISOString().slice(0, 10);
      const lastNotified = localStorage.getItem("coffre:lastExpiryNotification");
      if (lastNotified === today) return;
      localStorage.setItem("coffre:lastExpiryNotification", today);

      notify(
        "Coffre — mots de passe à renouveler",
        soon.length === 1
          ? `« ${soon[0].title} » arrive à expiration dans les 7 prochains jours.`
          : `${soon.length} entrées arrivent à expiration dans les 7 prochains jours.`
      );
    };
    check();
    const interval = setInterval(check, 60 * 60 * 1000); // toutes les heures
    return () => clearInterval(interval);
  }, [items]);

  const lock = useCallback(async () => {
    await vaultApi.lockVault();
    onLocked();
  }, [onLocked]);

  // Verrouillage automatique après inactivité (durée réglable dans les
  // Paramètres, 0 = désactivé).
  useEffect(() => {
    if (autoLockMinutes <= 0) return;
    const autoLockMs = autoLockMinutes * 60 * 1000;
    const bump = () => (lastActivity.current = Date.now());
    window.addEventListener("mousemove", bump);
    window.addEventListener("keydown", bump);
    window.addEventListener("click", bump);

    const interval = setInterval(() => {
      if (Date.now() - lastActivity.current > autoLockMs) {
        lock();
      }
    }, 5000);

    return () => {
      window.removeEventListener("mousemove", bump);
      window.removeEventListener("keydown", bump);
      window.removeEventListener("click", bump);
      clearInterval(interval);
    };
  }, [lock, autoLockMinutes]);

  // Verrouillage sur perte de focus de la fenêtre (opt-in, voir lockOnBlur.ts
  // pour ce que ça détecte vraiment vs. ce que le nom du réglage suggère).
  useEffect(() => {
    if (!lockOnBlur) return;
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (!focused) lock();
      })
      .then((fn) => (unlisten = fn));
    return () => unlisten?.();
  }, [lockOnBlur, lock]);

  // Sauvegarde automatique périodique (opt-in, voir Paramètres). Vérifie
  // toutes les 10 minutes tant que le coffre reste déverrouillé — pas de
  // tâche de fond après verrouillage/fermeture, ce n'est pas un daemon.
  useEffect(() => {
    const check = async () => {
      if (!isAutoBackupDue(autoBackupSettings) || !autoBackupSettings.folder) return;
      try {
        await vaultApi.autoBackup(autoBackupSettings.folder, AUTO_BACKUP_KEEP);
        markAutoBackupDone();
        showToast("Sauvegarde automatique effectuée");
      } catch {
        // Échec silencieux (ex: dossier déplacé/supprimé) : on retentera
        // au prochain contrôle plutôt que d'interrompre l'utilisateur avec
        // une erreur pour une action qu'il n'a pas déclenchée lui-même.
      }
    };
    check();
    const interval = setInterval(check, 10 * 60 * 1000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoBackupSettings.enabled, autoBackupSettings.folder, autoBackupSettings.frequencyHours]);

  // Raccourcis clavier : Ctrl/Cmd+F recherche, Ctrl/Cmd+N nouvelle entrée,
  // Ctrl/Cmd+L verrouillage immédiat
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
      } else if (e.key.toLowerCase() === "l") {
        e.preventDefault();
        lock();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [lock]);

  const copySecret = async (item: VaultItem) => {
    const secret = item.item_type === "note" ? item.notes : item.password;
    await navigator.clipboard.writeText(secret);
    showToast(`${item.item_type === "note" ? "Contenu" : "Mot de passe"} copié — effacé dans ${CLIPBOARD_CLEAR_MS / 1000}s`);
    // Best-effort, ne bloque jamais la copie elle-même si ça échoue.
    vaultApi.markItemUsed(item.id).then(applySnapshot).catch(() => {});
    if (clipboardTimer.current) clearTimeout(clipboardTimer.current);
    clipboardTimer.current = setTimeout(async () => {
      const current = await navigator.clipboard.readText().catch(() => "");
      if (current === secret) {
        await navigator.clipboard.writeText("");
      }
    }, CLIPBOARD_CLEAR_MS);
  };

  const handleSave = async (draft: Omit<VaultItem, "id" | "created_at" | "updated_at" | "password_history" | "last_used_at">) => {
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

  /** Supprime une entrée avec un délai d'annulation : masquée immédiatement
   * (voir `filtered`), la suppression réelle côté Rust n'a lieu qu'après
   * `UNDO_DELETE_MS` si "Annuler" n'a pas été cliqué entre-temps. */
  const handleDelete = (id: string, title: string) => {
    setPendingDeleteIds((prev) => new Set(prev).add(id));

    const commit = async () => {
      pendingDeleteTimers.current.delete(id);
      try {
        const snapshot = await vaultApi.deleteItem(id);
        applySnapshot(snapshot);
      } finally {
        setPendingDeleteIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    };

    const timer = setTimeout(commit, UNDO_DELETE_MS);
    pendingDeleteTimers.current.set(id, timer);

    showToast(`« ${title} » supprimée`, {
      label: "Annuler",
      onClick: () => {
        const t = pendingDeleteTimers.current.get(id);
        if (t) {
          clearTimeout(t);
          pendingDeleteTimers.current.delete(id);
        }
        setPendingDeleteIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        setToast(null);
      },
    });
  };

  const handleToggleFavorite = async (id: string) => {
    const snapshot = await vaultApi.toggleFavorite(id);
    applySnapshot(snapshot);
  };

  // ---------- Sélection multiple ----------

  const toggleSelectionMode = () => {
    setSelectionMode((prev) => !prev);
    setSelectedIds(new Set());
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllVisible = () => {
    setSelectedIds(new Set(sorted.map((i) => i.id)));
  };

  const clearSelection = () => setSelectedIds(new Set());

  const [bulkConfirmDelete, setBulkConfirmDelete] = useState(false);
  const [bulkMoveTarget, setBulkMoveTarget] = useState("");
  const [bulkTagInput, setBulkTagInput] = useState("");

  const handleBulkDelete = async () => {
    if (!bulkConfirmDelete) {
      setBulkConfirmDelete(true);
      return;
    }
    const ids = Array.from(selectedIds);
    const snapshot = await vaultApi.bulkDeleteItems(ids);
    applySnapshot(snapshot);
    showToast(`${ids.length} entrée(s) supprimée(s)`);
    setBulkConfirmDelete(false);
    setSelectionMode(false);
    setSelectedIds(new Set());
  };

  const handleBulkMove = async (category: string) => {
    if (!category) return;
    const ids = Array.from(selectedIds);
    const snapshot = await vaultApi.bulkSetCategory(ids, category);
    applySnapshot(snapshot);
    showToast(`${ids.length} entrée(s) déplacée(s) vers « ${category} »`);
    setBulkMoveTarget("");
    setSelectionMode(false);
    setSelectedIds(new Set());
  };

  const handleBulkAddTag = async () => {
    const tag = bulkTagInput.trim();
    if (!tag) return;
    const ids = Array.from(selectedIds);
    const snapshot = await vaultApi.bulkAddTag(ids, tag);
    applySnapshot(snapshot);
    showToast(`Tag « ${tag} » ajouté à ${ids.length} entrée(s)`);
    setBulkTagInput("");
    setSelectionMode(false);
    setSelectedIds(new Set());
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
          <IconHeaderButton
            title={selectionMode ? "Quitter la sélection" : "Sélection multiple"}
            onClick={toggleSelectionMode}
            active={selectionMode}
          >
            <CheckSquareIcon />
          </IconHeaderButton>
          <IconHeaderButton title="Audit de sécurité" onClick={() => setShowAudit(true)}>
            <ShieldIcon />
          </IconHeaderButton>
          <IconHeaderButton title="Paramètres" onClick={() => setShowSettings(true)}>
            <GearIcon />
          </IconHeaderButton>
          <IconHeaderButton title="Verrouiller (Ctrl+L)" onClick={lock}>
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

      {updateInfo && !updateDismissed && (
        <UpdateAvailableBanner
          info={updateInfo}
          installing={updateInstalling}
          progress={updateProgress}
          onInstall={handleInstallUpdate}
          onDismiss={() => setUpdateDismissed(true)}
        />
      )}

      {recoveryKitNeedsReminder && (
        <RecoveryKitReminderBanner
          neverConfirmed={!recoveryKitConfirmedAt}
          onConfirm={confirmRecoveryKitReminder}
          onDismiss={() => setRecoveryReminderDismissed(true)}
        />
      )}

      {selectionMode && (
        <div className="border-b border-brand/30 bg-brand/5">
          <div className="max-w-3xl mx-auto px-6 py-2.5 flex items-center gap-3 flex-wrap text-xs">
            <span className="text-primary font-medium">{selectedIds.size} sélectionnée(s)</span>
            <button onClick={selectAllVisible} className="text-accent hover:text-accent-strong transition-colors">
              Tout sélectionner
            </button>
            {selectedIds.size > 0 && (
              <button onClick={clearSelection} className="text-muted hover:text-primary transition-colors">
                Désélectionner
              </button>
            )}
          </div>
        </div>
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
                      onDelete={() => handleDelete(item.id, item.title)}
                      onCopySecret={() => copySecret(item)}
                      onToggleFavorite={() => handleToggleFavorite(item.id)}
                      selectionMode={selectionMode}
                      selected={selectedIds.has(item.id)}
                      onToggleSelected={() => toggleSelected(item.id)}
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

      {showSettings && <VaultSettings items={items} onClose={() => setShowSettings(false)} />}

      {selectionMode && selectedIds.size > 0 && (
        <BulkActionBar
          count={selectedIds.size}
          categories={categories}
          bulkConfirmDelete={bulkConfirmDelete}
          bulkMoveTarget={bulkMoveTarget}
          bulkTagInput={bulkTagInput}
          onMoveTargetChange={(v) => {
            setBulkMoveTarget(v);
            if (v) handleBulkMove(v);
          }}
          onTagInputChange={setBulkTagInput}
          onAddTag={handleBulkAddTag}
          onDelete={handleBulkDelete}
          onCancelDeleteConfirm={() => setBulkConfirmDelete(false)}
        />
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-3 px-4 py-2.5 rounded-xl bg-surface-2 border border-edge text-sm text-primary shadow-lg">
          <span>{toast.message}</span>
          {toast.action && (
            <button
              onClick={toast.action.onClick}
              className="text-accent hover:text-accent-strong font-medium transition-colors"
            >
              {toast.action.label}
            </button>
          )}
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

function IconHeaderButton({
  title,
  onClick,
  children,
  active,
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors shrink-0 ${
        active ? "text-accent-strong bg-brand/10" : "text-muted hover:text-primary hover:bg-surface-2"
      }`}
    >
      {children}
    </button>
  );
}

function BulkActionBar({
  count,
  categories,
  bulkConfirmDelete,
  bulkMoveTarget,
  bulkTagInput,
  onMoveTargetChange,
  onTagInputChange,
  onAddTag,
  onDelete,
  onCancelDeleteConfirm,
}: {
  count: number;
  categories: string[];
  bulkConfirmDelete: boolean;
  bulkMoveTarget: string;
  bulkTagInput: string;
  onMoveTargetChange: (v: string) => void;
  onTagInputChange: (v: string) => void;
  onAddTag: () => void;
  onDelete: () => void;
  onCancelDeleteConfirm: () => void;
}) {
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2 px-4 py-3 rounded-2xl bg-surface border border-edge-strong shadow-xl flex-wrap justify-center max-w-[calc(100vw-2rem)]">
      <span className="text-xs text-muted px-1">{count} sélectionnée(s)</span>

      <select
        value={bulkMoveTarget}
        onChange={(e) => onMoveTargetChange(e.target.value)}
        className="text-xs px-2 py-2 rounded-lg border border-edge bg-base text-primary outline-none focus:border-brand/50"
      >
        <option value="">Déplacer vers…</option>
        {categories.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>

      <div className="flex items-center gap-1">
        <input
          value={bulkTagInput}
          onChange={(e) => onTagInputChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onAddTag()}
          placeholder="Ajouter un tag…"
          className="w-32 text-xs px-2 py-2 rounded-lg border border-edge bg-base text-primary outline-none focus:border-brand/50"
        />
        <button
          onClick={onAddTag}
          className="text-xs px-2.5 py-2 rounded-lg border border-edge text-accent hover:border-brand/50 transition-colors"
        >
          +Tag
        </button>
      </div>

      {bulkConfirmDelete ? (
        <button
          onClick={onDelete}
          onBlur={onCancelDeleteConfirm}
          autoFocus
          className="text-xs px-3 py-2 rounded-lg bg-signal-red/10 text-signal-red border border-signal-red/30"
        >
          Confirmer la suppression
        </button>
      ) : (
        <button
          onClick={onDelete}
          className="text-xs px-3 py-2 rounded-lg border border-edge text-signal-red hover:border-signal-red/50 transition-colors"
        >
          Supprimer
        </button>
      )}
    </div>
  );
}

function UpdateAvailableBanner({
  info,
  installing,
  progress,
  onInstall,
  onDismiss,
}: {
  info: UpdateInfo;
  installing: boolean;
  progress: { downloaded: number; total: number | undefined } | null;
  onInstall: () => void;
  onDismiss: () => void;
}) {
  const percent = progress?.total ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100)) : null;

  return (
    <div className="border-b border-brand/30 bg-brand/5">
      <div className="max-w-3xl mx-auto px-6 py-2.5 flex items-center gap-3 flex-wrap">
        <span className="text-xs text-primary flex-1 min-w-[220px]">
          ⬆️ Version {info.version} disponible.
          {installing && progress && (
            <span className="text-muted"> {percent !== null ? ` Téléchargement… ${percent}%` : " Téléchargement…"}</span>
          )}
        </span>
        {!installing && (
          <>
            <button
              onClick={onInstall}
              className="shrink-0 text-xs px-3 py-1.5 rounded-lg bg-brand/20 border border-brand/40 text-accent-strong hover:bg-brand/30 transition-colors"
            >
              Installer et redémarrer
            </button>
            <button onClick={onDismiss} className="shrink-0 text-xs text-muted hover:text-primary transition-colors">
              Plus tard
            </button>
          </>
        )}
      </div>
    </div>
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
function CheckSquareIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="m8 12 3 3 6-6" />
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
