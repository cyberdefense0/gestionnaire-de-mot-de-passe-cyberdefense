/**
 * Recherche approximative (fuzzy search) avec tolérance aux fautes de frappe.
 *
 * Implémentation sans dépendance externe :
 * - D'abord recherche "contient" exacte (insensible à la casse et aux accents),
 *   toujours prioritaire sur la recherche floue.
 * - Ensuite distance de Damerau–Levenshtein (transpositions, insertions,
 *   suppressions, substitutions) sur chaque mot de la requête vs. chaque
 *   token du texte à chercher.
 *
 * Seuils calibrés pour éviter les faux positifs sur de courts mots :
 *   - longueur < 4 : uniquement correspondance exacte
 *   - longueur 4–6 : distance ≤ 1
 *   - longueur ≥ 7 : distance ≤ 2
 *
 * Usage : `fuzzyMatch(query, text)` → true/false
 */

/** Normalise une chaîne pour la comparaison : minuscules + accents retirés. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Distance de Damerau–Levenshtein bornée. Retourne la distance ou Infinity si > maxDist. */
function damerauLevenshtein(a: string, b: string, maxDist: number): number {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > maxDist) return Infinity;

  // Tableau dp (taille réduite via ligne courante / précédente)
  const prev2 = new Uint16Array(lb + 1);
  const prev  = new Uint16Array(lb + 1);
  const curr  = new Uint16Array(lb + 1);

  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,        // suppression
        curr[j - 1] + 1,    // insertion
        prev[j - 1] + cost, // substitution
      );
      // Transposition
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        curr[j] = Math.min(curr[j], prev2[j - 2] + cost);
      }
    }
    prev2.set(prev);
    prev.set(curr);
  }

  return curr[lb];
}

/** Seuil de distance autorisé selon la longueur du mot. */
function maxDistFor(len: number): number {
  if (len < 4) return 0;
  if (len < 7) return 1;
  return 2;
}

/**
 * Retourne true si `query` correspond à `text` (correspondance exacte ou
 * approximative). Chaque mot de la requête doit trouver au moins un token
 * correspondant dans le texte (AND implicite).
 */
export function fuzzyMatch(query: string, text: string): boolean {
  const q = normalize(query.trim());
  const t = normalize(text);

  if (!q) return true;

  // Correspondance directe (rapide, toujours prioritaire)
  if (t.includes(q)) return true;

  // Découpe en tokens pour la recherche par mots
  const queryWords = q.split(/\s+/).filter(Boolean);
  const textTokens = t.split(/[\s\-_./,:@]+/).filter(Boolean);

  return queryWords.every((word) => {
    // Correspondance exacte du mot dans un token
    if (textTokens.some((tok) => tok.includes(word))) return true;

    const maxDist = maxDistFor(word.length);
    if (maxDist === 0) return false;

    // Correspondance floue mot vs. chaque token du texte
    return textTokens.some((tok) => {
      // Fenêtre glissante si le token est plus long (ex: "gmaill" dans "gmail")
      if (tok.length >= word.length) {
        for (let s = 0; s <= tok.length - word.length + maxDist; s++) {
          const sub = tok.slice(s, s + word.length + maxDist);
          if (damerauLevenshtein(word, sub, maxDist) <= maxDist) return true;
        }
        return false;
      }
      return damerauLevenshtein(word, tok, maxDist) <= maxDist;
    });
  });
}
