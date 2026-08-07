import { usePasswordStrength } from "../lib/passwordStrength";
import type { StrengthLabel } from "../lib/passwordStrength";

const LEVELS: StrengthLabel[] = ["faible", "moyen", "fort", "excellent"];

/**
 * Jauge visuelle de force de mot de passe, basée sur zxcvbn-ts (simulation
 * d'attaque réelle : dictionnaires, motifs de clavier, dates, l33t-speak),
 * la même approche que la plupart des gestionnaires du marché. Affiche
 * aussi le temps de crack estimé, comme un testeur de mot de passe
 * classique (ex: "Durée estimée de la fissuration : des siècles").
 *
 * Le calcul tourne dans un Web Worker dédié (`passwordStrength.worker.ts`),
 * jamais sur le thread principal — voir roadmap README §2.1.
 */
export function PasswordStrengthMeter({ password }: { password: string }) {
  const { result, pending } = usePasswordStrength(password);
  if (!password || !result) return null;
  const level = LEVELS.indexOf(result.label); // 0..3

  return (
    <div className="mt-2">
      <div className="flex gap-1">
        {LEVELS.map((_, i) => (
          <div
            key={i}
            className={`h-1.5 flex-1 rounded-full transition-colors ${
              i <= level ? barColor(result.label) : "bg-edge"
            } ${pending ? "opacity-60" : ""}`}
          />
        ))}
      </div>
      <p className={`text-xs mt-1.5 ${textColor(result.label)}`}>
        Force : {result.label} — Durée estimée de la fissuration : {result.crackTimeDisplay}
      </p>
      {result.warning && <p className="text-xs mt-1 text-signal-amber">{result.warning}</p>}
      {result.label === "faible" && result.suggestions.length > 0 && (
        <p className="text-xs mt-1 text-muted">{result.suggestions[0]}</p>
      )}
    </div>
  );
}

function barColor(s: StrengthLabel) {
  switch (s) {
    case "faible":
      return "bg-signal-red";
    case "moyen":
      return "bg-signal-amber";
    default:
      return "bg-signal-green";
  }
}

function textColor(s: StrengthLabel) {
  switch (s) {
    case "faible":
      return "text-signal-red";
    case "moyen":
      return "text-signal-amber";
    default:
      return "text-signal-green";
  }
}
