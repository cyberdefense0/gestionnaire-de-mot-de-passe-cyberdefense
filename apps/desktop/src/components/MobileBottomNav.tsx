/**
 * Barre de navigation inférieure (bottom tab bar) pour mobile.
 *
 * Remplace le bouton hamburger + drawer latéral par 4 onglets fixes
 * en bas de l'écran, toujours visibles. Chaque onglet est accessible
 * en un tap, sans geste ni menu intermédiaire.
 *
 * Onglets :
 *   🏠 Accueil   — dashboard
 *   📦 Coffre    — liste complète des entrées
 *   🛡 Sécurité  — audit
 *   ⚙️ Paramètres — bottom sheet glissant depuis le bas
 *
 * Le panneau Paramètres est un "bottom sheet" qui monte depuis le bord
 * inférieur avec une animation `translate-y`. Il supporte :
 *   - Un glisser vers le bas (swipe down) pour le fermer
 *   - Un tap sur le fond semi-transparent pour le fermer
 *   - La gestion de la safe area iOS (padding-bottom dynamique)
 *
 * CORRECTIFS (v2) :
 *   - Le panneau n'est monté dans le DOM que lorsqu'il est ouvert
 *     (montage conditionnel) — évite qu'un translateY(100%) non appliqué
 *     au premier paint sur WebKitGTK/Android le rende visible par défaut.
 *   - L'état settingsOpen est piloté exclusivement par les clics sur l'onglet
 *     ⚙️ et par closeSettings — plus de useEffect qui écoutait activeTab
 *     (source de désynchronisation).
 *   - closeSettings notifie le parent via onTabChange("vault") AVANT de
 *     démonter le panneau, pour que l'onglet actif revienne bien à "vault".
 *   - Le bouton ✕ et le tap sur le fond appellent tous les deux closeSettings
 *     directement, sans passer par VaultSettings.onClose (qui appelait
 *     handleMobileTab et ne touchait pas settingsOpen local).
 */
import { useRef, useState } from "react";

interface Tab {
  id: "home" | "vault" | "security" | "settings";
  icon: string;
  label: string;
}

const TABS: Tab[] = [
  { id: "home",     icon: "🏠", label: "Accueil"    },
  { id: "vault",    icon: "📦", label: "Coffre"     },
  { id: "security", icon: "🛡", label: "Sécurité"  },
  { id: "settings", icon: "⚙️", label: "Paramètres" },
];

interface Props {
  activeTab: "home" | "vault" | "security" | "settings" | null;
  onTabChange: (tab: "home" | "vault" | "security" | "settings") => void;
  /** Contenu du bottom sheet "Paramètres" — fourni par le parent */
  settingsContent: React.ReactNode;
  /** Badge rouge sur l'onglet Sécurité si > 0 */
  auditBadge?: number;
}

