/**
 * Palette de saisie rapide — ouverte par Ctrl/Cmd+K.
 * Formulaire minimal : titre + mot de passe uniquement.
 * Génère un mot de passe fort automatiquement, l'utilisateur peut le changer.
 * Enregistre via `add_item` existant avec les valeurs par défaut.
 */
import { useState, useEffect, useRef } from "react";
import { generatePassword } from "../lib/passwordGenerator";
import { DEFAULT_GENERATOR_OPTIONS } from "../types";
import { useEscapeKey } from "../lib/useEscapeKey";

interface Props {
  categories: string[];
  onSave: (title: string, password: string, category: string, username: string, url: string) => Promise<void>;
  onClose: () => void;
}

export function QuickAdd({ categories, onSave, onClose }: Props) {
  const [title, setTitle] = useState("");
  const [username, setUsername] = useState("");
  const [url, setUrl] = useState("");
  const [password, setPassword] = useState(() =>
    generatePassword({ ...DEFAULT_GENERATOR_OPTIONS, length: 20 })
  );
  const [category, setCategory] = useState(categories[0] ?? "Général");
  const [revealed, setRevealed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEscapeKey(onClose);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  // Pré-remplir URL depuis le presse-papiers
  useEffect(() => {
    navigator.clipboard.readText().then((text) => {
      if (/^https?:\/\//i.test(text.trim())) setUrl(text.trim());
    }).catch(() => {});
  }, []);

  const regenerate = () =>
    setPassword(generatePassword({ ...DEFAULT_GENERATOR_OPTIONS, length: 20 }));

  const submit = async () => {
    if (!title.trim()) { setError("Le titre est obligatoire."); return; }
    setSaving(true);
    try {
      await onSave(title.trim(), password, category, username.trim(), url.trim());
      onClose();
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  };

  return (
    /* Overlay */
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-primary/40 backdrop-blur-sm pt-[15vh] px-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-lg bg-surface rounded-2xl border border-edge shadow-xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-edge bg-base">
          <span className="text-muted text-sm">⚡</span>
          <span className="text-sm font-medium text-primary">Ajout rapide</span>
          <span className="ml-auto text-xs text-muted">Échap pour fermer</span>
        </div>

        <div className="p-4 space-y-3">
          {/* Titre */}
          <input
            ref={titleRef}
            value={title}
            onChange={(e) => { setTitle(e.target.value); setError(null); }}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Titre · ex: Gmail"
            className={`w-full px-3 py-2.5 rounded-xl border bg-surface text-sm outline-none transition-colors ${
              error ? "border-signal-red/50 focus:border-signal-red" : "border-edge focus:border-brand/50"
            }`}
          />

          {/* Identifiant (optionnel) */}
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Identifiant / email (optionnel)"
            className="w-full px-3 py-2.5 rounded-xl border border-edge bg-surface text-sm outline-none focus:border-brand/50"
          />

          {/* URL (optionnel) */}
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Adresse du site (optionnel)"
            className="w-full px-3 py-2.5 rounded-xl border border-edge bg-surface text-sm outline-none focus:border-brand/50"
          />

          {/* Mot de passe + régénérer */}
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                type={revealed ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2.5 pr-16 rounded-xl border border-edge bg-surface text-sm font-mono outline-none focus:border-brand/50"
              />
              <button
                onClick={() => setRevealed((r) => !r)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted hover:text-primary"
              >
                {revealed ? "Masquer" : "Voir"}
              </button>
            </div>
            <button
              onClick={regenerate}
              title="Générer un nouveau mot de passe fort"
              className="shrink-0 px-3 py-2.5 rounded-xl border border-edge text-muted hover:text-accent hover:border-brand/40 transition-colors text-base"
            >
              🔄
            </button>
          </div>

          {/* Catégorie */}
          {categories.length > 1 && (
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border border-edge bg-surface text-sm outline-none focus:border-brand/50 text-primary"
            >
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}

          {error && <p className="text-xs text-signal-red flex items-center gap-1"><span>⚠</span>{error}</p>}

          {/* Actions */}
          <div className="flex gap-2 pt-1">
            <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-edge text-sm text-muted hover:text-primary transition-colors">
              Annuler
            </button>
            <button
              onClick={submit}
              disabled={saving || !title.trim()}
              className="flex-1 py-2.5 rounded-xl bg-brand text-on-brand text-sm font-medium hover:bg-brand-hover transition-colors disabled:opacity-40"
            >
              {saving ? "Enregistrement…" : "⚡ Ajouter au coffre"}
            </button>
          </div>

          <p className="text-[10px] text-muted text-center">
            Pour plus d'options (tags, expiration, pièces jointes…), utilisez le formulaire complet via + Ajouter.
          </p>
        </div>
      </div>
    </div>
  );
}
