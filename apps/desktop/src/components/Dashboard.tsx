import { useMemo } from "react";
import type { VaultItem } from "../types";
import { computeStats } from "../lib/vaultStats";
import { relativeDate } from "../lib/relativeDate";

interface Props {
  items: VaultItem[];
  /** Nombre de problèmes détectés par le dernier audit (null = pas encore lancé) */
  auditIssueCount: number | null;
  onOpenAudit: () => void;
  onOpenItem: (item: VaultItem) => void;
  onAddEntry: () => void;
  onFilterExpired: () => void;
}

export function Dashboard({ items, auditIssueCount, onOpenAudit, onOpenItem, onAddEntry, onFilterExpired }: Props) {
  const stats = useMemo(() => computeStats(items), [items]);

  // Score de sécurité : 100 - (problèmes connus / total) * 100, plafonné
  const securityScore = auditIssueCount === null
    ? null
    : stats.total === 0
    ? 100
    : Math.max(0, Math.round(((stats.total - auditIssueCount) / stats.total) * 100));

  // Entrées expirant dans les 30 prochains jours
  const expiringSoon = useMemo(() =>
    items
      .filter((i) => {
        if (!i.expires_at) return false;
        const d = (new Date(i.expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
        return d >= 0 && d <= 30;
      })
      .sort((a, b) => new Date(a.expires_at).getTime() - new Date(b.expires_at).getTime())
      .slice(0, 5),
    [items]
  );

  // Entrées récentes (5 dernières créées)
  const recent = useMemo(() =>
    [...items]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 5),
    [items]
  );

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <span className="text-5xl mb-5">🔒</span>
        <h2 className="font-display text-2xl font-medium text-primary mb-2">Votre coffre est vide</h2>
        <p className="text-muted mb-6 max-w-xs leading-relaxed">
          Ajoutez votre premier mot de passe pour commencer à sécuriser vos comptes.
        </p>
        <button onClick={onAddEntry} className="px-6 py-3 rounded-xl bg-brand text-on-brand font-medium hover:bg-brand-hover transition-colors">
          + Ajouter une entrée
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6 py-4">

      {/* Score de sécurité */}
      <section>
        <h2 className="text-xs uppercase tracking-widest text-muted mb-3">Sécurité</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard
            value={stats.total.toString()}
            label="entrées"
            icon="📦"
          />
          <StatCard
            value={securityScore === null ? "—" : `${securityScore}%`}
            label="score sécurité"
            icon={securityScore === null ? "🔍" : securityScore >= 80 ? "✅" : securityScore >= 50 ? "⚠️" : "🔴"}
            onClick={onOpenAudit}
            sub={securityScore === null ? "Lancer l'audit" : auditIssueCount === 0 ? "Aucun problème" : `${auditIssueCount} à corriger`}
            highlight={securityScore !== null && securityScore < 80}
          />
          <StatCard
            value={stats.expired > 0 ? stats.expired.toString() : stats.expiredSoon > 0 ? stats.expiredSoon.toString() : "0"}
            label={stats.expired > 0 ? "expirés" : "expirent bientôt"}
            icon={stats.expired > 0 ? "🔴" : stats.expiredSoon > 0 ? "⚠️" : "✅"}
            onClick={stats.expired + stats.expiredSoon > 0 ? onFilterExpired : undefined}
            highlight={stats.expired > 0}
          />
          <StatCard
            value={stats.favorites.toString()}
            label="favoris"
            icon="⭐"
          />
        </div>
      </section>

      {/* Expirations imminentes */}
      {expiringSoon.length > 0 && (
        <section>
          <h2 className="text-xs uppercase tracking-widest text-muted mb-3">
            Renouvellements à prévoir
          </h2>
          <div className="space-y-2">
            {expiringSoon.map((item) => {
              const daysLeft = Math.ceil(
                (new Date(item.expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
              );
              return (
                <button
                  key={item.id}
                  onClick={() => onOpenItem(item)}
                  className="w-full flex items-center gap-3 p-3 rounded-xl border border-edge bg-surface hover:border-brand/40 hover:bg-surface-2 transition-colors text-left"
                >
                  <span className="text-xl shrink-0">
                    {item.item_type === "note" ? "📝" : "🔑"}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-primary truncate">{item.title}</p>
                    {item.username && (
                      <p className="text-xs text-muted truncate">{item.username}</p>
                    )}
                  </div>
                  <span className={`shrink-0 text-xs px-2 py-1 rounded-full ${
                    daysLeft <= 7
                      ? "bg-signal-amber/10 text-signal-amber"
                      : "bg-surface-2 text-muted"
                  }`}>
                    {daysLeft === 0 ? "Aujourd'hui" : daysLeft === 1 ? "Demain" : `Dans ${daysLeft}j`}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* Entrées récentes */}
      <section>
        <h2 className="text-xs uppercase tracking-widest text-muted mb-3">Ajouts récents</h2>
        <div className="space-y-2">
          {recent.map((item) => (
            <button
              key={item.id}
              onClick={() => onOpenItem(item)}
              className="w-full flex items-center gap-3 p-3 rounded-xl border border-edge bg-surface hover:border-brand/40 hover:bg-surface-2 transition-colors text-left"
            >
              <span className="text-xl shrink-0">
                {item.item_type === "note" ? "📝" : item.item_type === "passkey" ? "🪪" : "🔑"}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-primary truncate">{item.title}</p>
                {item.username && (
                  <p className="text-xs text-muted truncate">{item.username}</p>
                )}
              </div>
              <span className="shrink-0 text-xs text-muted">
                {relativeDate(item.created_at)}
              </span>
            </button>
          ))}
        </div>
      </section>

      {/* Répartition par catégorie */}
      {stats.byCategory.length > 1 && (
        <section>
          <h2 className="text-xs uppercase tracking-widest text-muted mb-3">Par album</h2>
          <div className="space-y-2">
            {stats.byCategory.slice(0, 6).map(({ name, count }) => {
              const pct = Math.round((count / stats.total) * 100);
              return (
                <div key={name} className="flex items-center gap-3">
                  <span className="text-xs text-muted w-28 truncate shrink-0">{name}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-surface-2 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-brand/60 transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-xs text-muted w-6 text-right shrink-0">{count}</span>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

function StatCard({
  value, label, icon, onClick, sub, highlight,
}: {
  value: string;
  label: string;
  icon: string;
  onClick?: () => void;
  sub?: string;
  highlight?: boolean;
}) {
  const cls = `flex flex-col p-4 rounded-xl border bg-surface transition-colors ${
    onClick ? "cursor-pointer hover:border-brand/50 hover:bg-surface-2" : ""
  } ${highlight ? "border-signal-amber/40 bg-signal-amber/5" : "border-edge"}`;

  const inner = (
    <>
      <span className="text-2xl mb-1">{icon}</span>
      <span className="font-display text-2xl font-medium text-primary">{value}</span>
      <span className="text-xs text-muted mt-0.5">{label}</span>
      {sub && <span className={`text-xs mt-1 ${highlight ? "text-signal-amber" : "text-accent"}`}>{sub}</span>}
    </>
  );

  if (onClick) return <button onClick={onClick} className={cls}>{inner}</button>;
  return <div className={cls}>{inner}</div>;
}
