import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "coffre:autoLockMinutes";
const DEFAULT_MINUTES = 5;

/** Options proposées dans les Paramètres. 0 = jamais (désactive le verrouillage auto). */
export const AUTO_LOCK_OPTIONS = [1, 5, 10, 15, 30, 0] as const;

function readStored(): number {
  const raw = localStorage.getItem(STORAGE_KEY);
  const parsed = raw !== null ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MINUTES;
}

/**
 * Durée d'inactivité avant verrouillage automatique du coffre, en minutes
 * (0 = désactivé). Persistée en localStorage — c'est une préférence
 * d'application non sensible (ne révèle rien du contenu du coffre), donc
 * volontairement globale plutôt que stockée par vault : elle s'applique
 * à n'importe quel coffre ouvert sur cette machine.
 *
 * Partagé entre `VaultSettings` (pour la modifier) et `VaultView` (pour
 * l'appliquer) via ce même hook, avec un événement `storage`-like manuel
 * (`window.dispatchEvent`) pour que les deux restent synchronisés même si
 * le composant qui lit n'est pas celui qui vient d'écrire.
 */
const CHANGE_EVENT = "coffre:autoLockMinutes:change";

export function useAutoLockMinutes() {
  const [minutes, setMinutesState] = useState<number>(readStored);

  useEffect(() => {
    const onChange = () => setMinutesState(readStored());
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);

  const setMinutes = useCallback((value: number) => {
    localStorage.setItem(STORAGE_KEY, String(value));
    setMinutesState(value);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return { minutes, setMinutes };
}
