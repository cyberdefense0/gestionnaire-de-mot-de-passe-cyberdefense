import { useEffect, useRef, useState } from "react";
import type { WorkerRequest, WorkerResponse } from "./passwordStrength.worker";

export type StrengthLabel = "faible" | "moyen" | "fort" | "excellent";

// zxcvbn note de 0 (trivial) à 4 (très difficile) ; on regroupe 0 et 1 sous
// "faible" pour rester cohérent avec les 4 libellés déjà utilisés dans
// l'app (audit de sécurité, formulaire d'entrée, création du vault).
const SCORE_TO_LABEL: StrengthLabel[] = ["faible", "faible", "moyen", "fort", "excellent"];

export interface StrengthResult {
  label: StrengthLabel;
  /** Score brut zxcvbn, 0 à 4. */
  score: number;
  /**
   * Temps de crack estimé, déjà formaté et traduit en français (ex: "des
   * siècles", "2 heures"). Scénario retenu : "offline slow hashing"
   * (10⁴ essais/seconde), cohérent avec un master password protégé par
   * Argon2id.
   */
  crackTimeDisplay: string;
  warning: string | null;
  suggestions: string[];
}

const EMPTY_RESULT: StrengthResult = { label: "faible", score: 0, crackTimeDisplay: "", warning: null, suggestions: [] };

/**
 * Le calcul zxcvbn (~800ms à 48 caractères, ~3,3s à 100 — voir DEV_NOTES.md)
 * tourne désormais entièrement dans un Web Worker dédié
 * (`passwordStrength.worker.ts`), jamais sur le thread principal : aucun
 * gel de l'UI, quel que soit le nombre de re-renders du composant appelant.
 * Un seul worker est partagé pour toute l'app (créé à la demande, jamais
 * pendant le rendu initial) ; plusieurs requêtes concurrentes sont
 * distinguées par un id incrémental.
 */
let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: StrengthResult) => void; reject: (e: unknown) => void }>();

function getWorker(): Worker | null {
  if (typeof Worker === "undefined") return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./passwordStrength.worker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
      const entry = pending.get(event.data.id);
      if (!entry) return;
      pending.delete(event.data.id);
      const { id: _id, ...rest } = event.data;
      entry.resolve({ label: SCORE_TO_LABEL[rest.score] ?? "faible", ...rest });
    });
    worker.addEventListener("error", (event) => {
      // Le worker a planté globalement (ex: environnement sans support des
      // workers modules) : on rejette toutes les requêtes en attente pour
      // que chaque appelant retombe sur le fallback synchrone.
      for (const [id, entry] of pending) {
        entry.reject(event);
        pending.delete(id);
      }
      worker = null;
    });
    return worker;
  } catch (e) {
    worker = null;
    return null;
  }
}

let fallbackModulePromise: Promise<{
  analyze: (password: string) => StrengthResult;
}> | null = null;

/**
 * Filet de sécurité si les Web Workers modules ne sont pas disponibles
 * (webview très ancienne). Charge zxcvbn dynamiquement (donc toujours hors
 * du bundle principal dans le cas normal) et calcule en synchrone — seul ce
 * chemin de repli peut, dans ce cas précis, bloquer brièvement le thread
 * principal.
 */
async function analyzeFallback(password: string): Promise<StrengthResult> {
  if (!fallbackModulePromise) {
    fallbackModulePromise = (async () => {
      const [{ ZxcvbnFactory }, common, fr] = await Promise.all([
        import("@zxcvbn-ts/core"),
        import("@zxcvbn-ts/language-common"),
        import("@zxcvbn-ts/language-fr"),
      ]);
      const zxcvbn = new ZxcvbnFactory({
        dictionary: { ...common.dictionary, ...fr.dictionary },
        graphs: common.adjacencyGraphs,
        translations: fr.translations,
      });
      return {
        analyze: (pwd: string): StrengthResult => {
          const result = zxcvbn.check(pwd);
          return {
            label: SCORE_TO_LABEL[result.score] ?? "faible",
            score: result.score,
            crackTimeDisplay: result.crackTimes.offlineSlowHashingXPerSecond.display,
            warning: result.feedback.warning,
            suggestions: result.feedback.suggestions,
          };
        },
      };
    })();
  }
  const mod = await fallbackModulePromise;
  return mod.analyze(password);
}

/** Analyse asynchrone, hors thread principal (voie normale). */
export function analyzeStrengthAsync(password: string): Promise<StrengthResult> {
  if (!password) return Promise.resolve(EMPTY_RESULT);
  const w = getWorker();
  if (!w) return analyzeFallback(password);

  const id = nextId++;
  const req: WorkerRequest = { id, password };
  return new Promise<StrengthResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage(req);
  }).catch(() => analyzeFallback(password));
}

/** Version courte utilisée là où seul le libellé compte (audit de sécurité, badges). */
export async function estimateStrengthLabelAsync(password: string): Promise<StrengthLabel> {
  return (await analyzeStrengthAsync(password)).label;
}

/**
 * Hook React : calcule la force d'un mot de passe dans le Web Worker, avec
 * debounce (250ms par défaut) et garde-fou anti-résultat-obsolète. `result`
 * vaut `null` tant qu'aucun calcul n'a encore abouti pour la valeur
 * actuelle de `password` (mot de passe vide = résultat immédiat, pas de
 * debounce).
 */
export function usePasswordStrength(password: string, debounceMs = 250): { result: StrengthResult | null; pending: boolean } {
  const [result, setResult] = useState<StrengthResult | null>(password ? null : EMPTY_RESULT);
  const [isPending, setIsPending] = useState(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    if (!password) {
      setResult(EMPTY_RESULT);
      setIsPending(false);
      return;
    }
    setIsPending(true);
    const timer = setTimeout(() => {
      analyzeStrengthAsync(password).then((r) => {
        if (cancelledRef.current) return;
        setResult(r);
        setIsPending(false);
      });
    }, debounceMs);
    return () => {
      cancelledRef.current = true;
      clearTimeout(timer);
    };
  }, [password, debounceMs]);

  return { result, pending: isPending };
}
