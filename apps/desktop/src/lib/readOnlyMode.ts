/**
 * Mode "Lecture seule" : empêche toute modification du coffre (ajout,
 * édition, suppression) jusqu'à désactivation explicite.
 *
 * Utile pour consulter le coffre sur un poste partagé ou passer son
 * écran sans risquer une modification accidentelle.
 *
 * Stocké en sessionStorage (réinitialisé à chaque ouverture de l'app),
 * pas en localStorage — le mode lecture seule est une protection ponctuelle
 * de session, pas une préférence persistante.
 *
 * Le mode est indépendant du verrouillage : il n'empêche pas de copier les
 * mots de passe, seulement d'écrire dans le vault.
 */

const KEY = "coffre:readOnly";

export function isReadOnly(): boolean {
  return sessionStorage.getItem(KEY) === "true";
}

export function setReadOnly(enabled: boolean): void {
  if (enabled) sessionStorage.setItem(KEY, "true");
  else sessionStorage.removeItem(KEY);
}
