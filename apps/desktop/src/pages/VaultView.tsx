import { useEffect, useMemo, useState, useCallback, useRef, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeText as clipboardWriteText, readText as clipboardReadText, clear as clipboardClear } from "@tauri-apps/plugin-clipboard-manager";
import type { VaultItem } from "../types";
import { vaultApi } from "../lib/tauri";
import type { VaultSnapshot } from "../lib/tauri";
import { useAutoLockMinutes } from "../lib/autoLock";
import { useLockOnBlur } from "../lib/lockOnBlur";
import { useAutoBackupSettings, isAutoBackupDue, markAutoBackupDone, AUTO_BACKUP_KEEP } from "../lib/autoBackup";
import { useHibpMonitoringSettings, isHibpCheckDue, runHibpMonitoringCheck } from "../lib/hibpMonitoring";
import { notify } from "../lib/notifications";
import { checkForUpdate, installPendingUpdate, type UpdateInfo } from "../lib/updater";
import { isMobilePlatform } from "../lib/platform";
import { VaultItemCard } from "../components/VaultItemCard";
import { VaultItemForm } from "../components/VaultItemForm";
import { AlbumManager } from "../components/AlbumManager";
import { SecurityAudit } from "../components/SecurityAudit";
import { ImportCsv } from "../components/ImportCsv";
import { VaultSettings } from "../components/VaultSettings";
import { AdvancedFeaturesPanel } from "../components/AdvancedFeaturesPanel";
import { autoTypeApi } from "../lib/advancedFeatures";

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
  /** Si présent, affiche une jauge de progression (vidage du presse-papiers)
   * qui se vide linéairement sur cette durée (ms) — voir roadmap README §1.1. */
  countdownMs?: number;
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
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [shareTarget, setShareTarget] = useState<{ label: string; secret: string } | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  // Menu tiroir mobile
  const [drawerOpen, setDrawerOpen] = useState(false);
  const lastActivity = useRef(Date.now());
  const clipboardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const { minutes: autoLockMinutes } = useAutoLockMinutes();
  const { enabled: lockOnBlur } = useLockOnBlur();
  const { settings: autoBackupSettings } = useAutoBackupSettings();
  const { settings: hibpMonitoringSettings } = useHibpMonitoringSettings();

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

  useEffect(() => {
    if (isMobilePlatform()) return;
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
    } catch (e) {
      showToast(`Échec de la mise à jour : ${e}`);
      setUpdateInstalling(false);
      setUpdateProgress(null);
    }
  };

  // Sélection multiple
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);

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

  const flatVisible = useMemo(() => grouped.flatMap(([, list]) => list), [grouped]);

  useEffect(() => {
    if (focusedId && flatVisible.some((i) => i.id === focusedId)) return;
    setFocusedId(flatVisible[0]?.id ?? null);
  }, [flatVisible, focusedId]);

  const orderedCategories = useMemo(() => {
    const others = categories.filter((c) => c !== "Général");
    if (!categories.includes("Général")) return categories;
    return activeAlbum === "Général" ? ["Général", ...others] : [...others, "Général"];
  }, [categories, activeAlbum]);

  const showToast = useCallback((message: string, action?: Toast["action"], countdownMs?: number) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ message, action, countdownMs });
    toastTimer.current = setTimeout(() => setToast(null), countdownMs ? countdownMs + 500 : 3500);
  }, []);

  const recoveryKitNeedsReminder = useMemo(() => {
    if (recoveryReminderDismissed) return false;
    if (!recoveryKitConfirmedAt) return true;
    const daysSince = (Date.now() - new Date(recoveryKitConfirmedAt).getTime()) / (1000 * 60 * 60 * 24);
    return daysSince > RECOVERY_KIT_REMINDER_DAYS;
  }, [recoveryKitConfirmedAt, recoveryReminderDismissed]);

  // Fermer le drawer si on clique en dehors
  useEffect(() => {
    if (!drawerOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-drawer]") && !target.closest("[data-drawer-trigger]")) {
        setDrawerOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [drawerOpen]);

  // Fermer le drawer avec Escape
  useEffect(() => {
    if (!drawerOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") setDrawerOpen(false); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [drawerOpen]);

  useEffect(() => {
    const interval = setInterval(() => {
      const soon = items.filter((i) => {
        if (!i.expires_at) return false;
        const remainingDays = (new Date(i.expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
        return remainingDays >= 0 && remainingDays <= 7;
      });
      if (soon.length === 0) return;
      const today = new Date().toDateString();
      const lastNotified = localStorage.getItem("coffre_expiry_notified");
      if (lastNotified === today) return;
      localStorage.setItem("coffre_expiry_notified", today);
      notify("Coffre — entrées expirant bientôt", `${soon.length} entrée(s) expirent dans les 7 prochains jours.`);
    }, 60 * 60 * 1000);
    return () => clearInterval(interval);
  }, [items]);

  useEffect(() => {
    if (autoLockMinutes <= 0) return;
    const interval = setInterval(() => {
      if (Date.now() - lastActivity.current > autoLockMinutes * 60 * 1000) lock();
    }, 30 * 1000);
    return () => {
      clearInterval(interval);
    };
  }, [autoLockMinutes]);

  useEffect(() => {
    if (!lockOnBlur) return;
    let unlisten: (() => void) | undefined;
    getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) lock();
    }).then((fn) => { unlisten = fn; });
    return () => unlisten?.();
  }, [lockOnBlur]);

  useEffect(() => {
    const interval = setInterval(async () => {
      if (!isAutoBackupDue(autoBackupSettings) || !autoBackupSettings.folder) return;
      try {
        const snapshot = await vaultApi.exportSnapshot();
        await vaultApi.autoBackup(autoBackupSettings.folder, snapshot, AUTO_BACKUP_KEEP);
        markAutoBackupDone();
      } catch (e) {
        console.error("Auto-backup failed:", e);
      }
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [autoBackupSettings]);

  useEffect(() => {
    const interval = setInterval(async () => {
      if (!isHibpCheckDue(hibpMonitoringSettings)) return;
      try {
        const result = await runHibpMonitoringCheck(items, hibpMonitoringSettings);
        if (result.breachedCount > 0) {
          notify("Coffre — alerte HIBP", `${result.breachedCount} mot(s) de passe compromis détecté(s).`);
        }
      } catch (e) {
        console.error("HIBP monitoring failed:", e);
      }
    }, 60 * 60 * 1000);
    return () => clearInterval(interval);
  }, [items, hibpMonitoringSettings]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const typingInField = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement;
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        setEditing("new");
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "l") {
        e.preventDefault();
        lock();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === "Escape" && query) {
        e.preventDefault();
        setQuery("");
        return;
      }
      if (typingInField || editing || selectionMode) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (flatVisible.length === 0) return;
        const currentIndex = focusedId ? flatVisible.findIndex((i) => i.id === focusedId) : -1;
        const nextIndex = e.key === "ArrowDown"
          ? Math.min(currentIndex + 1, flatVisible.length - 1)
          : Math.max(currentIndex - 1, 0);
        setFocusedId(flatVisible[nextIndex].id);
        return;
      }
      if (e.key === "Enter" && focusedId) {
        e.preventDefault();
        const item = flatVisible.find((i) => i.id === focusedId);
        if (item) setEditing(item);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "c" && focusedId) {
        e.preventDefault();
        const item = flatVisible.find((i) => i.id === focusedId);
        if (item) copySecret(item);
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [query, editing, selectionMode, flatVisible, focusedId]);

  const copySecret = async (item: VaultItem) => {
    if (item.item_type === "passkey") return;
    try {
      const secret = await vaultApi.getItemSecret(item.id);
      if (!secret) return;
      await clipboardWriteText(secret);
      if (clipboardTimer.current) clearTimeout(clipboardTimer.current);
      clipboardTimer.current = setTimeout(async () => {
        try { await clipboardClear(); } catch {}
      }, CLIPBOARD_CLEAR_MS);
      showToast(`Mot de passe copié — effacement dans 20 s`, undefined, CLIPBOARD_CLEAR_MS);
    } catch (e) {
      showToast(`Erreur copie : ${e}`);
    }
  };

  const copyUsername = async (item: VaultItem) => {
    if (!item.username) return;
    try {
      await clipboardWriteText(item.username);
      showToast("Identifiant copié");
    } catch (e) {
      showToast(`Erreur copie : ${e}`);
    }
  };

  const handleAutoType = async (item: VaultItem) => {
    try {
      const secret = await vaultApi.getItemSecret(item.id);
      if (!secret) return;
      await autoTypeApi.type(item.username, secret);
    } catch (e) {
      showToast(`Auto-type échoué : ${e}`);
    }
  };

  const handleShareItem = (item: VaultItem) => {
    setShareTarget({ label: item.title, secret: "" });
    setShowAdvanced(true);
  };

  const lock = async () => {
    if (clipboardTimer.current) {
      clearTimeout(clipboardTimer.current);
      try { await clipboardClear(); } catch {}
    }
    try { await vaultApi.lock(); } catch {}
    onLocked();
  };

  const handleSave = async (data: Omit<VaultItem, "id" | "created_at" | "updated_at">, secret: string) => {
    try {
      if (editing === "new") {
        const newItem = await vaultApi.createItem(data, secret);
        setItems((prev) => [...prev, newItem]);
        if (data.category && !categories.includes(data.category)) {
          setCategories((prev) => [...prev, data.category]);
        }
      } else if (editing) {
        const updated = await vaultApi.updateItem(editing.id, data, secret);
        setItems((prev) => prev.map((i) => (i.id === editing.id ? updated : i)));
        if (data.category && !categories.includes(data.category)) {
          setCategories((prev) => [...prev, data.category]);
        }
      }
      setEditing(null);
    } catch (e) {
      showToast(`Erreur sauvegarde : ${e}`);
    }
  };

  const handleDelete = (id: string, title: string) => {
    setPendingDeleteIds((prev) => new Set(prev).add(id));
    const timer = setTimeout(async () => {
      try {
        await vaultApi.deleteItem(id);
        setItems((prev) => prev.filter((i) => i.id !== id));
      } catch (e) {
        showToast(`Erreur suppression : ${e}`);
        setPendingDeleteIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
      }
      pendingDeleteTimers.current.delete(id);
      setPendingDeleteIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }, UNDO_DELETE_MS);
    pendingDeleteTimers.current.set(id, timer);
    showToast(`"${title}" supprimée`, {
      label: "Annuler",
      onClick: () => {
        const t = pendingDeleteTimers.current.get(id);
        if (t) { clearTimeout(t); pendingDeleteTimers.current.delete(id); }
        setPendingDeleteIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
        setToast(null);
      },
    });
  };

  const handleToggleFavorite = async (id: string) => {
    const item = items.find((i) => i.id === id);
    if (!item) return;
    try {
      const updated = await vaultApi.updateItem(id, { ...item, favorite: !item.favorite }, "");
      setItems((prev) => prev.map((i) => (i.id === id ? updated : i)));
    } catch (e) {
      showToast(`Erreur favori : ${e}`);
    }
  };

  const handleCreateAlbum = async (name: string) => {
    if (categories.includes(name)) return;
    setCategories((prev) => [...prev, name]);
  };

  const handleRenameAlbum = async (oldName: string, newName: string) => {
    try {
      await vaultApi.renameCategory(oldName, newName);
      setCategories((prev) => prev.map((c) => (c === oldName ? newName : c)));
      setItems((prev) => prev.map((i) => (i.category === oldName ? { ...i, category: newName } : i)));
      if (activeAlbum === oldName) setActiveAlbum(newName);
    } catch (e) {
      showToast(`Erreur renommage : ${e}`);
    }
  };

  const handleDeleteAlbum = async (name: string) => {
    try {
      await vaultApi.deleteCategory(name);
      setCategories((prev) => prev.filter((c) => c !== name));
      setItems((prev) => prev.map((i) => (i.category === name ? { ...i, category: "Général" } : i)));
      if (activeAlbum === name) setActiveAlbum(ALL_ALBUMS);
    } catch (e) {
      showToast(`Erreur suppression album : ${e}`);
    }
  };

  const handleImported = (snapshot: VaultSnapshot) => {
    applySnapshot(snapshot);
    showToast("Import CSV terminé");
  };

  const applySnapshot = (snapshot: VaultSnapshot) => {
    setItems(snapshot.items);
    setCategories(snapshot.categories);
    if (snapshot.recoveryKitConfirmedAt) setRecoveryKitConfirmedAt(snapshot.recoveryKitConfirmedAt);
  };

  const confirmRecoveryKitReminder = async () => {
    try {
      const snapshot = await vaultApi.confirmRecoveryKit();
      setRecoveryKitConfirmedAt(snapshot.recoveryKitConfirmedAt);
    } catch (e) {
      showToast(`Erreur : ${e}`);
    }
  };

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

  const selectAllVisible = () => setSelectedIds(new Set(flatVisible.map((i) => i.id)));
  const clearSelection = () => setSelectedIds(new Set());

  const [bulkConfirmDelete, setBulkConfirmDelete] = useState(false);
  const [bulkMoveTarget, setBulkMoveTarget] = useState("");
  const [bulkTagInput, setBulkTagInput] = useState("");

  const handleBulkMove = async (category: string) => {
    try {
      const ids = Array.from(selectedIds);
      for (const id of ids) {
        const item = items.find((i) => i.id === id);
        if (!item) continue;
        const updated = await vaultApi.updateItem(id, { ...item, category }, "");
        setItems((prev) => prev.map((i) => (i.id === id ? updated : i)));
      }
      setBulkMoveTarget("");
      clearSelection();
      showToast(`${ids.length} entrée(s) déplacée(s) vers "${category}"`);
    } catch (e) {
      showToast(`Erreur déplacement : ${e}`);
    }
  };

  const handleBulkAddTag = async () => {
    const tag = bulkTagInput.trim();
    if (!tag) return;
    try {
      const ids = Array.from(selectedIds);
      for (const id of ids) {
        const item = items.find((i) => i.id === id);
        if (!item || item.tags.includes(tag)) continue;
        const updated = await vaultApi.updateItem(id, { ...item, tags: [...item.tags, tag] }, "");
        setItems((prev) => prev.map((i) => (i.id === id ? updated : i)));
      }
      setBulkTagInput("");
      showToast(`Tag "${tag}" ajouté à ${ids.length} entrée(s)`);
    } catch (e) {
      showToast(`Erreur tag : ${e}`);
    }
  };

  const handleBulkDelete = async () => {
    if (!bulkConfirmDelete) { setBulkConfirmDelete(true); return; }
    try {
      const ids = Array.from(selectedIds);
      for (const id of ids) await vaultApi.deleteItem(id);
      setItems((prev) => prev.filter((i) => !selectedIds.has(i.id)));
      clearSelection();
      setSelectionMode(false);
      setBulkConfirmDelete(false);
      showToast(`${ids.length} entrée(s) supprimée(s)`);
    } catch (e) {
      showToast(`Erreur suppression : ${e}`);
      setBulkConfirmDelete(false);
    }
  };

  const isMobile = isMobilePlatform();

  return (
    <div className="min-h-screen bg-base text-primary">
      {/* ===== HEADER ===== */}
      <header className="border-b border-edge sticky top-0 bg-base/95 backdrop-blur z-10">
        <div className="max-w-3xl mx-auto px-3 sm:px-6 py-3 sm:py-4 flex items-center gap-2 sm:gap-3">
          <h1 className="font-display text-xl font-medium shrink-0">Coffre</h1>
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher…"
            className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-edge bg-surface text-sm outline-none focus:border-brand/50"
          />
          <button
            onClick={() => setEditing("new")}
            title="Nouvelle entrée (Ctrl+N)"
            className="px-3 sm:px-4 py-2 rounded-lg bg-brand text-on-brand text-sm font-medium hover:bg-brand-hover transition-colors shrink-0"
          >
            <span className="hidden sm:inline">+ Ajouter</span>
            <span className="sm:hidden text-lg leading-none">+</span>
          </button>

          {/* Boutons desktop (masqués sur mobile) */}
          {!isMobile && (
            <>
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
              <IconHeaderButton
                title="Fonctionnalités avancées"
                onClick={() => { setShareTarget(null); setShowAdvanced(true); }}
              >
                <ZapIcon />
              </IconHeaderButton>
              <IconHeaderButton title="Paramètres" onClick={() => setShowSettings(true)}>
                <GearIcon />
              </IconHeaderButton>
              <IconHeaderButton title="Verrouiller (Ctrl+L)" onClick={lock}>
                <LockIcon />
              </IconHeaderButton>
            </>
          )}

          {/* Bouton menu hamburger sur mobile */}
          {isMobile && (
            <button
              data-drawer-trigger
              onClick={() => setDrawerOpen(true)}
              title="Menu"
              className="w-9 h-9 rounded-lg flex items-center justify-center text-muted hover:text-primary hover:bg-surface-2 transition-colors shrink-0"
            >
              <HamburgerIcon />
            </button>
          )}
        </div>

        {/* Albums (catégories) */}
        <div className="max-w-3xl mx-auto px-3 sm:px-6 pb-3 flex items-center gap-2 overflow-x-auto scrollbar-none">
          <AlbumPill active={activeAlbum === ALL_ALBUMS} onClick={() => setActiveAlbum(ALL_ALBUMS)}>
            Tous
          </AlbumPill>
          <AlbumPill active={activeAlbum === FAVORITES_ALBUM} onClick={() => setActiveAlbum(FAVORITES_ALBUM)}>
            ★ Favoris {favoriteCount > 0 && `(${favoriteCount})`}
          </AlbumPill>
          {orderedCategories.map((c) => (
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
          <div className="max-w-3xl mx-auto px-3 sm:px-6 pb-3 flex items-center gap-1.5 overflow-x-auto scrollbar-none">
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

      {/* Tri mobile */}
      <div className="sm:hidden border-b border-edge bg-base">
        <div className="max-w-3xl mx-auto px-3 py-2">
          <select
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as SortMode)}
            className="w-full px-2 py-1.5 rounded-lg border border-edge bg-surface text-xs text-muted outline-none focus:border-brand/50"
          >
            <option value="favorites">Favoris d'abord</option>
            <option value="name">Nom (A→Z)</option>
            <option value="recent">Récemment modifié</option>
          </select>
        </div>
      </div>

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
          <div className="max-w-3xl mx-auto px-3 sm:px-6 py-2.5 flex items-center gap-3 flex-wrap text-xs">
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

      <main className="max-w-3xl mx-auto px-3 sm:px-6 py-4 sm:py-8">
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
                      onCopyUsername={() => copyUsername(item)}
                      onToggleFavorite={() => handleToggleFavorite(item.id)}
                      onAutoType={() => handleAutoType(item)}
                      onShare={() => handleShareItem(item)}
                      selectionMode={selectionMode}
                      selected={selectedIds.has(item.id)}
                      onToggleSelected={() => toggleSelected(item.id)}
                      focused={!selectionMode && focusedId === item.id}
                      onFocusCard={() => setFocusedId(item.id)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>

      {/* ===== DRAWER MOBILE ===== */}
      {isMobile && (
        <>
          {/* Fond semi-transparent */}
          <div
            className={`fixed inset-0 bg-black/40 z-40 transition-opacity duration-300 ${
              drawerOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
            }`}
            onClick={() => setDrawerOpen(false)}
          />
          {/* Panneau glissant */}
          <div
            data-drawer
            className={`fixed top-0 right-0 h-full w-72 max-w-[85vw] bg-base border-l border-edge z-50 flex flex-col shadow-2xl transition-transform duration-300 ease-in-out ${
              drawerOpen ? "translate-x-0" : "translate-x-full"
            }`}
          >
            {/* En-tête du drawer */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-edge">
              <span className="font-display text-base font-semibold text-primary">Menu</span>
              <button
                onClick={() => setDrawerOpen(false)}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-muted hover:text-primary hover:bg-surface-2 transition-colors"
              >
                <CloseIcon />
              </button>
            </div>

            {/* Corps du drawer */}
            <div className="flex-1 overflow-y-auto py-3">
              {/* Actions principales */}
              <div className="px-3 mb-2">
                <p className="text-xs uppercase tracking-widest text-muted px-2 mb-1">Actions</p>
                <DrawerItem
                  icon={<CheckSquareIcon />}
                  label={selectionMode ? "Quitter la sélection" : "Sélection multiple"}
                  active={selectionMode}
                  onClick={() => { toggleSelectionMode(); setDrawerOpen(false); }}
                />
                <DrawerItem
                  icon={<ShieldIcon />}
                  label="Audit de sécurité"
                  onClick={() => { setShowAudit(true); setDrawerOpen(false); }}
                />
                <DrawerItem
                  icon={<ZapIcon />}
                  label="Fonctionnalités avancées"
                  onClick={() => { setShareTarget(null); setShowAdvanced(true); setDrawerOpen(false); }}
                />
              </div>

              <div className="border-t border-edge mx-3 my-2" />

              {/* Paramètres */}
              <div className="px-3 mb-2">
                <p className="text-xs uppercase tracking-widest text-muted px-2 mb-1">Configuration</p>
                <DrawerItem
                  icon={<ImportIcon />}
                  label="Importer un CSV"
                  onClick={() => { setShowImport(true); setDrawerOpen(false); }}
                />
                <DrawerItem
                  icon={<GearIcon />}
                  label="Paramètres"
                  onClick={() => { setShowSettings(true); setDrawerOpen(false); }}
                />
              </div>

              <div className="border-t border-edge mx-3 my-2" />

              {/* Tri */}
              <div className="px-3 mb-2">
                <p className="text-xs uppercase tracking-widest text-muted px-2 mb-2">Trier par</p>
                {(["favorites", "name", "recent"] as SortMode[]).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => { setSortMode(mode); setDrawerOpen(false); }}
                    className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors mb-0.5 ${
                      sortMode === mode
                        ? "bg-brand/10 text-accent-strong font-medium"
                        : "text-primary hover:bg-surface-2"
                    }`}
                  >
                    {mode === "favorites" ? "Favoris d'abord" : mode === "name" ? "Nom (A→Z)" : "Récemment modifié"}
                  </button>
                ))}
              </div>
            </div>

            {/* Pied du drawer — Verrouiller */}
            <div className="border-t border-edge p-3">
              <button
                onClick={() => { setDrawerOpen(false); lock(); }}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-signal-red hover:bg-signal-red/10 transition-colors font-medium"
              >
                <LockIcon />
                Verrouiller le coffre
              </button>
            </div>
          </div>
        </>
      )}

      {/* ===== MODALES ===== */}
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

      {showAdvanced && (
        <AdvancedFeaturesPanel
          prefill={shareTarget}
          onClose={() => {
            setShowAdvanced(false);
            setShareTarget(null);
          }}
        />
      )}

      {showSettings && (
        <VaultSettings
          items={items}
          categories={categories}
          onImported={(snapshot) => {
            applySnapshot(snapshot);
            showToast("Import chiffré restauré dans le coffre");
          }}
          onClose={() => setShowSettings(false)}
        />
      )}

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
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 flex flex-col gap-1.5 px-4 py-2.5 rounded-xl bg-surface-2 border border-edge text-sm text-primary shadow-lg min-w-[240px]">
          <div className="flex items-center gap-3">
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
          {toast.countdownMs && <ClipboardCountdownBar durationMs={toast.countdownMs} />}
        </div>
      )}
    </div>
  );
}

/**
 * Élément de menu dans le drawer mobile
 */
function DrawerItem({
  icon,
  label,
  onClick,
  active,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors mb-0.5 ${
        active
          ? "bg-brand/10 text-accent-strong font-medium"
          : "text-primary hover:bg-surface-2"
      }`}
    >
      <span className="text-muted shrink-0">{icon}</span>
      {label}
    </button>
  );
}

function ClipboardCountdownBar({ durationMs }: { durationMs: number }) {
  const [empty, setEmpty] = useState(false);
  useEffect(() => {
    setEmpty(false);
    const raf1 = requestAnimationFrame(() => {
      const raf2 = requestAnimationFrame(() => setEmpty(true));
      return () => cancelAnimationFrame(raf2);
    });
    return () => cancelAnimationFrame(raf1);
  }, [durationMs]);

  return (
    <div className="h-1 w-full rounded-full bg-edge overflow-hidden">
      <div
        className="h-full bg-accent rounded-full"
        style={{
          width: empty ? "0%" : "100%",
          transition: empty ? `width ${durationMs}ms linear` : "none",
        }}
      />
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
      <div className="max-w-3xl mx-auto px-3 sm:px-6 py-2.5 flex items-center gap-3 flex-wrap">
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
      <div className="max-w-3xl mx-auto px-3 sm:px-6 py-2.5 flex items-center gap-3 flex-wrap">
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

// ===== ICÔNES =====
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
function ZapIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M13 2 3 14h8l-1 8 10-12h-8l1-8Z" />
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
function HamburgerIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}
function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
