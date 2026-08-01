import { useState } from "react";
import { vaultApi } from "../lib/tauri";
import { RecoveryKitModal } from "../components/RecoveryKitModal";
import { PasswordStrengthMeter } from "../components/PasswordStrengthMeter";
import { estimateStrengthLabel } from "../lib/passwordStrength";
import type { VaultSnapshot } from "../lib/tauri";

interface Props {
  onBack: () => void;
  onVaultReady: (path: string, snapshot: VaultSnapshot) => void;
}

export function CreateLocalVault({ onBack, onVaultReady }: Props) {
  const [path, setPath] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingRecovery, setPendingRecovery] = useState<{ code: string; snapshot: VaultSnapshot } | null>(null);

  const choosePath = async () => {
    const chosen = await vaultApi.pickNewVaultPath();
    if (chosen) setPath(chosen);
  };

  const strengthOk = password.length >= 10 && estimateStrengthLabel(password) !== "faible";

  const submit = async () => {
    setError(null);
    if (!path) return setError("Choisissez d'abord où enregistrer votre fichier .vault.");
    if (!strengthOk) return setError("Le master password doit contenir au moins 10 caractères et ne pas être trop simple (variez majuscules, chiffres, symboles).");
    if (password !== confirm) return setError("Les deux mots de passe ne correspondent pas.");

    setLoading(true);
    try {
      const result = await vaultApi.createLocalVault(path, password);
      setPendingRecovery({
        code: result.recoveryCode,
        snapshot: { items: result.items, categories: result.categories, recoveryKitConfirmedAt: result.recoveryKitConfirmedAt },
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  if (pendingRecovery) {
    return (
      <RecoveryKitModal recoveryCode={pendingRecovery.code} onConfirm={(snapshot) => onVaultReady(path!, snapshot)} />
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6 bg-base text-primary">
      <div className="max-w-md w-full">
        <button onClick={onBack} className="text-sm text-muted hover:text-accent-strong mb-6">
          ← Changer de mode
        </button>
        <h1 className="font-display text-3xl font-medium mb-2">Nouveau coffre local</h1>
        <p className="text-sm text-muted mb-8">
          Pas d'email, pas de compte. Juste un fichier chiffré et un mot de passe que vous seul connaissez.
        </p>

        <div className="space-y-5">
          <div>
            <label className="text-xs uppercase tracking-wider text-muted mb-2 block">Fichier du coffre</label>
            <button
              onClick={choosePath}
              className="w-full text-left px-4 py-3 rounded-xl border border-edge bg-surface text-sm hover:border-brand/50 transition-colors"
            >
              {path ?? "Choisir l'emplacement du fichier .vault…"}
            </button>
          </div>

          <div>
            <label className="text-xs uppercase tracking-wider text-muted mb-2 block">Master password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-3 rounded-xl border border-edge bg-surface text-sm outline-none focus:border-brand/50"
              placeholder="Au moins 10 caractères"
              autoComplete="new-password"
            />
            <PasswordStrengthMeter password={password} />
          </div>

          <div>
            <label className="text-xs uppercase tracking-wider text-muted mb-2 block">Confirmer</label>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="w-full px-4 py-3 rounded-xl border border-edge bg-surface text-sm outline-none focus:border-brand/50"
              autoComplete="new-password"
            />
          </div>

          {error && <p className="text-sm text-signal-red">{error}</p>}

          <button
            onClick={submit}
            disabled={loading}
            className="w-full py-3 rounded-xl bg-brand text-on-brand font-medium hover:bg-brand-hover transition-colors disabled:opacity-50"
          >
            {loading ? "Création…" : "Créer mon coffre"}
          </button>

          <p className="text-xs text-muted leading-relaxed">
            ⚠️ Ce mot de passe n'est jamais stocké nulle part. S'il est perdu, seul votre kit de
            récupération (généré à l'étape suivante) permettra d'accéder à nouveau à vos données.
          </p>
        </div>
      </div>
    </div>
  );
}
