import type React from "react";
import logoLight from "../assets/branding/logo-light.png";
import logoDark from "../assets/branding/logo-dark.png";

interface Props {
  onSelectLocal: () => void;
  onSelectCloud: () => void;
}

export function ModeSelect({ onSelectLocal, onSelectCloud }: Props) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 sm:px-6 bg-base text-primary">
      <div className="max-w-2xl w-full text-center mb-12">
        <img
          src={logoLight}
          alt="Coffre"
          className="w-20 h-20 mx-auto mb-6 rounded-2xl shadow-lg shadow-brand/10 dark:hidden"
        />
        <img
          src={logoDark}
          alt="Coffre"
          className="w-20 h-20 mx-auto mb-6 rounded-2xl shadow-lg shadow-black/30 hidden dark:block"
        />
        <h1 className="font-display text-3xl sm:text-4xl font-medium tracking-tight mb-3">Coffre</h1>
        <p className="text-muted text-sm sm:text-base">
          Choisissez comment protéger vos mots de passe. Ce choix est définitif pour ce coffre.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 w-full max-w-2xl">
        <ModeCard
          eyebrow="Hors ligne"
          icon={<HardDriveIcon />}
          title="Local"
          description="Aucun compte. Un fichier .vault chiffré, stocké uniquement sur cet ordinateur. Vous seul le déplacez et le sauvegardez."
          bullets={["Aucune connexion requise", "Un master password suffit", "Portable (clé USB, etc.)"]}
          onClick={onSelectLocal}
        />
        <ModeCard
          eyebrow="Synchronisé"
          icon={<CloudIcon />}
          title="Cloud"
          description="Un compte pour vous authentifier, puis un master password distinct pour chiffrer vos données. Synchronisation automatique."
          bullets={["Accessible depuis le web", "Sauvegarde automatique", "Multi-appareils"]}
          onClick={onSelectCloud}
          comingSoon
        />
      </div>

      <p className="text-xs text-muted mt-10 max-w-md text-center">
        La bascule entre les deux modes n'est pas disponible dans cette version.
      </p>
    </div>
  );
}

function ModeCard({
  eyebrow,
  icon,
  title,
  description,
  bullets,
  onClick,
  comingSoon,
}: {
  eyebrow: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  bullets: string[];
  onClick: () => void;
  comingSoon?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`group relative text-left p-6 rounded-2xl border bg-surface transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        comingSoon
          ? "border-edge opacity-70 hover:opacity-90 hover:border-edge-strong"
          : "border-edge hover:border-brand/50 hover:bg-surface-2"
      }`}
    >
      {comingSoon && (
        <span className="absolute top-4 right-4 text-[10px] uppercase tracking-widest px-2 py-0.5 rounded-full bg-surface-2 text-muted border border-edge">
          Bientôt
        </span>
      )}
      <span className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-brand/10 text-accent mb-4">
        {icon}
      </span>
      <span className="text-xs uppercase tracking-widest text-accent font-medium block">{eyebrow}</span>
      <h2 className="font-display text-2xl font-medium mt-1.5 mb-2 text-primary">{title}</h2>
      <p className="text-sm text-muted leading-relaxed mb-4">{description}</p>
      <ul className="space-y-1.5">
        {bullets.map((b) => (
          <li key={b} className="text-xs text-muted flex items-center gap-2">
            <span className="w-1 h-1 rounded-full bg-brand shrink-0" />
            {b}
          </li>
        ))}
      </ul>
      {!comingSoon && (
        <span className="mt-5 inline-flex items-center text-sm text-accent group-hover:text-accent-strong transition-colors">
          Choisir {title} →
        </span>
      )}
      {comingSoon && (
        <span className="mt-5 inline-flex items-center text-sm text-muted">
          En cours de développement
        </span>
      )}
    </button>
  );
}

function HardDriveIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14a9 3 0 0 0 18 0V5" />
      <circle cx="12" cy="19" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function CloudIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10Z" />
    </svg>
  );
}
