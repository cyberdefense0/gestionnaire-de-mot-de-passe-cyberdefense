import { ZxcvbnFactory } from "@zxcvbn-ts/core";
import * as zxcvbnCommonPackage from "@zxcvbn-ts/language-common";
import * as zxcvbnFrPackage from "@zxcvbn-ts/language-fr";
import * as zxcvbnEnPackage from "@zxcvbn-ts/language-en";

/**
 * Remplace l'ancienne heuristique maison (`longueur × nombre de types de
 * caractères`), qui plafonnait à "moyen" des mots de passe longs déjà
 * quasi incrackables (ex: 16 caractères sur 3 types = 48 points = "moyen",
 * alors que l'entropie réelle représente des siècles de calcul). zxcvbn
 * simule de vraies attaques (dictionnaires, motifs de clavier, dates,
 * l33t-speak, répétitions) plutôt qu'un calcul arithmétique naïf — c'est
 * la même bibliothèque (créée par Dropbox) qu'utilisent la plupart des
 * gestionnaires de mots de passe du marché, dont Bitwarden.
 *
 * Dictionnaires FR + EN chargés (les mots de passe et les mots courants ne
 * sont pas tous anglophones), traductions FR pour les temps de crack et
 * suggestions affichés à l'utilisateur.
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
   * Argon2id — un attaquant qui obtiendrait le fichier .vault devrait
   * quand même refaire tourner le KDF à chaque essai. Pour un mot de passe
   * de site tiers (susceptible d'être haché rapidement côté serveur si mal
   * protégé), c'est une estimation plutôt optimiste : à prendre comme un
   * ordre de grandeur, pas une garantie.
   */
  crackTimeDisplay: string;
  warning: string | null;
  suggestions: string[];
}

export function analyzeStrength(password: string): StrengthResult {
  if (!password) {
    return { label: "faible", score: 0, crackTimeDisplay: "", warning: null, suggestions: [] };
  }
  const result = zxcvbn.check(password);
  return {
    label: SCORE_TO_LABEL[result.score] ?? "faible",
    score: result.score,
    crackTimeDisplay: result.crackTimes.offlineSlowHashingXPerSecond.display,
    warning: result.feedback.warning,
    suggestions: result.feedback.suggestions,
  };
}

/** Version courte utilisée là où seul le libellé compte (audit de sécurité, badges). */
export function estimateStrengthLabel(password: string): StrengthLabel {
  return analyzeStrength(password).label;
}
