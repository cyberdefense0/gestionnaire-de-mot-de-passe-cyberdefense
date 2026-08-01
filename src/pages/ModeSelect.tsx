interface Props {
  onSelectLocal: () => void;
  onSelectCloud: () => void;
}

export function ModeSelect({ onSelectLocal, onSelectCloud }: Props) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 bg-base text-primary">
      <div className="max-w-2xl w-full text-center mb-12">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-brand/10 border border-brand/30 mb-6">
          <LockIcon />
        </div>
        <h1 className="font-display text-4xl font-medium tracking-tight mb-3">Coffre</h1>
        <p className="text-muted text-base">
          Choisissez comment protéger vos mots de passe. Ce choix est définitif pour ce coffre.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 w-full max-w-2xl">
        <ModeCard
          eyebrow="Hors ligne"
          title="Local"
          description="Aucun compte. Un fichier .vault chiffré, stocké uniquement sur cet ordinateur. Vous seul le déplacez et le sauvegardez."
          bullets={["Aucune connexion requise", "Un master password suffit", "Portable (clé USB, etc.)"]}
          onClick={onSelectLocal}
        />
        <ModeCard
          eyebrow="Synchronisé"
          title="Cloud"
          description="Un compte pour vous authentifier, puis un master password distinct pour chiffrer vos données. Synchronisation automatique."
          bullets={["Accessible depuis le web", "Sauvegarde automatique", "Multi-appareils"]}
          onClick={onSelectCloud}
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
  title,
  description,
  bullets,
  onClick,
}: {
  eyebrow: string;
  title: string;
  description: string;
  bullets: string[];
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="group text-left p-6 rounded-2xl border border-edge bg-surface hover:border-brand/50 hover:bg-surface-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <span className="text-xs uppercase tracking-widest text-accent font-medium">{eyebrow}</span>
      <h2 className="font-display text-2xl font-medium mt-2 mb-2 text-primary">{title}</h2>
      <p className="text-sm text-muted leading-relaxed mb-4">{description}</p>
      <ul className="space-y-1.5">
        {bullets.map((b) => (
          <li key={b} className="text-xs text-muted flex items-center gap-2">
            <span className="w-1 h-1 rounded-full bg-brand" />
            {b}
          </li>
        ))}
      </ul>
      <span className="mt-5 inline-flex items-center text-sm text-accent group-hover:text-accent-strong transition-colors">
        Choisir {title} →
      </span>
    </button>
  );
}

function LockIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="text-accent">
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
