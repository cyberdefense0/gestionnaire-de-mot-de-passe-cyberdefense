/**
 * Générateur de mot de passe / phrase de passe standalone.
 *
 * Accessible depuis le header (bouton 🎲) sans créer d'entrée.
 * Reprend exactement les mêmes options que le générateur intégré à
 * VaultItemForm, mais dans un panneau latéral indépendant.
 *
 * Modes :
 *   "random"     — mot de passe aléatoire (caractères)
 *   "passphrase" — phrase de passe mémorisable EFF Diceware
 */
import { useCallback, useEffect, useState } from "react";
import { writeText as clipboardWriteText } from "@tauri-apps/plugin-clipboard-manager";
import { generatePassword } from "../lib/passwordGenerator";
import {
  generateMemorablePassphrase,
  DEFAULT_PASSPHRASE_OPTIONS,
  entropyBits,
  type PassphraseOptions,
} from "../lib/passphraseGenerator";
import { analyzeStrengthAsync } from "../lib/passwordStrength";
import { PasswordStrengthMeter } from "./PasswordStrengthMeter";
import { DEFAULT_GENERATOR_OPTIONS, type GeneratorOptions } from "../types";
import { useEscapeKey } from "../lib/useEscapeKey";

interface Props {
  onClose: () => void;
  /** Optionnel : insérer le mot de passe généré dans un contexte parent. */
  onUse?: (password: string) => void;
}

type GenMode = "random" | "passphrase";

const HISTORY_KEY = "coffre:genHistory";
const MAX_HISTORY = 10;

function loadHistory(): string[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]"); }
  catch { return []; }
}
function saveHistory(h: string[]) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, MAX_HISTORY)));
}

