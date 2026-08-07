interface Props {
  onBack: () => void;
}

/**
 * Le mode Cloud nécessite un projet Firebase (Auth + Firestore) propre au
 * déploiement — voir DEV_NOTES.md, section "Activer le mode Cloud".
 * Cet écran reste volontairement un stub tant que la config n'est pas fournie,
 * pour ne pas donner l'illusion d'une synchronisation qui n'existe pas encore.
 */
export function CloudComingSoon({ onBack }: Props) {
  return (
    <div className="min-h-screen flex items-center justify-center px-6 bg-base text-primary text-center">
      <div className="max-w-md">
        <button onClick={onBack} className="text-sm text-muted hover:text-accent-strong mb-8 block mx-auto">
          ← Changer de mode
        </button>
        <h1 className="font-display text-2xl font-medium mb-3">Mode Cloud</h1>
        <p className="text-sm text-muted leading-relaxed">
          Le mode Cloud (compte + synchronisation Firestore) est scaffoldé côté code mais nécessite
          une configuration Firebase (clé de projet) avant de fonctionner. Voir{" "}
          <code className="text-accent">DEV_NOTES.md</code> pour l'activer.
        </p>
      </div>
    </div>
  );
}
