/**
 * Wizard d'onboarding affiché une seule fois après la création d'un nouveau
 * coffre. 3 étapes simples, non bloquantes (l'utilisateur peut fermer à
 * tout moment). L'état est stocké en localStorage (`coffre:onboardingDone`).
 */

const STORAGE_KEY = "coffre:onboardingDone";

export function isOnboardingDone(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "true";
}

export function markOnboardingDone(): void {
  localStorage.setItem(STORAGE_KEY, "true");
}

interface Props {
  onAddFirstEntry: () => void;
  onOpenRecoveryKit: () => void;
  onClose: () => void;
}

const STEPS = [
  {
    icon: "🎉",
    title: "Votre coffre est prêt !",
    body: "Toutes vos entrées sont chiffrées localement, sur votre ordinateur uniquement. Personne d'autre n'y a accès — pas même les développeurs de cette application.",
    cta: "Continuer",
    ctaSecondary: null,
  },
  {
    icon: "➕",
    title: "Ajoutez votre premier mot de passe",
    body: "Cliquez sur « + Ajouter une entrée » pour enregistrer un mot de passe, une note sécurisée ou tout autre information à protéger. Vous pouvez aussi importer depuis Chrome, Firefox ou Bitwarden.",
    cta: "Ajouter une entrée maintenant",
    ctaSecondary: "Plus tard",
  },
  {
    icon: "🔑",
    title: "Conservez votre kit de récupération",
    body: "Si vous oubliez votre mot de passe maître, ce kit est le seul moyen de retrouver l'accès à votre coffre. Imprimez-le ou notez-le dans un endroit sûr (tiroir fermé à clé, coffre-fort…).",
    cta: "Voir mon kit de récupération",
    ctaSecondary: "Je le ferai plus tard",
  },
];

import { useState } from "react";

export function Onboarding({ onAddFirstEntry, onOpenRecoveryKit, onClose }: Props) {
  const [step, setStep] = useState(0);

  const handleCta = () => {
    if (step === 0) { setStep(1); return; }
    if (step === 1) { markOnboardingDone(); onAddFirstEntry(); return; }
    if (step === 2) { markOnboardingDone(); onOpenRecoveryKit(); return; }
  };

  const handleSecondary = () => {
    if (step < STEPS.length - 1) setStep(step + 1);
    else { markOnboardingDone(); onClose(); }
  };

  const s = STEPS[step];

  return (
    /* Overlay */
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-primary/40 backdrop-blur-sm p-4">
      <div className="w-full max-w-md bg-surface rounded-2xl border border-edge shadow-xl p-8 flex flex-col items-center text-center">

        {/* Indicateur d'étapes */}
        <div className="flex gap-2 mb-6">
          {STEPS.map((_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-full transition-all ${
                i === step ? "w-6 bg-brand" : i < step ? "w-3 bg-brand/40" : "w-3 bg-edge"
              }`}
            />
          ))}
        </div>

        <span className="text-5xl mb-5">{s.icon}</span>
        <h2 className="font-display text-2xl font-medium text-primary mb-3">{s.title}</h2>
        <p className="text-muted leading-relaxed mb-8">{s.body}</p>

        <div className="w-full space-y-3">
          <button
            onClick={handleCta}
            className="w-full py-3 rounded-xl bg-brand text-on-brand font-medium hover:bg-brand-hover transition-colors"
          >
            {s.cta}
          </button>
          {s.ctaSecondary ? (
            <button
              onClick={handleSecondary}
              className="w-full py-2 text-sm text-muted hover:text-primary transition-colors"
            >
              {s.ctaSecondary}
            </button>
          ) : null}
        </div>

        {/* Fermeture discrète */}
        <button
          onClick={() => { markOnboardingDone(); onClose(); }}
          className="absolute top-4 right-4 w-7 h-7 flex items-center justify-center rounded-full text-muted hover:text-primary hover:bg-surface-2 transition-colors text-xs"
          title="Fermer"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
