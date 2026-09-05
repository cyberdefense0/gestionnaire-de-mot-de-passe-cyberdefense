import { useState } from "react";
import type { PasswordHistoryEntry } from "../types";
import { relativeDate } from "../lib/relativeDate";

interface Props {
  history: PasswordHistoryEntry[];
  currentPassword: string;
}

/** Analyse visuelle simple d'un mot de passe : longueur + types de caractères présents. */
function analyzePassword(pwd: string) {
  return {
    length: pwd.length,
    hasLower: /[a-z]/.test(pwd),
    hasUpper: /[A-Z]/.test(pwd),
    hasDigit: /\d/.test(pwd),
    hasSymbol: /[^a-zA-Z0-9]/.test(pwd),
  };
}

function CharBadge({ label, present }: { label: string; present: boolean }) {
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
      present
        ? "bg-brand/10 border-brand/30 text-accent"
        : "bg-surface-2 border-edge text-muted/50 line-through"
    }`}>
      {label}
    </span>
  );
}

function PasswordRow({
  pwd,
  date,
  label,
  dimmed,
}: {
  pwd: string;
  date: string;
  label?: string;
  dimmed?: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const info = analyzePassword(pwd);

  const copy = () => {
    navigator.clipboard.writeText(pwd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className={`p-3 rounded-xl border ${dimmed ? "border-edge/50 bg-surface/50 opacity-60" : "border-edge bg-surface"}`}>
      <div className="flex items-center gap-2 mb-2">
        {label && (
          <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-brand/10 text-accent border border-brand/30">
            {label}
          </span>
        )}
        <span className="text-xs text-muted ml-auto">{relativeDate(date)}</span>
      </div>

      {/* Mot de passe masqué / révélé */}
      <div className="flex items-center gap-2 mb-2">
        <span className={`flex-1 font-mono text-sm px-3 py-1.5 rounded-lg bg-surface-2 border border-edge overflow-hidden text-ellipsis ${!revealed ? "tracking-[0.3em] text-muted select-none" : "text-primary"}`}>
          {revealed ? pwd : "••••••••••••"}
        </span>
        <button
          onClick={() => setRevealed((r) => !r)}
          className="shrink-0 text-xs px-2 py-1.5 rounded-lg border border-edge text-muted hover:text-primary transition-colors"
        >
          {revealed ? "Masquer" : "Voir"}
        </button>
        <button
          onClick={copy}
          className={`shrink-0 text-xs px-2 py-1.5 rounded-lg border transition-colors ${
            copied
              ? "border-signal-green/40 bg-signal-green/10 text-signal-green"
              : "border-edge text-muted hover:text-accent"
          }`}
        >
          {copied ? "✓ Copié" : "Copier"}
        </button>
      </div>

      {/* Diff visuel */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[10px] text-muted">{info.length} car.</span>
        <span className="text-muted/30">·</span>
        <CharBadge label="a-z" present={info.hasLower} />
        <CharBadge label="A-Z" present={info.hasUpper} />
        <CharBadge label="0-9" present={info.hasDigit} />
        <CharBadge label="!@#" present={info.hasSymbol} />
      </div>
    </div>
  );
}

export function PasswordHistory({ history, currentPassword }: Props) {
  const [expanded, setExpanded] = useState(false);
  const showCount = expanded ? history.length : 3;
  const sorted = [...history].reverse(); // plus récent en premier

  if (history.length === 0) {
    return (
      <p className="text-xs text-muted italic py-2">
        Aucun historique — les anciens mots de passe apparaîtront ici lors des prochains changements.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {/* Mot de passe actuel */}
      <PasswordRow
        pwd={currentPassword}
        date={new Date().toISOString()}
        label="Actuel"
      />

      {/* Anciens mots de passe */}
      {sorted.slice(0, showCount).map((entry, i) => (
        <PasswordRow
          key={entry.changed_at + i}
          pwd={entry.password}
          date={entry.changed_at}
          dimmed
        />
      ))}

      {/* Voir plus / moins */}
      {history.length > 3 && (
        <button
          onClick={() => setExpanded((e) => !e)}
          className="w-full text-xs text-muted hover:text-accent transition-colors py-1 text-center"
        >
          {expanded
            ? "▲ Voir moins"
            : `▼ Voir ${history.length - 3} ancien${history.length - 3 > 1 ? "s" : ""} de plus`}
        </button>
      )}
    </div>
  );
}
