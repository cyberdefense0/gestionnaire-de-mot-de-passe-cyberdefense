import { useState } from "react";
import { vaultApi } from "../lib/tauri";
import type { VaultSnapshot } from "../lib/tauri";

interface Props {
  onBack: () => void;
  onUnlocked: (path: string, snapshot: VaultSnapshot) => void;
}

export function UnlockVault({ onBack, onUnlocked }: Props) {
  const [path, setPath] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const choosePath = async () => {
    const chosen = await vaultApi.pickExistingVaultPath();
    if (chosen) setPath(chosen);
  };

  const submit = async () => {
    setError(null);
    if (!path) return setError("Sélectionnez d'abord votre fichier .vault.");
    setLoading(true);
    try {
      const result = recoveryMode
        ? await vaultApi.unlockLocalVaultWithRecovery(path, recoveryCode.trim())
        : await vaultApi.unlockLocalVault(path, password);
      onUnlocked(path, result);
    } catch (err) {
      // Le message vient directement de Rust (voir unlock_local_vault côté
      // src-tauri) : il distingue déjà "mot de passe incorrect" d'un
      // blocage temporaire ("Trop de tentatives échouées...") avec le
      // délai restant précis, donc on l'affiche tel quel plutôt que de le
      // remplacer par un message générique.
      setError(typeof err === "string" ? err : recoveryMode ? "Kit de récupération invalide." : "Master password incorrect.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-6 bg-base text-primary">
      <div className="max-w-md w-full">
        <button onClick={onBack} className="text-sm text-muted hover:text-accent-strong mb-6">
          ← Changer de mode
        </button>
        <h1 className="font-display text-3xl font-medium mb-2">Déverrouiller mon coffre</h1>
        <p className="text-sm text-muted mb-8">Sélectionnez votre fichier .vault puis entrez votre master password.</p>

        <div className="space-y-5">
          <div>
            <label className="text-xs uppercase tracking-wider text-muted mb-2 block">Fichier du coffre</label>
            <button
              onClick={choosePath}
              className="w-full text-left px-4 py-3 rounded-xl border border-edge bg-surface text-sm hover:border-brand/50 transition-colors"
            >
              {path ?? "Sélectionner un fichier .vault…"}
            </button>
          </div>

          {!recoveryMode ? (
            <div>
              <label className="text-xs uppercase tracking-wider text-muted mb-2 block">Master password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                className="w-full px-4 py-3 rounded-xl border border-edge bg-surface text-sm outline-none focus:border-brand/50"
                autoComplete="current-password"
                autoFocus
              />
            </div>
          ) : (
            <div>
              <label className="text-xs uppercase tracking-wider text-muted mb-2 block">Kit de récupération</label>
              <input
                type="text"
                value={recoveryCode}
                onChange={(e) => setRecoveryCode(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
                className="w-full px-4 py-3 rounded-xl border border-edge bg-surface text-sm font-mono outline-none focus:border-brand/50"
              />
            </div>
          )}

          {error && <p className="text-sm text-signal-red">{error}</p>}

          <button
            onClick={submit}
            disabled={loading}
            className="w-full py-3 rounded-xl bg-brand text-on-brand font-medium hover:bg-brand-hover transition-colors disabled:opacity-50"
          >
            {loading ? "Vérification…" : "Déverrouiller"}
          </button>

          <button
            onClick={() => {
              setRecoveryMode(!recoveryMode);
              setError(null);
            }}
            className="w-full text-xs text-muted hover:text-accent-strong transition-colors"
          >
            {recoveryMode ? "Utiliser mon master password à la place" : "Master password oublié ? Utiliser le kit de récupération"}
          </button>
        </div>
      </div>
    </div>
  );
}