export function PasswordGeneratorPanel({ onClose, onUse }: Props) {
  useEscapeKey(onClose);

  const [mode, setMode] = useState<GenMode>("random");
  const [opts, setOpts] = useState<GeneratorOptions>(DEFAULT_GENERATOR_OPTIONS);
  const [ppOpts, setPpOpts] = useState<PassphraseOptions>(DEFAULT_PASSPHRASE_OPTIONS);
  const [password, setPassword] = useState("");
  const [strengthScore, setStrengthScore] = useState(0);
  const [copied, setCopied] = useState(false);
  const [history, setHistory] = useState<string[]>(loadHistory);

  // Génère à chaque changement d'option
  const generate = useCallback(() => {
    const pw = mode === "random"
      ? generatePassword(opts)
      : generateMemorablePassphrase(ppOpts);
    setPassword(pw);
    setCopied(false);
  }, [mode, opts, ppOpts]);

  useEffect(() => { generate(); }, [generate]);

  // Force via Web Worker (debounced)
  useEffect(() => {
    if (!password) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const res = await analyzeStrengthAsync(password);
      if (!cancelled) setStrengthScore(res.score);
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [password]);

  const handleCopy = async () => {
    if (!password) return;
    try {
      await clipboardWriteText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      // Ajout à l'historique de génération (session + localStorage)
      const next = [password, ...history.filter(h => h !== password)].slice(0, MAX_HISTORY);
      setHistory(next);
      saveHistory(next);
    } catch { /* ignore */ }
  };

  const handleUse = () => {
    if (onUse) { onUse(password); onClose(); }
  };

  const entropy = mode === "passphrase"
    ? Math.round(entropyBits(ppOpts.wordCount, ppOpts.includeNumber))
    : null;

  return (
    <div
      className="fixed inset-0 bg-base/80 backdrop-blur-sm flex items-start justify-end z-50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-sm h-full bg-surface border-l border-edge shadow-2xl flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-edge shrink-0">
          <h2 className="font-display text-lg font-medium text-primary">🎲 Générateur</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-muted hover:text-primary hover:bg-surface-2 transition-colors"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">

          {/* Mode tabs */}
          <div className="flex gap-1 p-1 rounded-xl bg-base border border-edge">
            {(["random", "passphrase"] as GenMode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
                  mode === m ? "bg-surface text-primary shadow-sm" : "text-muted hover:text-primary"
                }`}
              >
                {m === "random" ? "🔡 Aléatoire" : "📖 Phrase"}
              </button>
            ))}
          </div>

          {/* Mot de passe généré */}
          <div>
            <div className="relative">
              <p
                className={`font-mono text-sm text-primary bg-base border rounded-xl px-4 py-3 pr-12 break-all min-h-[3rem] leading-relaxed select-all transition-colors ${
                  strengthScore >= 3 ? "border-signal-green/40" :
                  strengthScore >= 2 ? "border-signal-amber/40" :
                  password ? "border-signal-red/40" : "border-edge"
                }`}
              >
                {password}
              </p>
              <button
                onClick={generate}
                title="Régénérer"
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-accent transition-colors"
              >
                🔄
              </button>
            </div>
            {password && (
              <div className="mt-2">
                <PasswordStrengthMeter password={password} />
              </div>
            )}
            {entropy !== null && (
              <p className="text-xs text-muted mt-1">~{entropy} bits d'entropie</p>
            )}
          </div>

          {/* Options — Aléatoire */}
          {mode === "random" && (
            <div className="space-y-3">
              <div>
                <div className="flex justify-between mb-1">
                  <label className="text-xs text-muted uppercase tracking-widest">Longueur</label>
                  <span className="text-xs font-mono text-accent">{opts.length}</span>
                </div>
                <input
                  type="range" min={8} max={128} step={4}
                  value={opts.length}
                  onChange={(e) => setOpts(o => ({ ...o, length: Number(e.target.value) }))}
                  className="w-full accent-brand"
                />
                <div className="flex justify-between text-[10px] text-muted mt-0.5">
                  <span>8</span><span>128</span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {([
                  ["uppercase", "A–Z Majuscules"],
                  ["lowercase", "a–z Minuscules"],
                  ["numbers",   "0–9 Chiffres"],
                  ["symbols",   "!@# Symboles"],
                ] as [keyof GeneratorOptions, string][]).map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2 text-sm text-primary cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(opts[key])}
                      onChange={(e) => setOpts(o => ({ ...o, [key]: e.target.checked }))}
                      className="accent-brand"
                    />
                    {label}
                  </label>
                ))}
              </div>
              <label className="flex items-center gap-2 text-sm text-primary cursor-pointer">
                <input
                  type="checkbox"
                  checked={opts.alphanumeric_only}
                  onChange={(e) => setOpts(o => ({ ...o, alphanumeric_only: e.target.checked }))}
                  className="accent-brand"
                />
                Alphanumérique uniquement (sans symboles)
              </label>
              <div>
                <label className="text-xs text-muted uppercase tracking-widest block mb-1">
                  Caractères à exclure
                </label>
                <input
                  type="text"
                  value={opts.exclude_chars}
                  onChange={(e) => setOpts(o => ({ ...o, exclude_chars: e.target.value }))}
                  placeholder="ex : lI1O0"
                  className="w-full px-3 py-2 text-sm rounded-xl border border-edge bg-base text-primary font-mono focus:outline-none focus:border-brand/50"
                />
              </div>
            </div>
          )}

          {/* Options — Phrase de passe */}
          {mode === "passphrase" && (
            <div className="space-y-3">
              <div>
                <div className="flex justify-between mb-1">
                  <label className="text-xs text-muted uppercase tracking-widest">Nombre de mots</label>
                  <span className="text-xs font-mono text-accent">{ppOpts.wordCount}</span>
                </div>
                <input
                  type="range" min={3} max={10} step={1}
                  value={ppOpts.wordCount}
                  onChange={(e) => setPpOpts(o => ({ ...o, wordCount: Number(e.target.value) }))}
                  className="w-full accent-brand"
                />
              </div>
              <div>
                <label className="text-xs text-muted uppercase tracking-widest block mb-1">Séparateur</label>
                <div className="flex gap-2">
                  {["-", "_", ".", " "].map((sep) => (
                    <button
                      key={sep}
                      onClick={() => setPpOpts(o => ({ ...o, separator: sep }))}
                      className={`w-10 h-9 rounded-lg border text-sm font-mono transition-colors ${
                        ppOpts.separator === sep
                          ? "border-brand bg-brand/10 text-accent"
                          : "border-edge text-muted hover:border-brand/40"
                      }`}
                    >
                      {sep === " " ? "␣" : sep}
                    </button>
                  ))}
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm text-primary cursor-pointer">
                <input type="checkbox" checked={ppOpts.capitalize}
                  onChange={(e) => setPpOpts(o => ({ ...o, capitalize: e.target.checked }))}
                  className="accent-brand" />
                Majuscule initiale sur chaque mot
              </label>
              <label className="flex items-center gap-2 text-sm text-primary cursor-pointer">
                <input type="checkbox" checked={ppOpts.includeNumber}
                  onChange={(e) => setPpOpts(o => ({ ...o, includeNumber: e.target.checked }))}
                  className="accent-brand" />
                Ajouter un nombre à la fin
              </label>
            </div>
          )}

          {/* Historique de génération */}
          {history.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs uppercase tracking-widest text-muted">Générés récemment</p>
                <button
                  onClick={() => { setHistory([]); saveHistory([]); }}
                  className="text-xs text-muted hover:text-signal-red transition-colors"
                >
                  Effacer
                </button>
              </div>
              <div className="space-y-1">
                {history.map((pw, i) => (
                  <button
                    key={i}
                    onClick={() => { setPassword(pw); setCopied(false); }}
                    className="w-full text-left px-3 py-2 rounded-lg border border-edge bg-base hover:border-brand/40 text-xs font-mono text-muted hover:text-primary transition-colors truncate"
                  >
                    {pw}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="px-5 py-4 border-t border-edge space-y-2 shrink-0">
          <button
            onClick={handleCopy}
            className={`w-full py-3 rounded-xl border text-sm font-medium transition-all ${
              copied
                ? "border-signal-green bg-signal-green/10 text-signal-green"
                : "border-edge text-muted hover:border-brand/50 hover:text-accent"
            }`}
          >
            {copied ? "✓ Copié !" : "📋 Copier"}
          </button>
          {onUse && (
            <button
              onClick={handleUse}
              className="w-full py-3 rounded-xl bg-brand text-on-brand text-sm font-medium hover:bg-brand-hover transition-colors"
            >
              ✓ Utiliser ce mot de passe
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
