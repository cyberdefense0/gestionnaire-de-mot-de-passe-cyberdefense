/**
 * Vérification "mot de passe compromis" via l'API Have I Been Pwned, en
 * k-anonymat : on calcule le SHA-1 du mot de passe LOCALEMENT, et on
 * n'envoie que les 5 premiers caractères hexadécimaux du hash au serveur.
 * Le serveur répond avec tous les suffixes connus partageant ce préfixe
 * (des centaines), et on compare localement — le mot de passe ni son hash
 * complet ne quittent jamais la machine. Voir https://haveibeenpwned.com/API/v3#PwnedPasswords
 */

async function sha1Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-1", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/** Retourne le nombre de fois où ce mot de passe est apparu dans des fuites connues (0 = non trouvé). */
export async function checkPasswordPwned(password: string): Promise<number> {
  if (!password) return 0;
  const hash = await sha1Hex(password);
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);

  const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
    headers: { "Add-Padding": "true" },
  });
  if (!res.ok) throw new Error("Service Have I Been Pwned indisponible.");
  const text = await res.text();

  for (const line of text.split("\n")) {
    const [lineSuffix, count] = line.trim().split(":");
    if (lineSuffix === suffix) return parseInt(count, 10) || 0;
  }
  return 0;
}
