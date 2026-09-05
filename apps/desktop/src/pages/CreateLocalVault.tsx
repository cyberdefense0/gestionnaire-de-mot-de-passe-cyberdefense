import { useState } from "react";
import { vaultApi } from "../lib/tauri";
import { RecoveryKitModal } from "../components/RecoveryKitModal";
import { PasswordStrengthMeter } from "../components/PasswordStrengthMeter";
import { usePasswordStrength } from "../lib/passwordStrength";
import type { VaultSnapshot } from "../lib/tauri";

interface Props {
  onBack: () => void;
  onVaultReady: (path: string, snapshot: VaultSnapshot) => void;
  onRecoveryCode?: (code: string) => void;
  /** Mobile uniquement : chemin déjà résolu (répertoire privé de l'app,
   * voir lib/mobileVault.ts) — pas de sélecteur de fichier à afficher. */
  fixedPath?: string | null;
}

export function CreateLocalVault({ onBack, onVaultReady, onRecoveryCode, fixedPath }: Props) {
  const [path, setPath] = useState<string | null>(fixedPath ?? null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingRecovery, setPendingRecovery] = useState<{ code: string; snapshot: VaultSnapshot } | null>(null);

  const choosePath = async () => {
    const chosen = await vaultApi.pickNewVaultPath();
    if (chosen) setPath(chosen);
  };

  // Le calcul zxcvbn tourne dans un Web Worker (voir lib/passwordStrength.ts) ;
  // `result` peut être `null` très brièvement pendant le debounce initial,
  // auquel cas on bloque prudemment la soumission plutôt que de l'autoriser
  // sur un résultat pas encore connu.
  const { result: strengthResult } = usePasswordStrength(password);
  const strengthOk = password.length >= 10 && strengthResult !== null && strengthResult.label !== "faible";

  const submit = async () => {
    setError(null);
    if (!path) return setError("Choisissez d'abord où enregistrer votre fichier .vault.");
    if (!strengthOk) return setError("Le master password doit contenir au moins 10 caractères et ne pas être trop simple (variez majuscules, chiffres, symboles).");
    if (password !== confirm) return setError("Les deux mots de passe ne correspondent pas.");

    setLoading(true);
    try {
      const result = await vaultApi.createLocalVault(path, password);
      onRecoveryCode?.(result.recoveryCode);
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
    <div className="min-h-screen flex items-center justify-center px-4 sm:px-6 py-8 bg-base text-primary">
      <div className="max-w-md w-full">
        <button onClick={onBack} className="text-sm text-muted hover:text-accent-strong mb-6 flex items-center gap-1">
          ← Revenir au choix du mode
        </button>
        <h1 className="font-display text-2xl sm:text-3xl font-medium mb-2">Créer votre coffre</h1>
        <p className="text-muted mb-8 leading-relaxed">
          Vos mots de passe seront enfermés dans un fichier protégé sur votre ordinateur, accessible uniquement avec votre mot de passe maître.
        </p>

        <div className="space-y-6">
          {fixedPath ? (
            <div className="flex items-start gap-3 p-4 rounded-xl border border-edge bg-surface-2 text-sm text-muted">
              <span className="text-lg shrink-0">🔒</span>
              <p>Votre coffre sera stocké de façon sécurisée dans l'espace privé de l'application sur cet appareil.</p>
            </div>
          ) : (
            <div>
              <label className="text-sm font-medium text-primary mb-1.5 block">
                📁 Où sauvegarder votre coffre ?
              </label>
              <p className="text-xs text-muted mb-2">Choisissez un emplacement facile à retrouver (ex : Bureau, Documents).</p>
              <button
                onClick={choosePath}
                className={`w-full text-left px-4 py-3 rounded-xl border transition-colors text-sm ${
                  path ? "border-brand/40 bg-brand/5 text-primary" : "border-edge bg-surface text-muted hover:border-brand/50"
                }`}
              >
                {path ? `✓ ${path}` : "Cliquer pour choisir l'emplacement…"}
              </button>
            </div>
          )}

          <div>
            <label className="text-sm font-medium text-primary mb-1.5 block">
              🔑 Choisissez votre mot de passe maître
            </label>
            <p className="text-xs text-muted mb-2">
              C'est le seul mot de passe dont vous aurez besoin pour ouvrir votre coffre. Choisissez-en un que vous pouvez retenir, mais difficile à deviner pour les autres.
            </p>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-3 rounded-xl border border-edge bg-surface text-sm outline-none focus:border-brand/50"
              placeholder="Au moins 10 caractères (lettres, chiffres, symboles)"
              autoComplete="new-password"
              autoFocus
            />
            <PasswordStrengthMeter password={password} />
          </div>

          <div>
            <label className="text-sm font-medium text-primary mb-1.5 block">
              🔁 Retapez votre mot de passe maître
            </label>
            <p className="text-xs text-muted mb-2">Pour éviter toute erreur de frappe.</p>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              className={`w-full px-4 py-3 rounded-xl border bg-surface text-sm outline-none transition-colors ${
                confirm && confirm !== password
                  ? "border-signal-red/50 focus:border-signal-red"
                  : "border-edge focus:border-brand/50"
              }`}
              autoComplete="new-password"
              placeholder="Retapez le même mot de passe"
            />
            {confirm && confirm !== password && (
              <p className="text-xs text-signal-red mt-1.5 flex items-center gap-1">
                <span>⚠</span> Les deux mots de passe ne sont pas identiques.
              </p>
            )}
            {confirm && confirm === password && password.length >= 10 && (
              <p className="text-xs text-signal-green mt-1.5 flex items-center gap-1">
                <span>✓</span> Parfait, les deux correspondent.
              </p>
            )}
          </div>

          {error && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-signal-red/10 border border-signal-red/30 text-sm text-signal-red">
              <span className="shrink-0 mt-0.5">⚠</span>
              <span>{error}</span>
            </div>
          )}

          <button
            onClick={submit}
            disabled={loading}
            className="w-full py-3.5 rounded-xl bg-brand text-on-brand font-medium text-base hover:bg-brand-hover transition-colors disabled:opacity-50"
          >
            {loading ? "⏳ Création en cours…" : "Créer mon coffre →"}
          </button>

          <div className="flex items-start gap-3 p-4 rounded-xl border border-signal-amber/30 bg-signal-amber/5 text-sm">
            <span className="text-lg shrink-0">⚠️</span>
            <p className="text-muted leading-relaxed">
              <strong className="text-primary">Important :</strong> ce mot de passe n'est stocké nulle part sur internet.
              Si vous l'oubliez, vous ne pourrez plus ouvrir votre coffre — sauf si vous conservez votre <strong className="text-primary">kit de récupération</strong> (généré à l'étape suivante).
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
