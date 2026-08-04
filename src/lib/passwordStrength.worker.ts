/// <reference lib="webworker" />
import { ZxcvbnFactory } from "@zxcvbn-ts/core";
import * as zxcvbnCommonPackage from "@zxcvbn-ts/language-common";
import * as zxcvbnFrPackage from "@zxcvbn-ts/language-fr";
import * as zxcvbnEnPackage from "@zxcvbn-ts/language-en";

/**
 * Web Worker dédié au calcul zxcvbn (voir roadmap README §2.1 "Isolation de
 * zxcvbn dans un Web Worker"). `zxcvbn.check()` est coûteux (~800ms pour un
 * mot de passe de 48 caractères, ~3,3s à 100 — voir DEV_NOTES.md) ; le faire
 * tourner ici, hors du thread principal, évite tout gel de l'UI quel que
 * soit le nombre de re-renders du composant appelant, sans même avoir
 * besoin du debounce déjà en place côté `VaultItemForm` (qui reste utile
 * pour éviter de spammer le worker à chaque frappe, mais n'a plus à
 * protéger le thread de rendu lui-même).
 *
 * Les dictionnaires FR+EN (~2,5 Mo) sont chargés une seule fois, ici, au
 * démarrage du worker — donc plus du tout dans le bundle exécuté par le
 * thread principal.
 */
const zxcvbn = new ZxcvbnFactory({
  dictionary: {
    ...zxcvbnCommonPackage.dictionary,
    ...zxcvbnFrPackage.dictionary,
    ...zxcvbnEnPackage.dictionary,
  },
  graphs: zxcvbnCommonPackage.adjacencyGraphs,
  translations: zxcvbnFrPackage.translations,
});

export interface WorkerRequest {
  id: number;
  password: string;
}

export interface WorkerResponse {
  id: number;
  score: number;
  crackTimeDisplay: string;
  warning: string | null;
  suggestions: string[];
}

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const { id, password } = event.data;
  const result = zxcvbn.check(password);
  const response: WorkerResponse = {
    id,
    score: result.score,
    crackTimeDisplay: result.crackTimes.offlineSlowHashingXPerSecond.display,
    warning: result.feedback.warning,
    suggestions: result.feedback.suggestions,
  };
  (self as unknown as Worker).postMessage(response);
});
