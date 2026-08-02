import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

let permissionChecked = false;
let permissionGranted = false;

/** Demande la permission une seule fois par session (pas à chaque notification). */
async function ensurePermission(): Promise<boolean> {
  if (permissionChecked) return permissionGranted;
  permissionChecked = true;
  permissionGranted = await isPermissionGranted();
  if (!permissionGranted) {
    const result = await requestPermission();
    permissionGranted = result === "granted";
  }
  return permissionGranted;
}

/**
 * Envoie une notification système (fonctionne même fenêtre minimisée/pas au
 * premier plan) — best-effort : si la permission est refusée ou le plugin
 * indisponible sur la plateforme, échoue silencieusement plutôt que de
 * gêner l'utilisateur. Ces notifications viennent TOUJOURS en complément
 * des bannières déjà présentes dans l'app, jamais à leur place.
 */
export async function notify(title: string, body: string): Promise<void> {
  try {
    if (!(await ensurePermission())) return;
    sendNotification({ title, body });
  } catch {
    // Silencieux : une notification manquée n'est jamais bloquante.
  }
}
