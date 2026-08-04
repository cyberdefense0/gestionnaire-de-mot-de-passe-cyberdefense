import { writeText, readText, clear } from "@tauri-apps/plugin-clipboard-manager";

export const CLIPBOARD_CLEAR_MS = 20 * 1000; // 20 secondes

/**
 * Copie un secret dans le presse-papiers NATIF (plugin Tauri), pas
 * `navigator.clipboard` : l'API Web exige que le document ait le focus, ce
 * qui échoue silencieusement sur WebKitGTK/Linux dès qu'on change de
 * fenêtre pour coller le secret copié — précisément le cas d'usage normal
 * (voir VaultView.tsx pour l'historique complet du bug).
 *
 * Efface ensuite automatiquement le presse-papiers après `clearMs`,
 * uniquement s'il contient toujours exactement ce secret (évite d'écraser
 * autre chose que l'utilisateur aurait copié entre-temps).
 */
export async function copySecretWithAutoClear(secret: string, clearMs = CLIPBOARD_CLEAR_MS): Promise<void> {
  await writeText(secret);
  setTimeout(async () => {
    try {
      const current = await readText();
      if (current === secret) {
        await clear();
      }
    } catch {
      // Presse-papiers illisible (ex: un autre processus l'a verrouillé
      // brièvement) : on n'efface pas à l'aveugle, cf. VaultView.tsx.
    }
  }, clearMs);
}
