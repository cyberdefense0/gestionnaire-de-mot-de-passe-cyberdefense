import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "coffre:lockOnBlur";
const CHANGE_EVENT = "coffre:lockOnBlur:change";

function readStored(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "true";
}

/**
 * Verrouille le coffre dès que la fenêtre de l'application perd le focus.
 *
 * Ce que ça détecte VRAIMENT : la perte de focus de la fenêtre — ce qui
 * inclut la mise en veille de l'écran et le verrouillage de session (ils
 * font perdre le focus en même temps), mais aussi un simple Alt+Tab vers
 * une autre application. Tauri n'expose pas d'événement "mise en veille
 * système" dédié et fiable cross-plateforme sans plugin natif
 * supplémentaire — `onFocusChanged` est le signal le plus robuste
 * disponible nativement. D'où le nom honnête du réglage ("perte de
 * focus", pas "mise en veille détectée") et le fait qu'il soit désactivé
 * par défaut : pour beaucoup d'utilisateurs, verrouiller à chaque Alt+Tab
 * serait plus gênant qu'utile. Le verrouillage sur inactivité (minuteur,
 * voir `useAutoLockMinutes`) et `Ctrl/Cmd+L` restent les mécanismes
 * principaux ; ceci est une couche de défense supplémentaire, optionnelle.
 */
export function useLockOnBlur() {
  const [enabled, setEnabledState] = useState<boolean>(readStored);

  useEffect(() => {
    const onChange = () => setEnabledState(readStored());
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);

  const setEnabled = useCallback((value: boolean) => {
    localStorage.setItem(STORAGE_KEY, String(value));
    setEnabledState(value);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return { enabled, setEnabled };
}