export function MobileBottomNav({ activeTab, onTabChange, settingsContent, auditBadge }: Props) {
  // Piloté uniquement par les clics — pas de useEffect sur activeTab
  // (évite la désynchronisation : le parent peut changer activeTab sans
  // vouloir ouvrir le sheet, ex. quand onClose remet mobileTab à "vault").
  const [settingsOpen, setSettingsOpen] = useState(false);

  /** Position Y actuelle du glisser en cours (null si pas de glisser) */
  const [dragY, setDragY] = useState<number | null>(null);
  const startYRef = useRef<number | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  const openSettings = () => {
    setSettingsOpen(true);
    onTabChange("settings");
  };

  const closeSettings = () => {
    // Notifie le parent en premier pour que l'onglet actif revienne à "vault"
    onTabChange("vault");
    setSettingsOpen(false);
    setDragY(null);
  };

  // ── Gestion du glisser vers le bas (swipe-down to dismiss) ──────────────

  const onTouchStart = (e: React.TouchEvent) => {
    // Seulement si le sheet est en haut de son scroll (évite de confondre
    // un scroll interne avec un geste de fermeture)
    const el = sheetRef.current;
    if (el && el.scrollTop > 0) return;
    startYRef.current = e.touches[0].clientY;
  };

  const onTouchMove = (e: React.TouchEvent) => {
    if (startYRef.current === null) return;
    const delta = e.touches[0].clientY - startYRef.current;
    if (delta < 0) return; // glisser vers le haut = scroll normal
    setDragY(delta);
  };

  const onTouchEnd = () => {
    if (dragY !== null && dragY > 80) {
      closeSettings();
    } else {
      setDragY(null);
    }
    startYRef.current = null;
  };

  // Calcul de la translation du sheet pendant le glisser
  const sheetTranslate = dragY !== null ? `translateY(${dragY}px)` : "translateY(0)";
  const sheetTransition = dragY !== null
    ? "none"
    : "transform 0.35s cubic-bezier(0.32, 0.72, 0, 1)";

  return (
    <>
      {/* ── Barre de navigation ──────────────────────────────────────── */}
      <nav
        className="fixed bottom-0 left-0 right-0 z-30 bg-surface border-t border-edge flex items-stretch"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {TABS.map((tab) => {
          const isActive = tab.id === "settings"
            ? settingsOpen
            : tab.id === activeTab && !settingsOpen;
          return (
            <button
              key={tab.id}
              onClick={() => {
                if (tab.id === "settings") {
                  if (settingsOpen) {
                    closeSettings();
                  } else {
                    openSettings();
                  }
                } else {
                  if (settingsOpen) setSettingsOpen(false);
                  onTabChange(tab.id);
                }
              }}
              className={`relative flex-1 flex flex-col items-center justify-center gap-0.5 py-2.5 transition-colors ${
                isActive ? "text-brand" : "text-muted hover:text-primary"
              }`}
            >
              <span className="text-xl leading-none relative">
                {tab.icon}
                {/* Badge rouge pour l'audit */}
                {tab.id === "security" && auditBadge && auditBadge > 0 ? (
                  <span className="absolute -top-1 -right-1.5 min-w-[14px] h-3.5 rounded-full bg-signal-red text-white text-[8px] font-bold flex items-center justify-center px-0.5 leading-none">
                    {auditBadge > 9 ? "9+" : auditBadge}
                  </span>
                ) : null}
              </span>
              <span className={`text-[10px] font-medium leading-none ${isActive ? "text-brand" : ""}`}>
                {tab.label}
              </span>
              {/* Indicateur actif */}
              {isActive && (
                <span className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 rounded-full bg-brand" />
              )}
            </button>
          );
        })}
      </nav>

      {/* ── Bottom sheet Paramètres ───────────────────────────────────── */}
      {/* Montage conditionnel : le panneau n'existe dans le DOM que quand
          settingsOpen est true. Évite qu'un translateY(100%) non appliqué
          au premier paint (bug WebKitGTK / Android WebView) le rende
          visible au démarrage de l'app. */}
      {settingsOpen && (
        <>
          {/* Fond semi-transparent */}
          <div
            className="fixed inset-0 bg-black/50 z-40"
            style={{ opacity: Math.max(0, 1 - (dragY ?? 0) / 300) }}
            onClick={closeSettings}
          />

          {/* Panneau */}
          <div
            className="fixed left-0 right-0 bottom-0 z-50 bg-surface rounded-t-2xl shadow-2xl flex flex-col"
            style={{
              transform: sheetTranslate,
              transition: sheetTransition,
              maxHeight: "88vh",
              paddingBottom: "env(safe-area-inset-bottom)",
            }}
          >
            {/* Poignée de glisser (drag handle) */}
            <div
              className="flex justify-center pt-3 pb-1 cursor-grab active:cursor-grabbing shrink-0"
              onTouchStart={onTouchStart}
              onTouchMove={onTouchMove}
              onTouchEnd={onTouchEnd}
            >
              <div className="w-10 h-1 rounded-full bg-edge" />
            </div>

            {/* En-tête */}
            <div
              className="flex items-center justify-between px-5 py-3 border-b border-edge shrink-0"
              onTouchStart={onTouchStart}
              onTouchMove={onTouchMove}
              onTouchEnd={onTouchEnd}
            >
              <h2 className="font-display text-lg font-semibold text-primary">Paramètres du coffre</h2>
              <button
                onClick={closeSettings}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-muted hover:text-primary hover:bg-surface-2 transition-colors"
                aria-label="Fermer les paramètres"
              >
                ✕
              </button>
            </div>

            {/* Contenu scrollable */}
            <div
              ref={sheetRef}
              className="flex-1 overflow-y-auto overscroll-contain"
            >
              {settingsContent}
            </div>
          </div>
        </>
      )}
    </>
  );
}
