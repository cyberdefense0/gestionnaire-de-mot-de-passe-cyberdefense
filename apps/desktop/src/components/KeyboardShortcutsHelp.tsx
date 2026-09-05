import { useEscapeKey } from "../lib/useEscapeKey";

interface Props {
  onClose: () => void;
}

const GROUPS: { title: string; shortcuts: { keys: string[]; desc: string }[] }[] = [
  {
    title: "Navigation",
    shortcuts: [
      { keys: ["Ctrl", "F"], desc: "Ouvrir la recherche" },
      { keys: ["/"], desc: "Ouvrir la recherche (raccourci)" },
      { keys: ["↑", "↓"], desc: "Naviguer entre les entrées" },
      { keys: ["Entrée"], desc: "Ouvrir la fiche détaillée de l'entrée sélectionnée" },
    ],
  },
  {
    title: "Actions",
    shortcuts: [
      { keys: ["Ctrl", "N"], desc: "Nouvelle entrée (formulaire complet)" },
      { keys: ["Ctrl", "K"], desc: "Ajout rapide ⚡" },
      { keys: ["Ctrl", "C"], desc: "Copier le mot de passe de l'entrée sélectionnée" },
      { keys: ["Ctrl", "⇧", "C"], desc: "Copier l'identifiant de l'entrée sélectionnée" },
    ],
  },
  {
    title: "Sécurité",
    shortcuts: [
      { keys: ["Ctrl", "L"], desc: "Verrouiller le coffre immédiatement" },
      { keys: ["Ctrl", "R"], desc: "Activer / désactiver le mode lecture seule" },
      { keys: ["Échap"], desc: "Fermer la fenêtre / modale ouverte" },
    ],
  },
  {
    title: "Affichage",
    shortcuts: [
      { keys: ["?"], desc: "Afficher cette aide" },
      { keys: ["Ctrl", "⇧", "D"], desc: "Basculer thème clair / sombre" },
    ],
  },
];

export function KeyboardShortcutsHelp({ onClose }: Props) {
  useEscapeKey(onClose);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-primary/40 backdrop-blur-sm p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-lg bg-surface rounded-2xl border border-edge shadow-xl p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="font-display text-xl font-medium text-primary">Raccourcis clavier</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-muted hover:text-primary hover:bg-surface-2 transition-colors"
          >
            ✕
          </button>
        </div>

        <div className="space-y-5">
          {GROUPS.map((group) => (
            <div key={group.title}>
              <h3 className="text-xs uppercase tracking-widest text-muted mb-2">{group.title}</h3>
              <div className="space-y-1.5">
                {group.shortcuts.map((s) => (
                  <div key={s.desc} className="flex items-center gap-3">
                    <div className="flex items-center gap-1 shrink-0">
                      {s.keys.map((k, i) => (
                        <span key={i} className="inline-flex items-center justify-center px-2 py-0.5 rounded-md border border-edge bg-surface-2 text-xs font-mono text-primary min-w-[24px]">
                          {k}
                        </span>
                      ))}
                    </div>
                    <span className="text-sm text-muted">{s.desc}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <p className="text-xs text-muted text-center mt-5">
          Appuyez sur <kbd className="px-1.5 py-0.5 rounded border border-edge bg-surface-2 text-xs font-mono">Échap</kbd> pour fermer
        </p>
      </div>
    </div>
  );
}
