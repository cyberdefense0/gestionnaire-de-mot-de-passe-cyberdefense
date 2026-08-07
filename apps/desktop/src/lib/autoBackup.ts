import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "coffre:autoBackup";
const CHANGE_EVENT = "coffre:autoBackup:change";

/** Nombre de sauvegardes automatiques conservées dans le dossier cible avant rotation (voir `auto_backup` côté Rust). */
export const AUTO_BACKUP_KEEP = 10;

export const AUTO_BACKUP_FREQUENCIES = [
  { hours: 24, label: "Tous les jours" },
  { hours: 24 * 7, label: "Toutes les semaines" },
  { hours: 24 * 30, label: "Tous les mois" },
] as const;

export interface AutoBackupSettings {
  enabled: boolean;
  /** Dossier cible choisi par l'utilisateur, ou null si jamais configuré. */
  folder: string | null;
  frequencyHours: number;
  /** ISO, ou null si aucune sauvegarde automatique n'a encore eu lieu. */
  lastBackupAt: string | null;
}

const DEFAULTS: AutoBackupSettings = {
  enabled: false,
  folder: null,
  frequencyHours: 24 * 7,
  lastBackupAt: null,
};

function readStored(): AutoBackupSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return DEFAULTS;
  }
}

function writeStored(settings: AutoBackupSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/**
 * Préférence non sensible (chemin de dossier + fréquence + date, jamais de
 * mot de passe ni de contenu du coffre), donc en localStorage comme
 * `autoLock`/`recentVaults`. Le dossier cible peut recevoir plusieurs
 * coffres différents au fil du temps si l'utilisateur change de vault — la
 * rotation côté Rust (`AUTO_BACKUP_PREFIX`) ne distingue pas selon le
 * vault source, seulement selon le nom de fichier généré. Cas limite jugé
 * acceptable : rare, et sans risque (juste des sauvegardes plus vite
 * tournées si plusieurs coffres partagent le même dossier cible).
 */
export function useAutoBackupSettings() {
  const [settings, setSettingsState] = useState<AutoBackupSettings>(readStored);

  useEffect(() => {
    const onChange = () => setSettingsState(readStored());
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);

  const update = useCallback((patch: Partial<AutoBackupSettings>) => {
    const next = { ...readStored(), ...patch };
    writeStored(next);
    setSettingsState(next);
  }, []);

  return { settings, update };
}

/** true si une sauvegarde automatique est due, en dehors de tout composant React. */
export function isAutoBackupDue(settings: AutoBackupSettings): boolean {
  if (!settings.enabled || !settings.folder) return false;
  if (!settings.lastBackupAt) return true;
  const elapsedHours = (Date.now() - new Date(settings.lastBackupAt).getTime()) / (1000 * 60 * 60);
  return elapsedHours >= settings.frequencyHours;
}

export function markAutoBackupDone() {
  writeStored({ ...readStored(), lastBackupAt: new Date().toISOString() });
}
