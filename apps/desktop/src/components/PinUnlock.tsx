import { useState, useEffect } from "react";
import { checkPin, pinAttemptsLeft, getStoredMasterPassword } from "../lib/pinEntry";
import {
  isBiometryEnabled,
  enableBiometry,
  disableBiometry,
  syncBiometryState,
} from "../lib/biometry";

interface Props {
  vaultPath: string;
  onUnlockedWithMp: (masterPassword: string) => Promise<void>;
  onSwitchToMasterPassword: () => void;
}

const PAD = ["1","2","3","4","5","6","7","8","9","","0","⌫"];

export function PinUnlock({ onUnlockedWithMp, onSwitchToMasterPassword }: Props) {
  const [digits, setDigits] = useState<string[]>([]);
  const [status, setStatus] = useState<"idle" | "checking" | "error" | "blocked">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const maxLen = 6;

  const push = (d: string) => {
    if (status === "checking" || status === "blocked") return;
    setStatus("idle");
    setErrorMsg("");
    if (d === "⌫") {
      setDigits((prev) => prev.slice(0, -1));
    } else if (digits.length < maxLen) {
      setDigits((prev) => [...prev, d]);
    }
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key >= "0" && e.key <= "9") push(e.key);
      if (e.key === "Backspace") push("⌫");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  useEffect(() => {
    if (digits.length === maxLen) submit(digits.join(""));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [digits]);

  const submit = async (pin: string) => {
    if (pin.length < 4) return;
    setStatus("checking");
    const result = await checkPin(pin);
    if (result === "ok") {
      const mp = getStoredMasterPassword();
      if (!mp) {
        setStatus("error");
        setErrorMsg("Session expirée. Veuillez ressaisir votre master password.");
        return;
      }
      await onUnlockedWithMp(mp);
    } else if (result === "blocked") {
      setStatus("blocked");
      setErrorMsg("PIN bloqué après trop d'essais. Utilisez votre master password pour continuer.");
    } else {
      const left = pinAttemptsLeft();
      setStatus("error");
      setErrorMsg(`PIN incorrect. ${left !== null ? `${left} essai${left > 1 ? "s" : ""} restant${left > 1 ? "s" : ""}.` : ""}`);
      setDigits([]);
    }
  };

  return (
    <div className="flex flex-col items-center gap-6 py-4">
      <p className="text-sm text-muted text-center">Entrez votre PIN pour ouvrir le coffre.</p>

      <div className="flex gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <span
            key={i}
            className={`w-3.5 h-3.5 rounded-full border-2 transition-all ${
              digits.length > i ? "bg-brand border-brand" : "border-edge-strong bg-transparent"
            }`}
          />
        ))}
      </div>

      {status === "error" && (
        <p className="text-sm text-signal-red text-center px-4">{errorMsg}</p>
      )}
      {status === "blocked" && (
        <div className="px-4 py-3 rounded-xl bg-signal-red/10 border border-signal-red/30 text-sm text-signal-red text-center">
          {errorMsg}
        </div>
      )}
      {status === "checking" && (
        <p className="text-sm text-muted">Vérification…</p>
      )}

      {status !== "blocked" && (
        <div className="grid grid-cols-3 gap-3">
          {PAD.map((k, i) => (
            k === "" ? (
              <span key={i} />
            ) : (
              <button
                key={k + i}
                onClick={() => push(k)}
                disabled={status === "checking"}
                className={`w-16 h-16 rounded-2xl border text-xl font-medium transition-colors ${
                  k === "⌫"
                    ? "border-edge text-muted hover:text-signal-red hover:border-signal-red/40 text-base"
                    : "border-edge bg-surface hover:bg-surface-2 hover:border-brand/50 text-primary"
                } disabled:opacity-40`}
              >
                {k}
              </button>
            )
          ))}
        </div>
      )}

      <button
        onClick={onSwitchToMasterPassword}
        className="text-xs text-muted hover:text-accent underline underline-offset-2 decoration-muted/40 hover:decoration-accent transition-colors"
      >
        Utiliser mon master password à la place →
      </button>
    </div>
  );
}

// ── Paramètres PIN ─────────────────────────────────────────────────────────

