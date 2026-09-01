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
import { Dashboard } from "../components/Dashboard";
import { ItemDetail } from "../components/ItemDetail";
import { Onboarding, isOnboardingDone } from "../components/Onboarding";
import { VaultStats } from "../components/VaultStats";
import { RecoveryKitModal } from "../components/RecoveryKitModal";
import { QuickAdd } from "../components/QuickAdd";
import { KeyboardShortcutsHelp } from "../components/KeyboardShortcutsHelp";
import { pushSearchHistory, getSearchHistory, clearSearchHistory } from "../lib/searchHistory";
import { isReadOnly, setReadOnly } from "../lib/readOnlyMode";
import { applyPalette, readStoredPalette } from "../lib/accentColor";
import { fuzzyMatch } from "../lib/fuzzySearch";
import { AccentPicker } from "../components/AccentPicker";
import { useTheme } from "../lib/theme";

interface Props {
  initialItems: VaultItem[];
  initialCategories: string[];
  initialRecoveryKitConfirmedAt: string | null;
  /** Code de récupération généré à la création du vault, affiché une seule fois. */
  recoveryCode?: string | null;
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

type SortMode = "favorites" | "name" | "name-desc" | "recent";

interface Toast {
  message: string;
  action?: { label: string; onClick: () => void };
  /** Si présent, affiche une jauge de progression (vidage du presse-papiers)
   * qui se vide linéairement sur cette durée (ms) — voir roadmap README §1.1. */
  countdownMs?: number;
}

export function VaultView({ initialItems, initialCategories, initialRecoveryKitConfirmedAt, recoveryCode, onLocked }: Props) {
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

  // Nouvelles fonctionnalités v4+
  const EXPIRED_ALBUM = "__expired__";
  const [showDashboard, setShowDashboard] = useState(true);
  const [detailItem, setDetailItem] = useState<VaultItem | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(!isOnboardingDone());
  const [showStats, setShowStats] = useState(false);
  const [showRecoveryKit, setShowRecoveryKit] = useState(false);
  const [auditIssueCount, setAuditIssueCount] = useState<number | null>(null);
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [compactView, setCompactView] = useState(() => localStorage.getItem("coffre:compactView") === "true");
  const [searchHistory, setSearchHistory] = useState<string[]>(getSearchHistory);
  const [showSearchHistory, setShowSearchHistory] = useState(false);
  // Mode lecture seule — protège contre les modifications accidentelles
  const [readOnly, setReadOnlyState] = useState(isReadOnly);
  // Menu tiroir mobile
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Thème résolu (pour l'AccentPicker et l'application de la palette)
  const { resolved: resolvedTheme } = useTheme();
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

  // Applique la palette de couleur d'accent au montage, et à chaque changement de thème
  useEffect(() => {
    applyPalette(readStoredPalette(), resolvedTheme === "dark");
  }, [resolvedTheme]);

  /** Bascule le mode lecture seule et persiste en sessionStorage. */
  const toggleReadOnly = useCallback(() => {
    setReadOnlyState((prev) => {
      const next = !prev;
      setReadOnly(next);
      showToast(next ? "🔒 Mode lecture seule activé — modifications bloquées" : "✏️ Mode lecture seule désactivé");
      return next;
    });
  }, []);

  // Vérifie une mise à jour une seule fois à l'ouverture du coffre — pas de
  // vérification périodique en plus (une nouvelle version sort rarement
  // plusieurs fois dans la même session), et échoue silencieusement s'il
  // n'y a pas de réseau ou pas de build signé disponible (voir updater.ts).
  useEffect(() => {
    // Le plugin updater n'est pas enregistré sur mobile (voir Cargo.toml /
    // lib.rs) — sur mobile, les mises à jour passent par le store de l'OS.
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
  /** Entrée actuellement "sélectionnée" au clavier/survol (pas à confondre
   * avec `selectedIds`, la sélection multiple) — voir roadmap README §1.1/§1.2 :
   * survol/focus d'une carte, navigation flèches, raccourcis Ctrl+C. */
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const favoriteCount = useMemo(() => items.filter((i) => i.favorite).length, [items]);
  const expiredOrSoonCount = useMemo(() => items.filter((i) => {
    if (!i.expires_at) return false;
    const d = (new Date(i.expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    return d <= 30;
  }).length, [items]);

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
      if (activeAlbum === EXPIRED_ALBUM) {
        if (!i.expires_at) return false;
        const d = (new Date(i.expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
        return d <= 30;
      }
      if (activeAlbum !== ALL_ALBUMS && activeAlbum !== FAVORITES_ALBUM && i.category !== activeAlbum) return false;
      if (activeTag && !i.tags.includes(activeTag)) return false;
      if (!q) return true;
      // Recherche exacte (rapide) sur tous les champs texte, puis fuzzy en fallback
      const searchText = [i.title, i.username, i.url, i.category, ...i.tags, i.notes].join(" ");
      return fuzzyMatch(query.trim(), searchText);
    });
  }, [items, query, activeAlbum, activeTag, pendingDeleteIds, EXPIRED_ALBUM]);

  const sorted = useMemo(() => {
    const list = [...filtered];
    switch (sortMode) {
      case "name":
        return list.sort((a, b) => a.title.localeCompare(b.title));
      case "name-desc":
        return list.sort((a, b) => b.title.localeCompare(a.title));
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
    if (activeAlbum === EXPIRED_ALBUM) return [["⚠ Expirant bientôt", sorted] as [string, VaultItem[]]];
    if (activeAlbum !== ALL_ALBUMS) return [[activeAlbum === FAVORITES_ALBUM ? "Favoris" : activeAlbum, sorted] as [string, VaultItem[]]];
    if (sortMode !== "favorites") return [["Tous", sorted] as [string, VaultItem[]]];
    const map = new Map<string, VaultItem[]>();
    for (const item of sorted) {
      const list = map.get(item.category) ?? [];
      list.push(item);
      map.set(item.category, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [sorted, activeAlbum, sortMode, EXPIRED_ALBUM]);

  /** Liste à plat dans l'ordre visuel exact (groupes concaténés), utilisée
   * pour la navigation clavier (flèches ↑/↓) — voir roadmap README §1.2. */
  const flatVisible = useMemo(() => grouped.flatMap(([, list]) => list), [grouped]);

  // Le focus clavier suit la liste : si l'entrée focusée disparaît (filtre,
  // suppression...), on retombe sur la première visible plutôt que de
  // garder une référence à une carte qui n'existe plus.
  useEffect(() => {
    if (focusedId && flatVisible.some((i) => i.id === focusedId)) return;
    setFocusedId(flatVisible[0]?.id ?? null);
  }, [flatVisible, focusedId]);

  // "Général" est l'album de secours qui ne peut pas être supprimé (voir
  // README) — retour utilisateur : par défaut il doit se placer tout à
  // droite (les albums "actifs" créés par l'utilisateur passent avant), et
  // une fois sélectionné, se déplacer en tête pour laisser les autres
  // albums visibles/atteignables à sa droite plutôt que de rester coincé
  // contre le bouton "Gérer les albums" en bout de barre.
  const orderedCategories = useMemo(() => {
    if (!categories.includes("Général")) return categories;
    const others = categories.filter((c) => c !== "Général");
    return activeAlbum === "Général" ? ["Général", ...others] : [...others, "Général"];
  }, [categories, activeAlbum]);

  const showToast = (message: string, action?: Toast["action"], countdownMs?: number) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ message, action, countdownMs });
    // Un toast avec action (ex: "Annuler") reste affiché aussi longtemps
    // que la fenêtre d'action correspondante (undo suppression) ; un toast
    // simple disparaît vite pour ne pas gêner.
    toastTimer.current = setTimeout(() => setToast(null), countdownMs ?? (action ? UNDO_DELETE_MS : 2500));
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

  // Surveillance HIBP continue, opt-in (roadmap README §3.1) : vérifie tout
  // le vault au plus une fois toutes les HIBP_CHECK_INTERVAL_HOURS heures,
  // tant que le coffre reste déverrouillé. Contrôlé toutes les 10 minutes
  // comme les sauvegardes automatiques, même logique de tolérance aux
  // pannes réseau (retente au prochain passage, jamais bloquant).
  useEffect(() => {
    const check = async () => {
      if (!isHibpCheckDue(hibpMonitoringSettings)) return;
      const result = await runHibpMonitoringCheck(items);
      if (result.newlyPwned.length > 0) {
        notify(
          "Coffre — mot de passe compromis détecté",
          result.newlyPwned.length === 1
            ? `« ${result.newlyPwned[0].title} » est apparu dans une fuite de données connue. Changez-le dès que possible.`
            : `${result.newlyPwned.length} mots de passe sont apparus dans des fuites de données connues. Consultez l'audit de sécurité.`
        );
      }
    };
    check();
    const interval = setInterval(check, 10 * 60 * 1000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hibpMonitoringSettings.enabled]);

  // Ferme le drawer mobile si l'utilisateur clique en dehors
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

  // Raccourcis clavier : Ctrl/Cmd+F ou "/" recherche, Ctrl/Cmd+N nouvelle
  // entrée, Ctrl/Cmd+K ajout rapide, Ctrl/Cmd+L verrouillage immédiat,
  // ↑/↓ navigue dans la liste, Entrée ouvre la fiche détaillée,
  // Espace bascule favori, ? ouvre l'aide des raccourcis,
  // Ctrl/Cmd+C copie mot de passe, Ctrl/Cmd+Shift+C identifiant.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const target = e.target as HTMLElement | null;
      const typingInField = !!target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);

      if (mod && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (!typingInField && e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (!typingInField && e.key === "?") {
        e.preventDefault();
        setShowShortcuts((s) => !s);
        return;
      }
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setShowQuickAdd(true);
        return;
      }
      if (mod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setEditing("new");
        return;
      }
      if (mod && e.key.toLowerCase() === "l") {
        e.preventDefault();
        lock();
        return;
      }
      if (mod && e.key.toLowerCase() === "r") {
        e.preventDefault();
        toggleReadOnly();
        return;
      }
      if (e.key === "Escape" && drawerOpen) {
        setDrawerOpen(false);
        return;
      }

      if (typingInField || editing || selectionMode) return;

      const focusedItem = flatVisible.find((i) => i.id === focusedId) ?? null;

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (flatVisible.length === 0) return;
        const idx = focusedItem ? flatVisible.findIndex((i) => i.id === focusedItem.id) : -1;
        const nextIdx =
          e.key === "ArrowDown"
            ? Math.min(idx + 1, flatVisible.length - 1)
            : Math.max(idx - 1, 0);
        const next = flatVisible[nextIdx === -1 ? 0 : nextIdx];
        if (next) {
          setFocusedId(next.id);
          document.getElementById(`item-card-${next.id}`)?.scrollIntoView({ block: "nearest" });
        }
        return;
      }
      // Entrée → fiche détaillée (lecture seule) plutôt que formulaire d'édition
      if (e.key === "Enter" && focusedItem) {
        e.preventDefault();
        setDetailItem(focusedItem);
        return;
      }
      if (e.key === " " && focusedItem) {
        e.preventDefault();
        handleToggleFavorite(focusedItem.id);
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "c" && focusedItem) {
        e.preventDefault();
        copyUsername(focusedItem);
        return;
      }
      if (mod && e.key.toLowerCase() === "c" && focusedItem) {
        e.preventDefault();
        copySecret(focusedItem);
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [lock, editing, selectionMode, flatVisible, focusedId, drawerOpen]);

  const copySecret = async (item: VaultItem) => {
    if (item.item_type === "passkey") return; // rien à copier côté client, voir VaultItemCard
    const secret = item.item_type === "note" ? item.notes : item.password;
    // Presse-papiers NATIF (plugin Tauri), pas `navigator.clipboard` : l'API
    // Web exige que le document ait le focus, ce qui échoue silencieusement
    // sur WebKitGTK/Linux dès qu'on change de fenêtre pour coller le mot de
    // passe copié — précisément le cas d'usage normal. Bug remonté par un
    // utilisateur Ubuntu : la copie fonctionnait, l'effacement automatique
    // après 20s non (le `readText` de vérification échouait, retournait
    // une chaîne vide, ne correspondait jamais au secret, donc le clear
    // était systématiquement sauté).
    try {
      await clipboardWriteText(secret);
    } catch (e) {
      // Ne plus jamais échouer en silence (c'est précisément ce qui avait
      // caché un bug de permission Tauri la première fois) : un échec ici
      // doit être visible, pas juste avaler la copie entière sans rien dire.
      showToast(`Échec de la copie : ${e instanceof Error ? e.message : e}`);
      return;
    }
    showToast(
      `${item.item_type === "note" ? "Contenu" : "Mot de passe"} copié — effacé dans ${CLIPBOARD_CLEAR_MS / 1000}s`,
      undefined,
      CLIPBOARD_CLEAR_MS
    );
    // Best-effort, ne bloque jamais la copie elle-même si ça échoue.
    vaultApi.markItemUsed(item.id).then(applySnapshot).catch(() => {});
    if (clipboardTimer.current) clearTimeout(clipboardTimer.current);
    clipboardTimer.current = setTimeout(async () => {
      try {
        const current = await clipboardReadText();
        if (current === secret) {
          await clipboardClear();
        }
      } catch {
        // Presse-papiers illisible (ex: un autre processus l'a verrouillé
        // brièvement) : on n'efface pas à l'aveugle, on retente juste au
        // prochain déclenchement plutôt que d'écraser potentiellement autre
        // chose que le secret copié.
      }
    }, CLIPBOARD_CLEAR_MS);
  };

  /** Ctrl/Cmd+Shift+C : copie l'identifiant/email plutôt que le secret —
   * pas d'effacement automatique (contrairement au mot de passe), un
   * identifiant n'est pas un secret. */
  const copyUsername = async (item: VaultItem) => {
    if (!item.username) return;
    try {
      await clipboardWriteText(item.username);
      showToast("Identifiant copié");
    } catch (e) {
      showToast(`Échec de la copie : ${e instanceof Error ? e.message : e}`);
    }
  };

  /** Auto-Type : laisse le temps à l'utilisateur de basculer vers la fenêtre
   * cible (ex : le formulaire de connexion dans le navigateur) avant de
   * simuler la frappe côté Rust (voir features/auto_type.rs, basé sur
   * `enigo`) — sans ce délai, la frappe atterrirait dans le coffre lui-même. */
  const AUTO_TYPE_DELAY_MS = 2500;
  const handleAutoType = (item: VaultItem) => {
    showToast(`Basculez vers la fenêtre cible — frappe dans ${AUTO_TYPE_DELAY_MS / 1000}s…`);
    setTimeout(async () => {
      try {
        await autoTypeApi.run({ username: item.username, password: item.password, entry_id: item.id });
        vaultApi.markItemUsed(item.id).then(applySnapshot).catch(() => {});
      } catch (e) {
        showToast(`Échec de l'Auto-Type : ${e instanceof Error ? e.message : e}`);
      }
    }, AUTO_TYPE_DELAY_MS);
  };

  const handleShareItem = (item: VaultItem) => {
    setShareTarget({
      label: item.title,
      secret: item.item_type === "note" ? item.notes : item.password,
    });
    setShowAdvanced(true);
  };

  const handleSave = async (draft: Omit<VaultItem, "id" | "created_at" | "updated_at" | "password_history" | "last_used_at">) => {
    if (readOnly) { showToast("🔒 Mode lecture seule — désactivez-le pour modifier"); return; }
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
    if (readOnly) { showToast("🔒 Mode lecture seule — désactivez-le pour supprimer"); return; }
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
        <div className="max-w-3xl mx-auto px-3 sm:px-6 py-3 sm:py-4 flex items-center gap-2 sm:gap-3">
          <h1 className="font-display text-xl font-medium shrink-0">Coffre</h1>

          {/* Recherche avec historique */}
          <div className="relative flex-1 min-w-0">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setShowSearchHistory(false);
              }}
              onFocus={() => { if (!query && searchHistory.length > 0) setShowSearchHistory(true); }}
              onBlur={() => setTimeout(() => setShowSearchHistory(false), 150)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && query.trim().length >= 2) {
                  pushSearchHistory(query.trim());
                  setSearchHistory(getSearchHistory());
                  setShowSearchHistory(false);
                }
                if (e.key === "Escape") { setQuery(""); setShowSearchHistory(false); }
              }}
              placeholder={items.length === 0 ? "Rechercher…" : `Rechercher parmi ${items.length} entrée${items.length > 1 ? "s" : ""}…`}
              className="w-full px-3 py-2 rounded-lg border border-edge bg-surface text-sm outline-none focus:border-brand/50"
            />
            {/* Historique des recherches */}
            {showSearchHistory && searchHistory.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-surface border border-edge rounded-xl shadow-lg z-20 overflow-hidden">
                <div className="flex items-center justify-between px-3 py-1.5 border-b border-edge">
                  <span className="text-[10px] uppercase tracking-wider text-muted">Recherches récentes</span>
                  <button
                    onClick={() => { clearSearchHistory(); setSearchHistory([]); setShowSearchHistory(false); }}
                    className="text-[10px] text-muted hover:text-signal-red transition-colors"
                  >
                    Effacer
                  </button>
                </div>
                {searchHistory.map((h) => (
                  <button
                    key={h}
                    onClick={() => { setQuery(h); setShowSearchHistory(false); setShowDashboard(false); }}
                    className="w-full text-left px-3 py-2 text-sm text-primary hover:bg-surface-2 transition-colors flex items-center gap-2"
                  >
                    <span className="text-muted text-xs">🕐</span> {h}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Ajout rapide ⚡ */}
          <button
            onClick={() => setShowQuickAdd(true)}
            title="Ajout rapide (Ctrl+K)"
            className="shrink-0 hidden sm:flex items-center gap-1 px-3 py-2 rounded-lg border border-edge text-sm text-muted hover:text-accent hover:border-brand/40 transition-colors"
          >
            <span>⚡</span>
          </button>

          {/* Aide raccourcis */}
          <button
            onClick={() => setShowShortcuts(true)}
            title="Raccourcis clavier (?)"
            className="shrink-0 hidden sm:flex items-center w-8 h-8 justify-center rounded-lg border border-edge text-sm text-muted hover:text-accent hover:border-brand/40 transition-colors"
          >
            ?
          </button>

          {/* Sélecteur de palette de couleur */}
          <div className="shrink-0 hidden sm:block">
            <AccentPicker resolvedTheme={resolvedTheme} />
          </div>

          {/* Mode lecture seule */}
          <button
            onClick={toggleReadOnly}
            title={readOnly ? "Mode lecture seule activé — cliquer pour modifier" : "Activer le mode lecture seule"}
            className={`shrink-0 hidden sm:flex items-center w-8 h-8 justify-center rounded-lg border transition-colors ${
              readOnly
                ? "border-signal-amber bg-signal-amber/10 text-signal-amber"
                : "border-edge text-muted hover:text-accent hover:border-brand/40"
            }`}
          >
            {readOnly ? <LockClosedIcon /> : <EditIcon />}
          </button>

          {/* Toggle vue compacte */}
          <button
            onClick={() => {
              setCompactView((c) => {
                localStorage.setItem("coffre:compactView", String(!c));
                return !c;
              });
            }}
            title={compactView ? "Vue normale" : "Vue compacte"}
            className="shrink-0 hidden sm:flex items-center w-8 h-8 justify-center rounded-lg border border-edge text-muted hover:text-accent hover:border-brand/40 transition-colors"
          >
            {compactView ? "▤" : "☰"}
          </button>

          <button
            onClick={() => { if (!readOnly) setEditing("new"); else showToast("🔒 Mode lecture seule — désactivez-le pour ajouter"); }}
            title={readOnly ? "Mode lecture seule — désactivez-le pour ajouter" : "Nouvelle entrée (Ctrl+N)"}
            className={`px-3 sm:px-4 py-2 rounded-lg bg-brand text-on-brand text-sm font-medium hover:bg-brand-hover transition-colors shrink-0 ${readOnly ? "opacity-50 cursor-not-allowed" : ""}`}
          >
            <span className="hidden sm:inline">+ Ajouter</span>
            <span className="sm:hidden text-lg leading-none">+</span>
          </button>
          {/* Boutons visibles uniquement sur desktop */}
          {!isMobilePlatform() && (
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
                title="Fonctionnalités avancées (partage, Shamir bêta)"
                onClick={() => {
                  setShareTarget(null);
                  setShowAdvanced(true);
                }}
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
          {/* Bouton hamburger visible uniquement sur mobile */}
          {isMobilePlatform() && (
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

        <div className="max-w-3xl mx-auto px-3 sm:px-6 pb-3 flex items-center gap-2 overflow-x-auto scrollbar-none">
          <AlbumPill active={showDashboard} onClick={() => { setShowDashboard(true); setActiveAlbum(ALL_ALBUMS); }}>
            🏠 Accueil
          </AlbumPill>
          <AlbumPill active={!showDashboard && activeAlbum === ALL_ALBUMS} onClick={() => { setShowDashboard(false); setActiveAlbum(ALL_ALBUMS); }}>
            Tous
          </AlbumPill>
          <AlbumPill active={activeAlbum === FAVORITES_ALBUM && !showDashboard} onClick={() => { setShowDashboard(false); setActiveAlbum(FAVORITES_ALBUM); }}>
            ★ Favoris {favoriteCount > 0 && `(${favoriteCount})`}
          </AlbumPill>
          {expiredOrSoonCount > 0 && (
            <AlbumPill
              active={activeAlbum === EXPIRED_ALBUM && !showDashboard}
              onClick={() => { setShowDashboard(false); setActiveAlbum(EXPIRED_ALBUM); }}
              accent="amber"
            >
              ⚠ Expirant ({expiredOrSoonCount})
            </AlbumPill>
          )}
          {orderedCategories.map((c) => (
            <AlbumPill key={c} active={activeAlbum === c && !showDashboard} onClick={() => { setShowDashboard(false); setActiveAlbum(c); }}>
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

      {/* Tri mobile : select déplacé ici, visible uniquement sur mobile */}
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

      {/* Bannière mode lecture seule */}
      {readOnly && (
        <div className="bg-signal-amber/10 border-b border-signal-amber/30 px-4 py-2 flex items-center justify-between gap-3">
          <p className="text-sm text-signal-amber font-medium flex items-center gap-2">
            <span>🔒</span>
            <span>Mode lecture seule — les modifications sont bloquées</span>
          </p>
          <button
            onClick={toggleReadOnly}
            className="text-xs text-signal-amber underline hover:no-underline shrink-0"
          >
            Désactiver
          </button>
        </div>
      )}

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
        {detailItem ? (
          <ItemDetail
            item={detailItem}
            onClose={() => setDetailItem(null)}
            onEdit={() => { setEditing(detailItem); setDetailItem(null); }}
            onCopy={(value, label) => {
              clipboardWriteText(value);
              showToast(`${label} copié`, undefined, 20_000);
            }}
          />
        ) : showDashboard ? (
          <Dashboard
            items={items}
            auditIssueCount={auditIssueCount}
            onOpenAudit={() => setShowAudit(true)}
            onOpenItem={(item) => setDetailItem(item)}
            onAddEntry={() => setEditing("new")}
            onFilterExpired={() => { setActiveAlbum(EXPIRED_ALBUM); setShowDashboard(false); }}
            onFilterAlbum={(album) => { setActiveAlbum(album); setShowDashboard(false); }}
          />
        ) : items.length === 0 ? (
          <EmptyState onAdd={() => setEditing("new")} />
        ) : sorted.length === 0 ? (
          <p className="text-center text-muted text-sm py-16">Aucun résultat.</p>
        ) : (
          <div className="space-y-8">
            {grouped.map(([category, categoryItems]) => (
              <section key={category}>
                <h2 className="text-xs uppercase tracking-widest text-muted mb-3">{category}</h2>
                <div className={compactView ? "divide-y divide-edge" : "space-y-2"}>
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
                      onOpenDetail={() => setDetailItem(item)}
                      selectionMode={selectionMode}
                      selected={selectedIds.has(item.id)}
                      onToggleSelected={() => toggleSelected(item.id)}
                      focused={!selectionMode && focusedId === item.id}
                      onFocusCard={() => setFocusedId(item.id)}
                      compact={compactView}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>

      {/* ===== DRAWER MOBILE ===== */}
      {isMobilePlatform() && (
        <>
          {/* Fond semi-transparent */}
          <div
            className={`fixed inset-0 bg-black/40 z-40 transition-opacity duration-300 ${
              drawerOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
            }`}
            onClick={() => setDrawerOpen(false)}
          />
          {/* Panneau glissant depuis la droite */}
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

              {/* Vues principales */}
              <div className="px-3 mb-2">
                <p className="text-xs uppercase tracking-widest text-muted px-2 mb-1">Vues</p>
                <DrawerItem
                  icon={<span>🏠</span>}
                  label="Accueil"
                  active={showDashboard}
                  onClick={() => { setShowDashboard(true); setActiveAlbum(ALL_ALBUMS); setDrawerOpen(false); }}
                />
                <DrawerItem
                  icon={<span>📦</span>}
                  label={`Toutes les entrées (${items.length})`}
                  active={!showDashboard && activeAlbum === ALL_ALBUMS}
                  onClick={() => { setShowDashboard(false); setActiveAlbum(ALL_ALBUMS); setDrawerOpen(false); }}
                />
                {favoriteCount > 0 && (
                  <DrawerItem
                    icon={<span>⭐</span>}
                    label={`Favoris (${favoriteCount})`}
                    active={activeAlbum === FAVORITES_ALBUM && !showDashboard}
                    onClick={() => { setShowDashboard(false); setActiveAlbum(FAVORITES_ALBUM); setDrawerOpen(false); }}
                  />
                )}
                {expiredOrSoonCount > 0 && (
                  <DrawerItem
                    icon={<span>⚠️</span>}
                    label={`Expirant bientôt (${expiredOrSoonCount})`}
                    active={activeAlbum === EXPIRED_ALBUM && !showDashboard}
                    onClick={() => { setShowDashboard(false); setActiveAlbum(EXPIRED_ALBUM); setDrawerOpen(false); }}
                  />
                )}
              </div>

              {/* Albums */}
              {orderedCategories.length > 0 && (
                <>
                  <div className="border-t border-edge mx-3 my-2" />
                  <div className="px-3 mb-2">
                    <p className="text-xs uppercase tracking-widest text-muted px-2 mb-1">Albums</p>
                    {orderedCategories.map((c) => (
                      <DrawerItem
                        key={c}
                        icon={<span>📁</span>}
                        label={c}
                        active={activeAlbum === c && !showDashboard}
                        onClick={() => { setShowDashboard(false); setActiveAlbum(c); setDrawerOpen(false); }}
                      />
                    ))}
                    <DrawerItem
                      icon={<span>✏️</span>}
                      label="Gérer les albums"
                      onClick={() => { setShowAlbumManager(true); setDrawerOpen(false); }}
                    />
                  </div>
                </>
              )}

              <div className="border-t border-edge mx-3 my-2" />

              {/* Actions */}
              <div className="px-3 mb-2">
                <p className="text-xs uppercase tracking-widest text-muted px-2 mb-1">Actions</p>
                <DrawerItem
                  icon={<span>⚡</span>}
                  label="Ajout rapide"
                  onClick={() => { setShowQuickAdd(true); setDrawerOpen(false); }}
                />
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

              {/* Configuration */}
              <div className="px-3 mb-2">
                <p className="text-xs uppercase tracking-widest text-muted px-2 mb-1">Configuration</p>
                <DrawerItem
                  icon={<GearIcon />}
                  label="Paramètres"
                  onClick={() => { setShowSettings(true); setDrawerOpen(false); }}
                />
                <DrawerItem
                  icon={<span>📊</span>}
                  label="Statistiques"
                  onClick={() => { setShowStats(true); setDrawerOpen(false); }}
                />
                <DrawerItem
                  icon={<span>🔑</span>}
                  label="Kit de récupération"
                  onClick={() => { setShowRecoveryKit(true); setDrawerOpen(false); }}
                />
                <DrawerItem
                  icon={<ImportIcon />}
                  label="Importer un CSV"
                  onClick={() => { setShowImport(true); setDrawerOpen(false); }}
                />
                <DrawerItem
                  icon={<span style={{ fontFamily: "monospace", fontSize: 13 }}>?</span>}
                  label="Raccourcis clavier"
                  onClick={() => { setShowShortcuts(true); setDrawerOpen(false); }}
                />
              </div>

              <div className="border-t border-edge mx-3 my-2" />

              {/* Tri */}
              <div className="px-3 mb-2">
                <p className="text-xs uppercase tracking-widest text-muted px-2 mb-2">Trier par</p>
                {(["favorites", "name", "name-desc", "recent"] as SortMode[]).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => { setSortMode(mode); setDrawerOpen(false); }}
                    className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors mb-0.5 ${
                      sortMode === mode
                        ? "bg-brand/10 text-accent-strong font-medium"
                        : "text-primary hover:bg-surface-2"
                    }`}
                  >
                    {mode === "favorites" ? "⭐ Favoris d'abord"
                      : mode === "name" ? "🔤 Nom (A→Z)"
                      : mode === "name-desc" ? "🔤 Nom (Z→A)"
                      : "🕐 Récemment modifié"}
                  </button>
                ))}
              </div>

              {/* Affichage */}
              <div className="border-t border-edge mx-3 my-2" />
              <div className="px-3 mb-3">
                <p className="text-xs uppercase tracking-widest text-muted px-2 mb-1">Affichage</p>
                <button
                  onClick={() => {
                    setCompactView((c) => {
                      localStorage.setItem("coffre:compactView", String(!c));
                      return !c;
                    });
                    setDrawerOpen(false);
                  }}
                  className="w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors hover:bg-surface-2 text-primary flex items-center justify-between"
                >
                  <span>{compactView ? "☰ Vue compacte" : "▤ Vue normale"}</span>
                  <span className="text-xs text-muted">{compactView ? "→ Passer en normal" : "→ Passer en compact"}</span>
                </button>
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
          onIssueCount={(n) => setAuditIssueCount(n)}
          onOpenItem={(item) => { setShowAudit(false); setDetailItem(item); }}
        />
      )}

      {showImport && <ImportCsv existingItems={items} onClose={() => setShowImport(false)} onImported={handleImported} />}

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
          onShowStats={() => { setShowSettings(false); setShowStats(true); }}
          onClose={() => setShowSettings(false)}
        />
      )}

      {showStats && (
        <Modal onClose={() => setShowStats(false)}>
          <VaultStats items={items} onClose={() => setShowStats(false)} />
        </Modal>
      )}

      {showRecoveryKit && (
        <RecoveryKitModal
          recoveryCode={recoveryCode ?? ""}
          onConfirm={(_snap) => setShowRecoveryKit(false)}
        />
      )}

      {showQuickAdd && (
        <QuickAdd
          categories={categories}
          onSave={async (title, password, category, username, url) => {
            const snapshot = await vaultApi.addItem({
              item_type: "password",
              title, password, username, url,
              category, notes: "", tags: [],
              favorite: false, expires_at: "",
              custom_fields: [], attachments: [],
              generation_rule: null,
              passkey: null,
            });
            applySnapshot(snapshot);
            showToast(`« ${title} » ajouté au coffre`);
          }}
          onClose={() => setShowQuickAdd(false)}
        />
      )}

      {showShortcuts && (
        <KeyboardShortcutsHelp onClose={() => setShowShortcuts(false)} />
      )}

      {showOnboarding && (
        <Onboarding
          onAddFirstEntry={() => { setShowOnboarding(false); setEditing("new"); }}
          onOpenRecoveryKit={() => { setShowOnboarding(false); setShowRecoveryKit(true); }}
          onClose={() => setShowOnboarding(false)}
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
 * Jauge de progression visuelle du délai avant effacement automatique du
 * presse-papiers (roadmap README §1.1). Se vide linéairement sur
 * `durationMs` via une transition CSS déclenchée juste après le montage
 * (double rAF pour laisser le navigateur peindre l'état initial à 100%
 * avant de lancer la transition vers 0%, sinon elle saute directement).
 */
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

function AlbumPill({ active, onClick, children, accent }: { active: boolean; onClick: () => void; children: ReactNode; accent?: "amber" }) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 text-xs px-3 py-1.5 rounded-full border transition-colors ${
        active
          ? accent === "amber"
            ? "bg-signal-amber/20 border-signal-amber text-signal-amber"
            : "bg-brand text-on-brand border-brand"
          : accent === "amber"
          ? "border-signal-amber/40 text-signal-amber hover:bg-signal-amber/10"
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

/** Élément de menu dans le drawer mobile */
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
function LockClosedIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}
function EditIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5Z" />
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

function Modal({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-primary/40 backdrop-blur-sm p-4 overflow-y-auto"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-xl bg-surface rounded-2xl border border-edge shadow-xl p-6 mt-8 mb-8">
        {children}
      </div>
    </div>
  );
}
