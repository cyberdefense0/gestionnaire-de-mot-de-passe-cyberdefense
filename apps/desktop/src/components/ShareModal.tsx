/**
 * Modal "Partager une entrée" — résumé sans mot de passe.
 *
 * Permet de partager les informations non-sensibles d'une entrée
 * (titre, identifiant, URL, notes) avec quelqu'un sans exposer le mot
 * de passe. Deux formats :
 *   - Copier le résumé texte dans le presse-papiers
 *   - QR code (URL uniquement, si présente) à scanner depuis un autre appareil
 *
 * Ce que cette modal ne fait JAMAIS :
 *   - Exposer le mot de passe ou les champs de type "password"
 *   - Envoyer quoi que ce soit sur un réseau
 *
 * Utile pour transmettre un identifiant / une URL / des notes à un collègue
 * ou pour scanner l'URL d'un service depuis son téléphone.
 */
import { useEffect, useRef, useState } from "react";
import { writeText as clipboardWriteText } from "@tauri-apps/plugin-clipboard-manager";
import type { VaultItem } from "../types";
import { useEscapeKey } from "../lib/useEscapeKey";

interface Props {
  item: VaultItem;
  onClose: () => void;
}

export function ShareModal({ item, onClose }: Props) {
  useEscapeKey(onClose);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied] = useState(false);
  const [qrError, setQrError] = useState(false);

  // Texte partageable : tout sauf les champs sensibles
  const summaryLines: string[] = [`📦 ${item.title}`];
  if (item.username) summaryLines.push(`👤 Identifiant : ${item.username}`);
  if (item.url)      summaryLines.push(`🌐 URL : ${item.url}`);
  if (item.category && item.category !== "Général")
    summaryLines.push(`📁 Album : ${item.category}`);
  if (item.tags.length) summaryLines.push(`🏷 Tags : ${item.tags.join(", ")}`);
  if (item.notes)    summaryLines.push(`📝 Notes :\n${item.notes}`);
  summaryLines.push("\n— Partagé depuis Coffre (sans mot de passe)");
  const summary = summaryLines.join("\n");

  const handleCopy = async () => {
    try {
      await clipboardWriteText(summary);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore clipboard errors
    }
  };

  // Génère un QR code de l'URL via import dynamique de la lib `qrcode`
  // (même pattern que RecoveryKitModal — chargement différé)
  useEffect(() => {
    if (!item.url || !canvasRef.current) return;
    let cancelled = false;
    import("qrcode").then((QRCode) => {
      if (cancelled || !canvasRef.current) return;
      QRCode.toCanvas(canvasRef.current, item.url, {
        width: 200,
        margin: 2,
        color: { dark: "#1a1a2e", light: "#ffffff" },
      }).catch(() => {
        if (!cancelled) setQrError(true);
      });
    }).catch(() => {
      if (!cancelled) setQrError(true);
    });
    return () => { cancelled = true; };
  }, [item.url]);

  const hasUrl = Boolean(item.url);

  return (
    <div
      className="fixed inset-0 bg-base/90 backdrop-blur-sm flex items-center justify-center px-6 z-50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="max-w-md w-full bg-surface border border-edge rounded-2xl p-7 max-h-[88vh] overflow-y-auto">

        {/* En-tête */}
        <div className="flex items-start justify-between mb-5">
          <div>
            <h2 className="font-display text-xl font-medium text-primary">Partager sans mot de passe</h2>
            <p className="text-xs text-muted mt-0.5">Le mot de passe n'est jamais inclus.</p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-muted hover:text-primary hover:bg-surface-2 transition-colors shrink-0"
          >
            ✕
          </button>
        </div>

        {/* Avertissement sécurité */}
        <div className="flex items-start gap-2 p-3 rounded-xl bg-signal-amber/10 border border-signal-amber/30 mb-5">
          <span className="text-signal-amber text-base shrink-0 mt-0.5">⚠</span>
          <p className="text-xs text-signal-amber leading-relaxed">
            Ce résumé contient votre identifiant et URL — à partager uniquement avec des personnes de confiance.
          </p>
        </div>

        {/* Résumé texte */}
        <div className="mb-4">
          <p className="text-xs uppercase tracking-widest text-muted mb-2">Résumé à partager</p>
          <pre className="text-sm text-primary bg-base border border-edge rounded-xl p-4 whitespace-pre-wrap font-sans leading-relaxed">
            {summary}
          </pre>
          <button
            onClick={handleCopy}
            className={`mt-3 w-full py-2.5 rounded-xl border text-sm font-medium transition-all ${
              copied
                ? "border-signal-green bg-signal-green/10 text-signal-green"
                : "border-edge text-muted hover:border-brand/50 hover:text-accent"
            }`}
          >
            {copied ? "✓ Copié dans le presse-papiers" : "📋 Copier le résumé"}
          </button>
        </div>

        {/* QR Code de l'URL */}
        {hasUrl && (
          <div className="border-t border-edge pt-4">
            <p className="text-xs uppercase tracking-widest text-muted mb-3">QR code de l'URL</p>
            <div className="flex justify-center">
              {qrError ? (
                <p className="text-sm text-muted">Impossible de générer le QR code.</p>
              ) : (
                <div className="p-3 bg-white rounded-xl inline-block">
                  <canvas ref={canvasRef} />
                </div>
              )}
            </div>
            <p className="text-xs text-muted text-center mt-2">Scanner depuis votre téléphone</p>
          </div>
        )}
      </div>
    </div>
  );
}
