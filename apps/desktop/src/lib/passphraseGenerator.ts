// IMPORTANT : on importe UNIQUEMENT les données JSON du paquet
// eff-diceware-passphrase, jamais son point d'entrée JS (`index.js`).
// Ce dernier fait `require('secure-sample')` / `require('secure-shuffle')`
// au niveau module, qui remontent jusqu'à `sodium-native` — un module
// natif Node (binaire .node compilé). Ça fonctionne très bien dans un
// script Node classique, mais PAS dans une webview Tauri (le frontend
// tourne dans un moteur de rendu web, pas dans Node : il n'y a rien pour
// charger un binaire natif). Importer `index.js`, même sans jamais appeler
// la fonction exportée, suffit à exécuter ces `require` au chargement du
// module et ferait planter l'app au premier écran affichant ce fichier.
// La liste de mots elle-même (`wordlist.json`) est une simple donnée JSON
// sans aucune dépendance native — c'est la seule chose qu'on importe d'ici.
import wordlist from "eff-diceware-passphrase/wordlist.json";

/**
 * Phrase de passe façon Diceware : plusieurs mots aléatoires plutôt qu'une
 * suite de caractères. Utilise la vraie liste EFF (7 776 mots, la référence
 * de la communauté sécurité pour ce type de génération, embarquée par le
 * paquet npm `eff-diceware-passphrase` — voir la note ci-dessus sur
 * pourquoi seules ses données JSON sont importées). Le tirage lui-même
 * utilise directement `crypto.getRandomValues` (Web Crypto API, la même
 * source que le générateur par caractères existant), pas le code RNG du
 * paquet, justement pour éviter sa dépendance native.
 *
 * Les mots restent en anglais même dans une app francophone : c'est un
 * choix assumé — la liste EFF est largement auditée et optimisée
 * (mots courts, non ambigus à l'oral/à l'écrit, aucun préfixe partagé),
 * et c'est ce qu'utilisent la plupart des gestionnaires de référence (ex:
 * Bitwarden) même pour des interfaces non anglophones. Une liste
 * française pourrait être ajoutée plus tard si besoin, mais n'est pas
 * aussi rigoureusement auditée à ma connaissance.
 */
export interface PassphraseOptions {
  /** Nombre de mots. 5+ recommandé (voir `entropyBits`). */
  wordCount: number;
  separator: string;
  /** Met en majuscule la première lettre de chaque mot. */
  capitalize: boolean;
  /** Ajoute un chiffre aléatoire (0-99) à la fin, façon "cheval-lampe-neige-42". */
  includeNumber: boolean;
}

export const DEFAULT_PASSPHRASE_OPTIONS: PassphraseOptions = {
  wordCount: 5,
  separator: "-",
  capitalize: true,
  includeNumber: true,
};

const WORDS: readonly string[] = wordlist;

/** ~12,9 bits d'entropie par mot (log2(7776)), c'est la liste EFF standard. */
const BITS_PER_WORD = Math.log2(WORDS.length);

export function entropyBits(wordCount: number, includeNumber: boolean): number {
  return wordCount * BITS_PER_WORD + (includeNumber ? Math.log2(100) : 0);
}

/** Entier aléatoire uniforme dans [0, max) via crypto.getRandomValues,
 * avec rejet des valeurs qui biaiseraient le modulo (même principe que le
 * générateur par caractères, en plus explicite ici car max n'est pas une
 * puissance de 2 propre). */
function secureRandomInt(max: number): number {
  const range = Math.floor(0xffffffff / max) * max;
  const buf = new Uint32Array(1);
  let value: number;
  do {
    crypto.getRandomValues(buf);
    value = buf[0];
  } while (value >= range);
  return value % max;
}

/** Tire `count` mots distincts de la liste (sans remise), ordre aléatoire. */
function pickWords(count: number): string[] {
  const n = Math.min(Math.max(1, count), WORDS.length);
  // Réservoir de Fisher-Yates partiel : mélange seulement ce qui est
  // nécessaire plutôt que la liste entière (7776 mots), inutile ici.
  const pool = [...WORDS];
  const picked: string[] = [];
  for (let i = 0; i < n; i++) {
    const idx = secureRandomInt(pool.length - i) + i;
    [pool[i], pool[idx]] = [pool[idx], pool[i]];
    picked.push(pool[i]);
  }
  return picked;
}

export function generateMemorablePassphrase(opts: PassphraseOptions): string {
  const words = pickWords(Math.max(3, opts.wordCount));
  const cased = opts.capitalize ? words.map((w) => w[0].toUpperCase() + w.slice(1)) : words;
  const withNumber = opts.includeNumber ? [...cased, String(secureRandomInt(100))] : cased;
  return withNumber.join(opts.separator);
}
