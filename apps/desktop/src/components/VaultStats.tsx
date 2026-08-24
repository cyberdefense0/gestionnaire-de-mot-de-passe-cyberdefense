import { useMemo } from "react";
import type { VaultItem } from "../types";
import { computeStats, formatBytes } from "../lib/vaultStats";
import { relativeDate } from "../lib/relativeDate";

interface Props {
  items: VaultItem[];
  onClose: () => void;
}

export function VaultStats({ items, onClose }: Props) {
  const s = useMemo(() => computeStats(items), [items]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-5">
        <h2 className="font-display text-2xl font-medium text-primary">Statistiques</h2>
        <button
          onClick={onClose}
          className="w-8 h-8 flex items-center justify-center rounded-lg text-muted hover:text-primary hover:bg-surface-2 transition-colors"
          title="Fermer (Échap)"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto space-y-6">

        {/* Vue d'ensemble */}
        <Section title="Vue d'ensemble">
          <div className="grid grid-cols-3 gap-3">
            <MiniStat icon="📦" value={s.total} label="Total" />
            <MiniStat icon="🔑" value={s.passwords} label="Mots de passe" />
            <MiniStat icon="📝" value={s.notes} label="Notes" />
            <MiniStat icon="⭐" value={s.favorites} label="Favoris" />
            <MiniStat icon="🔐" value={s.withTotp} label="Avec 2FA" />
            <MiniStat icon="📎" value={s.withAttachments} label="Avec pièces jointes" />
          </div>
        </Section>

        {/* Sécurité */}
        <Section title="Sécurité & renouvellement">
          <div className="space-y-2">
            <StatRow
              icon="📅"
              label="Avec date d'expiration"
              value={`${s.withExpiry} entrée${s.withExpiry > 1 ? "s" : ""}`}
            />
            {s.expiredSoon > 0 && (
              <StatRow
                icon="⚠️"
                label="Expirent dans les 7 prochains jours"
                value={s.expiredSoon.toString()}
                accent="amber"
              />
            )}
            {s.expired > 0 && (
              <StatRow
                icon="🔴"
                label="Déjà expirés"
                value={s.expired.toString()}
                accent="red"
              />
            )}
            <StatRow
              icon="💤"
              label="Jamais copiés / utilisés"
              value={`${s.neverUsed} entrée${s.neverUsed > 1 ? "s" : ""}`}
            />
          </div>
        </Section>

        {/* Organisation */}
        <Section title="Organisation">
          <div className="space-y-2">
            <StatRow icon="🏷️" label="Avec tags" value={`${s.withTags} entrée${s.withTags > 1 ? "s" : ""}`} />
            {s.topTags.length > 0 && (
              <div>
                <p className="text-xs text-muted mb-2">Tags les plus utilisés</p>
                <div className="flex flex-wrap gap-1.5">
                  {s.topTags.map(({ tag, count }) => (
                    <span key={tag} className="text-xs px-2.5 py-1 rounded-full bg-brand/10 border border-brand/30 text-accent">
                      {tag} <span className="text-muted">({count})</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Section>

        {/* Répartition par album */}
        {s.byCategory.length > 0 && (
          <Section title="Répartition par album">
            <div className="space-y-2">
              {s.byCategory.map(({ name, count }) => {
                const pct = Math.round((count / s.total) * 100);
                return (
                  <div key={name} className="flex items-center gap-3">
                    <span className="text-xs text-muted w-28 truncate shrink-0">{name}</span>
                    <div className="flex-1 h-1.5 rounded-full bg-surface-2 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-brand/60 transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-xs text-muted w-14 text-right shrink-0">
                      {count} ({pct}%)
                    </span>
                  </div>
                );
              })}
            </div>
          </Section>
        )}

        {/* Stockage */}
        {s.withAttachments > 0 && (
          <Section title="Pièces jointes">
            <StatRow
              icon="💾"
              label="Espace utilisé (estimé)"
              value={formatBytes(s.attachmentsTotalBytes)}
            />
          </Section>
        )}

        {/* Dates */}
        <Section title="Chronologie">
          {s.oldestEntry && (
            <StatRow
              icon="🕰️"
              label="Entrée la plus ancienne"
              value={`${s.oldestEntry.title} — ${relativeDate(s.oldestEntry.created_at)}`}
            />
          )}
          {s.newestEntry && s.newestEntry.id !== s.oldestEntry?.id && (
            <StatRow
              icon="✨"
              label="Dernière entrée ajoutée"
              value={`${s.newestEntry.title} — ${relativeDate(s.newestEntry.created_at)}`}
            />
          )}
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs uppercase tracking-widest text-muted mb-3">{title}</h3>
      {children}
    </div>
  );
}

function MiniStat({ icon, value, label }: { icon: string; value: number; label: string }) {
  return (
    <div className="flex flex-col items-center gap-1 p-3 rounded-xl bg-surface-2 border border-edge text-center">
      <span className="text-xl">{icon}</span>
      <span className="font-display text-xl font-medium text-primary">{value}</span>
      <span className="text-[10px] text-muted">{label}</span>
    </div>
  );
}

function StatRow({
  icon, label, value, accent,
}: {
  icon: string;
  label: string;
  value: string;
  accent?: "red" | "amber";
}) {
  const valueClass = accent === "red"
    ? "text-signal-red"
    : accent === "amber"
    ? "text-signal-amber"
    : "text-primary";

  return (
    <div className="flex items-center gap-2 py-1.5 border-b border-edge last:border-0">
      <span className="text-base shrink-0">{icon}</span>
      <span className="flex-1 text-sm text-muted">{label}</span>
      <span className={`text-sm font-medium shrink-0 ${valueClass}`}>{value}</span>
    </div>
  );
}
