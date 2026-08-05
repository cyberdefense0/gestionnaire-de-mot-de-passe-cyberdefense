import { useRef, useState } from "react";
import { writeText as clipboardWriteText } from "@tauri-apps/plugin-clipboard-manager";
import { vaultApi } from "../lib/tauri";
import { isMobilePlatform } from "../lib/platform";
import type { VaultSnapshot } from "../lib/tauri";

interface Props {
  recoveryCode: string;
  onConfirm: (snapshot: VaultSnapshot) => void;
}

export function RecoveryKitModal({ recoveryCode, onConfirm }: Props) {
  // Le téléchargement image/QR passe par un dialogue "Enregistrer sous"
  // (voir vaultApi.pickImageDestination / pickQrCodeDestination) qui n'a
  // pas d'équivalent façon desktop sur mobile dans cette première passe —
  // masqués plutôt que proposés puis en échec. "Copier" (déjà natif,
  // fonctionne partout) et "Imprimer / PDF" (window.print(), non vérifié
  // sur WebView Android mais inoffensif s'il échoue) restent disponibles.
  const mobile = isMobilePlatform();
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [imageStatus, setImageStatus] = useState<string | null>(null);
  const [savingImage, setSavingImage] = useState(false);
  const [qrStatus, setQrStatus] = useState<string | null>(null);
  const [savingQr, setSavingQr] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const printRef = useRef<HTMLDivElement>(null);

  const copy = async () => {
    await clipboardWriteText(recoveryCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const print = () => {
    window.print();
  };

  const downloadImage = async () => {
    setImageStatus(null);
    const canvas = document.createElement("canvas");
    canvas.width = 900;
    canvas.height = 500;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.fillStyle = "#0B0F14";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = "#B8823E";
    ctx.font = "600 22px sans-serif";
    ctx.fillText("COFFRE — KIT DE RÉCUPÉRATION", 60, 90);

    ctx.strokeStyle = "#232C38";
    ctx.lineWidth = 1;
    ctx.strokeRect(60, 140, canvas.width - 120, 120);

    ctx.fillStyle = "#FBF7F0";
    ctx.font = "500 34px monospace";
    ctx.fillText(recoveryCode, 90, 210);

    ctx.fillStyle = "#94867E";
    ctx.font = "400 15px sans-serif";
    const lines = [
      "Ce code est la SEULE façon de récupérer vos données si vous",
      "oubliez votre master password. Personne d'autre ne peut vous",
      "le redonner. Conservez cette image dans un endroit sûr et hors ligne.",
    ];
    lines.forEach((line, i) => ctx.fillText(line, 60, 310 + i * 26));

    const dataUrl = canvas.toDataURL("image/png");
    const base64 = dataUrl.split(",")[1];
    if (!base64) {
      setImageStatus("Échec de la génération de l'image.");
      return;
    }

    setSavingImage(true);
    try {
      const dest = await vaultApi.pickImageDestination();
      if (!dest) return; // annulé par l'utilisateur
      await vaultApi.writeBinaryFile(dest, base64);
      setImageStatus("Image enregistrée avec succès.");
    } catch (e) {
      setImageStatus(`Échec de l'enregistrement : ${e}`);
    } finally {
      setSavingImage(false);
    }
  };

  const downloadQrCode = async () => {
    setQrStatus(null);
    setSavingQr(true);
    try {
      // Import différé : évite de charger la lib QR sur les écrans qui
      // n'en ont pas besoin (elle n'est utile que sur cet écran précis).
      const QRCode = (await import("qrcode")).default;
      const dataUrl = await QRCode.toDataURL(recoveryCode, {
        width: 640,
        margin: 2,
        errorCorrectionLevel: "M",
        color: { dark: "#0B0F14", light: "#FBF7F0" },
      });
      const base64 = dataUrl.split(",")[1];
      if (!base64) {
        setQrStatus("Échec de la génération du QR code.");
        return;
      }
      const dest = await vaultApi.pickQrCodeDestination();
      if (!dest) return; // annulé par l'utilisateur
      await vaultApi.writeBinaryFile(dest, base64);
      setQrStatus("QR code enregistré avec succès.");
    } catch (e) {
      setQrStatus(`Échec de l'enregistrement : ${e}`);
    } finally {
      setSavingQr(false);
    }
  };

  const confirmAndContinue = async () => {
    setConfirming(true);
    try {
      // Date la confirmation côté Rust (métadonnée non chiffrée du .vault) :
      // c'est ce qui permet au rappel périodique de VaultView de savoir
      // depuis quand l'utilisateur n'a pas reconfirmé avoir toujours accès
      // à son kit de récupération.
      const snapshot = await vaultApi.confirmRecoveryKitSaved();
      onConfirm(snapshot);
    } catch {
      // Si la commande échoue pour une raison quelconque, on ne bloque pas
      // l'utilisateur hors de son coffre fraîchement créé pour autant.
      onConfirm({ items: [], categories: ["Général"], recoveryKitConfirmedAt: null });
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-base/90 backdrop-blur-sm flex items-center justify-center px-6 z-50 print:bg-white print:backdrop-blur-none">
      <div className="max-w-lg w-full bg-surface border border-brand/30 rounded-2xl p-8 print:hidden">
        <span className="text-xs uppercase tracking-widest text-signal-amber font-medium">Étape obligatoire</span>
        <h2 className="font-display text-2xl font-medium mt-2 mb-3 text-primary">Votre kit de récupération</h2>
        <p className="text-sm text-muted leading-relaxed mb-5">
          C'est la seule façon de récupérer vos données si vous oubliez votre master password.
          Personne, pas même nous, ne peut vous le redonner. Sauvegardez-le maintenant, hors de cette application.
        </p>

        <div className="bg-base border border-edge rounded-xl p-4 mb-4 flex items-center justify-between gap-3">
          <code className="font-mono text-accent-strong text-sm tracking-wider break-all">{recoveryCode}</code>
          <button
            onClick={copy}
            className="shrink-0 text-xs px-3 py-1.5 rounded-lg border border-edge text-muted hover:text-accent-strong hover:border-brand/50 transition-colors"
          >
            {copied ? "Copié" : "Copier"}
          </button>
        </div>

        <div className="flex gap-2 mb-3">
          <button
            onClick={print}
            className="flex-1 text-xs py-2 rounded-lg border border-edge text-muted hover:text-accent hover:border-brand/50 transition-colors"
          >
            🖨️ Imprimer / PDF
          </button>
          {!mobile && (
            <button
              onClick={downloadImage}
              disabled={savingImage}
              className="flex-1 text-xs py-2 rounded-lg border border-edge text-muted hover:text-accent hover:border-brand/50 transition-colors disabled:opacity-50"
            >
              {savingImage ? "Enregistrement…" : "🖼️ Télécharger en image"}
            </button>
          )}
        </div>
        {!mobile && (
          <div className="mb-6">
            <button
              onClick={downloadQrCode}
              disabled={savingQr}
              className="w-full text-xs py-2 rounded-lg border border-edge text-muted hover:text-accent hover:border-brand/50 transition-colors disabled:opacity-50"
            >
              {savingQr ? "Enregistrement…" : "▦ Télécharger en QR code (pour impression/scan)"}
            </button>
          </div>
        )}

        {qrStatus && (
          <p className={`text-xs mb-4 ${qrStatus.startsWith("Échec") ? "text-signal-red" : "text-signal-green"}`}>
            {qrStatus}
          </p>
        )}

        {imageStatus && (
          <p className={`text-xs mb-4 ${imageStatus.startsWith("Échec") ? "text-signal-red" : "text-signal-green"}`}>
            {imageStatus}
          </p>
        )}

        <label className="flex items-start gap-3 text-sm text-muted mb-6 cursor-pointer">
          <input
            type="checkbox"
            checked={saved}
            onChange={(e) => setSaved(e.target.checked)}
            className="mt-0.5 accent-brand"
          />
          J'ai sauvegardé ce code dans un endroit sûr (gestionnaire externe, papier imprimé, coffre physique).
        </label>

        <button
          disabled={!saved || confirming}
          onClick={confirmAndContinue}
          className="w-full py-3 rounded-xl bg-brand text-on-brand font-medium disabled:opacity-30 disabled:cursor-not-allowed hover:bg-brand-hover transition-colors"
        >
          {confirming ? "Un instant…" : "Continuer vers mon coffre"}
        </button>
      </div>

      {/* Vue imprimable uniquement (masquée à l'écran, visible via window.print()) */}
      <div ref={printRef} className="hidden print:block print:p-16">
        <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 16 }}>Coffre — Kit de récupération</h1>
        <p style={{ fontSize: 13, color: "#444", marginBottom: 24, maxWidth: 480 }}>
          Ce code est la seule façon de récupérer vos données si vous oubliez votre master password.
          Conservez cette page dans un endroit sûr, hors ligne.
        </p>
        <div style={{ border: "1px solid #ccc", borderRadius: 8, padding: 20, fontFamily: "monospace", fontSize: 22, letterSpacing: 1 }}>
          {recoveryCode}
        </div>
      </div>
    </div>
  );
}
