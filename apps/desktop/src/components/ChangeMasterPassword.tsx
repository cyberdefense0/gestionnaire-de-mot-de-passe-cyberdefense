import { useState, type ReactNode } from "react";
import { vaultApi } from "../lib/tauri";
import { useEscapeKey } from "../lib/useEscapeKey";

interface Props {
  onClose: () => void;
}

export function ChangeMasterPassword({ onClose }: Props) {
  useEscapeKey(onClose);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async () => {
    setError(null);
    if (next.length < 10) return setError("Le nouveau master password doit contenir au moins 10 caractères.");
    if (next !== confirm) return setError("Les deux mots de passe ne correspondent pas.");

    setLoading(true);
    try {
      const valid = await vaultApi.verifyMasterPassword(current);
      if (!valid) {
        setError("Master password actuel incorrect.");
        return;
      }
      await vaultApi.changeMasterPassword(next);
      setDone(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-base/90 backdrop-blur-sm flex items-center justify-center px-6 z-40">
      <div className="max-w-md w-full bg-surface border border-edge rounded-2xl p-7">
        <h2 className="font-display text-2xl font-medium mb-2 text-primary">Changer le master password</h2>

        {done ? (
          <>
            <p className="text-sm text-muted mb-6">
              Master password mis à jour. Votre kit de récupération existant reste valide — il
              n'a pas besoin d'être régénéré.
            </p>
            <button onClick={onClose} className="w-full py-2.5 rounded-xl bg-brand text-on-brand text-sm font-medium hover:bg-brand-hover transition-colors">
              Fermer
            </button>
          </>
        ) : (
          <>
            <p className="text-sm text-muted mb-6">
              Le kit de récupération que vous avez sauvegardé continuera de fonctionner après ce changement.
            </p>
            <div className="space-y-4">
              <Field label="Master password actuel">
                <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} className="input" autoFocus />
              </Field>
              <Field label="Nouveau master password">
                <input type="password" value={next} onChange={(e) => setNext(e.target.value)} className="input" />
              </Field>
              <Field label="Confirmer">
                <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="input" />
              </Field>
              {error && <p className="text-sm text-signal-red">{error}</p>}
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-edge text-sm text-muted hover:text-primary transition-colors">
                Annuler
              </button>
              <button
                onClick={submit}
                disabled={loading}
                className="flex-1 py-2.5 rounded-xl bg-brand text-on-brand text-sm font-medium hover:bg-brand-hover transition-colors disabled:opacity-50"
              >
                {loading ? "…" : "Changer"}
              </button>
            </div>
          </>
        )}
      </div>
      <style>{`
        .input { width: 100%; padding: 0.65rem 1rem; border-radius: 0.75rem; border: 1px solid rgb(var(--color-edge)); background: rgb(var(--color-base)); color: rgb(var(--color-primary)); font-size: 0.875rem; outline: none; }
        .input:focus { border-color: rgb(var(--color-brand) / 0.5); }
      `}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className="text-xs uppercase tracking-wider text-muted mb-1.5 block">{label}</label>
      {children}
    </div>
  );
}
