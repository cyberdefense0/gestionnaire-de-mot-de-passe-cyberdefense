import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export interface UpdateInfo {
  version: string;
  notes: string | null;
}

// L'objet `Update` retourné par `check()` porte lui-même les méthodes de
// téléchargement/installation — on le garde en mémoire entre le moment où
// on détecte une mise à jour et celui où l'utilisateur clique "Installer".
let pendingUpdate: Update | null = null;

/** Vérifie s'il existe une mise à jour, sans rien installer. Échoue
 * silencieusement (retourne null) en l'absence de réseau, en développement
 * (pas de build signé disponible), ou si l'endpoint ne répond pas — ce
 * n'est jamais une erreur bloquante pour l'utilisateur. */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    const update = await check();
    if (!update) return null;
    pendingUpdate = update;
    return { version: update.version, notes: update.body ?? null };
  } catch {
    return null;
  }
}

/** Télécharge et installe la mise à jour précédemment détectée par
 * `checkForUpdate`, puis relance l'application. `onProgress` reçoit les
 * octets téléchargés et le total (le total peut être `undefined` si le
 * serveur ne l'indique pas). */
export async function installPendingUpdate(onProgress?: (downloaded: number, total: number | undefined) => void): Promise<void> {
  if (!pendingUpdate) throw new Error("Aucune mise à jour en attente.");
  let downloaded = 0;
  let contentLength: number | undefined;
  await pendingUpdate.downloadAndInstall((event) => {
    if (event.event === "Started") {
      contentLength = event.data.contentLength;
    } else if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
      onProgress?.(downloaded, contentLength);
    }
  });
  // Sur Windows, l'app se ferme automatiquement pendant l'installation
  // (limitation des installeurs Windows, documentée par Tauri) ; sur
  // macOS/Linux, on relance nous-mêmes pour que l'utilisateur retrouve
  // l'app ouverte avec la nouvelle version sans étape manuelle.
  await relaunch();
}