export function PinSettings({
  onVerifyMasterPassword,
}: {
  onVerifyMasterPassword: (mp: string) => Promise<boolean>;
}) {
  const [enabled, setEnabled] = useState(() => !!(localStorage.getItem("coffre:pin:hash")));
  const [step, setStep] = useState<"idle" | "enter-mp" | "enter-pin" | "confirm-pin">("idle");
  const [mp, setMp] = useState("");
  const [pin1, setPin1] = useState("");
  const [pin2, setPin2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const startEnable = () => { setStep("enter-mp"); setMp(""); setPin1(""); setPin2(""); setError(null); };
  const cancelFlow = () => { setStep("idle"); setMp(""); setPin1(""); setPin2(""); setError(null); };

  const confirmMp = async () => {
    if (!mp) return;
    setLoading(true);
    const ok = await onVerifyMasterPassword(mp);
    setLoading(false);
    if (!ok) { setError("Master password incorrect."); return; }
    setError(null);
    setStep("enter-pin");
  };

  const confirmPin = async () => {
    if (!/^\d{4,6}$/.test(pin1)) { setError("Le PIN doit contenir 4 à 6 chiffres."); return; }
    setStep("confirm-pin");
  };

  const finalizePin = async () => {
    if (pin1 !== pin2) { setError("Les deux PIN ne correspondent pas."); return; }
    const { enablePin } = await import("../lib/pinEntry");
    await enablePin(pin1, mp);
    setEnabled(true);
    cancelFlow();
  };

  const disablePinHandler = async () => {
    const { disablePin } = await import("../lib/pinEntry");
    disablePin();
    setEnabled(false);
  };

  return (
    <div className="p-4 rounded-xl border border-edge bg-base space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-primary">PIN de déverrouillage rapide</p>
          <p className="text-xs text-muted mt-0.5">
            Remplace la saisie du master password par un code à 4-6 chiffres.
            Le coffre reste chiffré avec votre master password — le PIN déverrouille
            uniquement la session en cours. Hash PBKDF2 (200 000 itérations).
          </p>
        </div>
        {step === "idle" && (
          enabled ? (
            <button onClick={disablePinHandler} className="shrink-0 text-xs px-3 py-1.5 rounded-lg border border-signal-red/30 text-signal-red hover:bg-signal-red/10 transition-colors">Désactiver</button>
          ) : (
            <button onClick={startEnable} className="shrink-0 text-xs px-3 py-1.5 rounded-lg border border-brand/40 text-accent hover:bg-brand/10 transition-colors">Activer</button>
          )
        )}
      </div>

      {step === "enter-mp" && (
        <div className="space-y-2 pt-2 border-t border-edge">
          <p className="text-xs text-muted">Confirmez votre master password pour continuer.</p>
          <input type="password" value={mp} onChange={(e) => { setMp(e.target.value); setError(null); }} onKeyDown={(e) => e.key === "Enter" && confirmMp()} placeholder="Master password" className="w-full px-3 py-2 rounded-xl border border-edge bg-surface text-sm outline-none focus:border-brand/50" autoFocus />
          {error && <p className="text-xs text-signal-red">{error}</p>}
          <div className="flex gap-2">
            <button onClick={cancelFlow} className="flex-1 py-2 rounded-lg border border-edge text-sm text-muted hover:text-primary">Annuler</button>
            <button onClick={confirmMp} disabled={loading || !mp} className="flex-1 py-2 rounded-lg bg-brand text-on-brand text-sm disabled:opacity-40">{loading ? "Vérification…" : "Continuer →"}</button>
          </div>
        </div>
      )}

      {step === "enter-pin" && (
        <div className="space-y-2 pt-2 border-t border-edge">
          <p className="text-xs text-muted">Choisissez un PIN de 4 à 6 chiffres.</p>
          <input type="password" inputMode="numeric" pattern="[0-9]*" maxLength={6} value={pin1} onChange={(e) => { setPin1(e.target.value.replace(/\D/g, "")); setError(null); }} onKeyDown={(e) => e.key === "Enter" && confirmPin()} placeholder="Ex : 1234" className="w-full px-3 py-2 rounded-xl border border-edge bg-surface text-sm font-mono outline-none focus:border-brand/50 tracking-widest" autoFocus />
          {error && <p className="text-xs text-signal-red">{error}</p>}
          <div className="flex gap-2">
            <button onClick={cancelFlow} className="flex-1 py-2 rounded-lg border border-edge text-sm text-muted hover:text-primary">Annuler</button>
            <button onClick={confirmPin} disabled={pin1.length < 4} className="flex-1 py-2 rounded-lg bg-brand text-on-brand text-sm disabled:opacity-40">Confirmer →</button>
          </div>
        </div>
      )}

      {step === "confirm-pin" && (
        <div className="space-y-2 pt-2 border-t border-edge">
          <p className="text-xs text-muted">Retapez votre PIN pour confirmer.</p>
          <input type="password" inputMode="numeric" pattern="[0-9]*" maxLength={6} value={pin2} onChange={(e) => { setPin2(e.target.value.replace(/\D/g, "")); setError(null); }} onKeyDown={(e) => e.key === "Enter" && finalizePin()} placeholder="Répétez le PIN" className="w-full px-3 py-2 rounded-xl border border-edge bg-surface text-sm font-mono outline-none focus:border-brand/50 tracking-widest" autoFocus />
          {error && <p className="text-xs text-signal-red">{error}</p>}
          <div className="flex gap-2">
            <button onClick={cancelFlow} className="flex-1 py-2 rounded-lg border border-edge text-sm text-muted hover:text-primary">Annuler</button>
            <button onClick={finalizePin} disabled={pin2.length < 4} className="flex-1 py-2 rounded-lg bg-brand text-on-brand text-sm disabled:opacity-40">Activer le PIN</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Paramètres biométrie (trousseau OS) ───────────────────────────────────

export function BiometrySettings({
  onVerifyMasterPassword,
}: {
  onVerifyMasterPassword: (mp: string) => Promise<boolean>;
}) {
  const [enabled, setEnabled] = useState(isBiometryEnabled);
  const [step, setStep] = useState<"idle" | "enter-mp">("idle");
  const [mp, setMp] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    syncBiometryState().then(() => setEnabled(isBiometryEnabled()));
  }, []);

  const startEnable = () => { setStep("enter-mp"); setMp(""); setError(null); };
  const cancel = () => { setStep("idle"); setMp(""); setError(null); };

  const confirmEnable = async () => {
    if (!mp) return;
    setLoading(true);
    setError(null);
    const ok = await onVerifyMasterPassword(mp);
    if (!ok) { setLoading(false); setError("Master password incorrect."); return; }
    try {
      await enableBiometry(mp);
      setEnabled(true);
      cancel();
    } catch (e) {
      setError(
        `Impossible d'accéder au trousseau OS : ${e instanceof Error ? e.message : String(e)}. ` +
        "Vérifiez que libsecret / GNOME Keyring est actif sur Linux, ou réessayez."
      );
    } finally {
      setLoading(false);
    }
  };

  const handleDisable = async () => {
    try {
      await disableBiometry();
      setEnabled(false);
    } catch (e) {
      setError(`Impossible de supprimer du trousseau : ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="p-4 rounded-xl border border-edge bg-base space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-primary flex items-center gap-1.5">
            <span>🔑</span> Déverrouillage par trousseau OS
          </p>
          <p className="text-xs text-muted mt-0.5">
            Stocke votre master password dans le trousseau natif de l'OS
            (Windows Credential Manager, macOS Keychain, libsecret Linux).
            Si vous avez configuré Windows Hello ou Touch ID, l'accès peut
            être conditionné à un geste biométrique — c'est l'OS qui décide.
          </p>
        </div>
        {step === "idle" && (
          enabled ? (
            <button onClick={handleDisable} className="shrink-0 text-xs px-3 py-1.5 rounded-lg border border-signal-red/30 text-signal-red hover:bg-signal-red/10 transition-colors">Désactiver</button>
          ) : (
            <button onClick={startEnable} className="shrink-0 text-xs px-3 py-1.5 rounded-lg border border-brand/40 text-accent hover:bg-brand/10 transition-colors">Activer</button>
          )
        )}
      </div>

      {enabled && step === "idle" && (
        <p className="text-xs text-signal-green flex items-center gap-1">
          <span>✓</span> Master password enregistré dans le trousseau OS.
        </p>
      )}

      {error && (
        <p className="text-xs text-signal-red bg-signal-red/10 rounded-lg px-3 py-2">{error}</p>
      )}

      {step === "enter-mp" && (
        <div className="space-y-2 pt-2 border-t border-edge">
          <p className="text-xs text-muted">Confirmez votre master password pour l'enregistrer dans le trousseau OS.</p>
          <input type="password" value={mp} onChange={(e) => { setMp(e.target.value); setError(null); }} onKeyDown={(e) => e.key === "Enter" && confirmEnable()} placeholder="Master password" className="w-full px-3 py-2 rounded-xl border border-edge bg-surface text-sm outline-none focus:border-brand/50" autoFocus />
          <div className="flex gap-2">
            <button onClick={cancel} className="flex-1 py-2 rounded-lg border border-edge text-sm text-muted hover:text-primary">Annuler</button>
            <button onClick={confirmEnable} disabled={loading || !mp} className="flex-1 py-2 rounded-lg bg-brand text-on-brand text-sm disabled:opacity-40">
              {loading ? "Enregistrement…" : "Enregistrer dans le trousseau →"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
