/**
 * Sélecteur de palette de couleur d'accent.
 * Affiché dans le header sous forme de pastilles colorées.
 * Le choix est appliqué immédiatement (CSS vars) et mémorisé (localStorage).
 */

import { useEffect, useRef, useState } from "react";
import {
  PALETTES,
  readStoredPalette,
  applyPalette,
  savePalette,
  type AccentPalette,
} from "../lib/accentColor";

interface Props {
  /** Thème résolu actuel ("light" | "dark"), pour recalculer les CSS vars. */
  resolvedTheme: "light" | "dark";
}

export function AccentPicker({ resolvedTheme }: Props) {
  const [current, setCurrent] = useState<AccentPalette>(readStoredPalette);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Ferme le popover si on clique ailleurs
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleSelect = (id: AccentPalette) => {
    setCurrent(id);
    savePalette(id);
    applyPalette(id, resolvedTheme === "dark");
    setOpen(false);
  };

  const currentDef = PALETTES.find((p) => p.id === current) ?? PALETTES[0];

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Changer la couleur d'accent"
        className="w-8 h-8 rounded-full border-2 border-edge hover:border-brand/60 transition-colors flex items-center justify-center"
        style={{ backgroundColor: currentDef.swatch }}
        aria-label="Couleur d'accent"
      />

      {open && (
        <div className="absolute right-0 top-full mt-2 bg-surface border border-edge rounded-xl shadow-lg p-3 z-50 flex flex-col gap-2 min-w-[9rem]">
          <p className="text-[10px] uppercase tracking-widest text-muted mb-1">Couleur d'accent</p>
          {PALETTES.map((p) => (
            <button
              key={p.id}
              onClick={() => handleSelect(p.id)}
              className={`flex items-center gap-2.5 w-full px-2 py-1.5 rounded-lg transition-colors ${
                p.id === current
                  ? "bg-surface-2"
                  : "hover:bg-surface-2"
              }`}
            >
              <span
                className="w-4 h-4 rounded-full shrink-0 border border-edge"
                style={{ backgroundColor: p.swatch }}
              />
              <span className="text-sm text-primary">{p.label}</span>
              {p.id === current && (
                <span className="ml-auto text-xs text-muted">✓</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
