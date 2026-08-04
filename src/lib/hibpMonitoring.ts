import { useCallback, useEffect, useState } from "react";
import type { VaultItem } from "../types";
import { checkPasswordPwned } from "./hibp";

/**
 * Surveillance HIBP continue, opt-in (roadmap README §3.1). Réutilise
 * `checkPasswordPwned` (k-anonymat, voir hibp.ts — seuls les 5 premiers
 * caractères hexadécimaux du hash SHA-1 quittent la machine), mais au lieu
 * d'être déclenchée manuellement depuis l'audit, tourne automatiquement en
 * tâche de fond tant que l'application est ouverte.
 *
 * Ce qui est stocké en localStorage (préférence + horodatages, jamais de
 * mot de passe ni de hash) :
 *  - `coffre:hibpMonitoring` : activé/non + dernière vérification.
 *  - `coffre:hibpKnownPwned` : { itemId: boolean } — dernier statut connu
 *    par entrée, pour ne notifier QUE les nouvelles compromissions (pas
 *    spammer à chaque vérification pour un mot de passe déjà signalé).
 */

const SETTINGS_KEY = "coffre:hibpMonitoring";
const KNOWN_KEY = "coffre:hibpKnownPwned";
const CHANGE_EVENT = "coffre:hibpMonitoring:change";

/** Fréquence minimale entre deux vérifications complètes du vault (heures). */
export const HIBP_CHECK_INTERVAL_HOURS = 24;
/** Pause entre deux requêtes HIBP successives, pour rester poli envers l'API publique. */
const REQUEST_DELAY_MS = 400;

export interface HibpMonitoringSettings {
  enabled: boolean;
  /** ISO, ou null si jamais vérifié. */
  lastCheckAt: string | null;
}

const DEFAULTS: HibpMonitoringSettings = { enabled: false, lastCheckAt: null };

function readSettings(): HibpMonitoringSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return DEFAULTS;
  }
}

function writeSettings(settings: HibpMonitoringSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function readKnown(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(KNOWN_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeKnown(map: Record<string, boolean>) {
  localStorage.setItem(KNOWN_KEY, JSON.stringify(map));
}

export function useHibpMonitoringSettings() {
  const [settings, setSettingsState] = useState<HibpMonitoringSettings>(readSettings);

  useEffect(() => {
    const onChange = () => setSettingsState(readSettings());
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);

  const update = useCallback((patch: Partial<HibpMonitoringSettings>) => {
    const next = { ...readSettings(), ...patch };
    writeSettings(next);
    setSettingsState(next);
  }, []);

  return { settings, update };
}

export function isHibpCheckDue(settings: HibpMonitoringSettings): boolean {
  if (!settings.enabled) return false;
  if (!settings.lastCheckAt) return true;
  const elapsedHours = (Date.now() - new Date(settings.lastCheckAt).getTime()) / (1000 * 60 * 60);
  return elapsedHours >= HIBP_CHECK_INTERVAL_HOURS;
}

export function markHibpCheckDone() {
  writeSettings({ ...readSettings(), lastCheckAt: new Date().toISOString() });
}

export interface HibpCheckResult {
  checked: number;
  /** Entrées dont le mot de passe est détecté compromis pour la première fois (ou après un changement de mot de passe). */
  newlyPwned: VaultItem[];
  failed: boolean;
}

/**
 * Vérifie chaque mot de passe du vault contre HIBP, séquentiellement (pas
 * de `Promise.all` : rester raisonnable envers une API publique gratuite),
 * et renvoie uniquement les entrées nouvellement détectées compromises —
 * pas celles déjà connues, pour ne pas re-notifier à chaque passage.
 * Best-effort : une panne réseau/API interrompt proprement sans planter
 * l'appelant (`failed: true`), le prochain passage réessaiera.
 */
export async function runHibpMonitoringCheck(items: VaultItem[]): Promise<HibpCheckResult> {
  const known = readKnown();
  const newlyPwned: VaultItem[] = [];
  const passwordItems = items.filter((i) => i.item_type === "password" && i.password);
  let checked = 0;

  for (const item of passwordItems) {
    try {
      const count = await checkPasswordPwned(item.password);
      const isPwned = count > 0;
      if (isPwned && known[item.id] !== true) newlyPwned.push(item);
      known[item.id] = isPwned;
      checked++;
    } catch {
      // Service HIBP indisponible : on s'arrête là pour cette passe plutôt
      // que de marquer les entrées restantes comme "non compromises" sur la
      // base d'une erreur réseau.
      writeKnown(known);
      return { checked, newlyPwned, failed: true };
    }
    if (passwordItems.indexOf(item) < passwordItems.length - 1) {
      await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
    }
  }

  // Nettoie les entrées supprimées du vault depuis la dernière vérification.
  for (const id of Object.keys(known)) {
    if (!items.some((i) => i.id === id)) delete known[id];
  }
  writeKnown(known);
  markHibpCheckDone();
  return { checked, newlyPwned, failed: false };
}
