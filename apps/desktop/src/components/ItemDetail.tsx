import { useState } from "react";
import { writeText as clipboardWriteText } from "@tauri-apps/plugin-clipboard-manager";
import type { VaultItem } from "../types";
import { relativeDate } from "../lib/relativeDate";
import { openUrl, isWebUrl } from "../lib/openUrl";
import { renderMarkdown } from "../lib/markdown";
import { computeTotp } from "../lib/totp";
import { useEffect } from "react";
import { PasswordHistory } from "./PasswordHistory";

interface Props {
  item: VaultItem;
  onEdit: () => void;
  onClose: () => void;
  onCopy: (value: string, label: string) => void;
}

export function ItemDetail({ item, onEdit, onClose, onCopy }: Props) {
  const isNote = item.item_type === "note";
  const [revealed, setRevealed] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setRevealed((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const daysUntilExpiry = item.expires_at
    ? (new Date(item.expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    : null;

  return (
    <div className="flex flex-col h-full">
      {/* En-tête */}
      <div className="flex items-start gap-3 mb-5">
        <button
          onClick={onClose}
          className="mt-1 text-muted hover:text-primary transition-colors shrink-0"
          title="Fermer (Échap)"
        >
          ←
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="font-display text-xl font-medium text-primary">{item.title}</h2>
            {item.favorite && <span title="Favori" className="text-base">⭐</span>}
            {isNote && <span className="text-xs px-2 py-0.5 rounded-full bg-surface-2 text-muted">Note</span>}
            {item.item_type === "passkey" && <span className="text-xs px-2 py-0.5 rounded-full bg-surface-2 text-muted">Passkey</span>}
          </div>
          {item.category && (
            <p className="text-xs text-muted mt-0.5">{item.category}</p>
          )}
        </div>
        <button
          onClick={onEdit}
          className="shrink-0 px-3 py-1.5 rounded-lg border border-edge text-sm text-accent hover:border-brand/50 transition-colors"
        >
          Modifier
        </button>
      </div>

      <div className="flex-1 overflow-y-auto space-y-4">
        {/* Identifiant */}
        {item.username && (
          <DetailRow
            label="Identifiant"
            value={item.username}
            onCopy={() => { clipboardWriteText(item.username); onCopy(item.username, "Identifiant"); }}
          />
        )}

        {/* Mot de passe */}
        {item.password && (
          <div>
            <label className="text-xs uppercase tracking-wider text-muted mb-1.5 block">Mot de passe</label>
            <div className="flex items-center gap-2">
              <span className={`flex-1 font-mono text-sm px-3 py-2 rounded-xl bg-surface-2 border border-edge overflow-hidden text-ellipsis ${!revealed.has("pwd") ? "tracking-[0.25em]" : ""}`}>
                {revealed.has("pwd") ? item.password : "••••••••••••"}
              </span>
              <button
                onClick={() => toggle("pwd")}
                className="shrink-0 text-xs px-2 py-2 rounded-lg border border-edge text-muted hover:text-primary transition-colors"
                title={revealed.has("pwd") ? "Masquer" : "Voir le mot de passe"}
              >
                {revealed.has("pwd") ? "Masquer" : "Voir"}
              </button>
              <button
                onClick={() => { clipboardWriteText(item.password); onCopy(item.password, "Mot de passe"); }}
                className="shrink-0 text-xs px-2 py-2 rounded-lg bg-brand/10 border border-brand/30 text-accent hover:bg-brand/20 transition-colors"
                title="Copier le mot de passe"
              >
                Copier
              </button>
            </div>
          </div>
        )}

        {/* URL avec bouton Ouvrir */}
        {item.url && (
          <div>
            <label className="text-xs uppercase tracking-wider text-muted mb-1.5 block">Adresse du site</label>
            <div className="flex items-center gap-2">
              <span className="flex-1 text-sm px-3 py-2 rounded-xl bg-surface-2 border border-edge text-accent truncate">
                {item.url}
              </span>
              {isWebUrl(item.url) && (
                <button
                  onClick={() => openUrl(item.url)}
                  className="shrink-0 text-xs px-2 py-2 rounded-lg border border-edge text-muted hover:text-accent hover:border-brand/40 transition-colors"
                  title="Ouvrir dans le navigateur"
                >
                  Ouvrir ↗
                </button>
              )}
            </div>
          </div>
        )}

        {/* Notes avec rendu Markdown */}
        {item.notes && (
          <div>
            <label className="text-xs uppercase tracking-wider text-muted mb-1.5 block">
              {isNote ? "Contenu" : "Notes"}
            </label>
            <div
              className="px-3 py-3 rounded-xl bg-surface-2 border border-edge text-primary leading-relaxed"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(item.notes) }}
            />
          </div>
        )}

        {/* Champs personnalisés */}
        {item.custom_fields.length > 0 && (
          <div>
            <label className="text-xs uppercase tracking-wider text-muted mb-2 block">Champs personnalisés</label>
            <div className="space-y-2">
              {item.custom_fields.map((f) => (
                f.field_type === "totp"
                  ? <TotpDetailRow key={f.id} label={f.label} secret={f.value} onCopy={onCopy} />
                  : <CustomFieldRow
                      key={f.id}
                      field={f}
                      revealed={revealed.has(f.id)}
                      onToggle={() => toggle(f.id)}
                      onCopy={() => { clipboardWriteText(f.value); onCopy(f.value, f.label); }}
                    />
              ))}
            </div>
          </div>
        )}

        {/* Pièces jointes */}
        {item.attachments.length > 0 && (
          <div>
            <label className="text-xs uppercase tracking-wider text-muted mb-2 block">Pièces jointes</label>
            <div className="space-y-1.5">
              {item.attachments.map((a) => (
                <div key={a.id} className="flex items-center gap-2 px-3 py-2 rounded-xl bg-surface-2 border border-edge text-sm">
                  <span className="text-base">📎</span>
                  <span className="flex-1 truncate text-primary">{a.filename}</span>
                  <span className="text-xs text-muted shrink-0">{a.mime}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tags */}
        {item.tags.length > 0 && (
          <div>
            <label className="text-xs uppercase tracking-wider text-muted mb-1.5 block">Tags</label>
            <div className="flex flex-wrap gap-1.5">
              {item.tags.map((t) => (
                <span key={t} className="text-xs px-2.5 py-1 rounded-full bg-brand/10 border border-brand/30 text-accent">
                  {t}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Expiration */}
        {item.expires_at && daysUntilExpiry !== null && (
          <div className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-sm ${
            daysUntilExpiry < 0
              ? "bg-signal-red/10 border-signal-red/30 text-signal-red"
              : daysUntilExpiry <= 7
              ? "bg-signal-amber/10 border-signal-amber/30 text-signal-amber"
              : "bg-surface-2 border-edge text-muted"
          }`}>
            <span>📅</span>
            <span>
              {daysUntilExpiry < 0
                ? `Expiré le ${new Date(item.expires_at).toLocaleDateString("fr-FR")}`
                : daysUntilExpiry === 0
                ? "Expire aujourd'hui"
                : daysUntilExpiry <= 1
                ? "Expire demain"
                : `Expire le ${new Date(item.expires_at).toLocaleDateString("fr-FR")} (dans ${Math.ceil(daysUntilExpiry)}j)`}
            </span>
          </div>
        )}

        {/* Métadonnées */}
        <div className="border-t border-edge pt-4 space-y-1">
          <MetaRow label="Créé" value={relativeDate(item.created_at)} />
          <MetaRow label="Modifié" value={relativeDate(item.updated_at)} />
          {item.last_used_at && <MetaRow label="Dernière utilisation" value={relativeDate(item.last_used_at)} />}
        </div>

        {/* Historique des mots de passe avec diff visuel */}
        {item.item_type === "password" && (
          <div className="border-t border-edge pt-4">
            <h3 className="text-xs uppercase tracking-wider text-muted mb-3">
              Historique des mots de passe
            </h3>
            <PasswordHistory
              history={item.password_history}
              currentPassword={item.password}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function DetailRow({ label, value, onCopy }: { label: string; value: string; onCopy: () => void }) {
  return (
    <div>
      <label className="text-xs uppercase tracking-wider text-muted mb-1.5 block">{label}</label>
      <div className="flex items-center gap-2">
        <span className="flex-1 text-sm px-3 py-2 rounded-xl bg-surface-2 border border-edge text-primary truncate">
          {value}
        </span>
        <button
          onClick={onCopy}
          className="shrink-0 text-xs px-2 py-2 rounded-lg border border-edge text-muted hover:text-accent transition-colors"
          title={`Copier ${label.toLowerCase()}`}
        >
          Copier
        </button>
      </div>
    </div>
  );
}

function CustomFieldRow({
  field, revealed, onToggle, onCopy,
}: {
  field: { label: string; value: string; field_type: string };
  revealed: boolean;
  onToggle: () => void;
  onCopy: () => void;
}) {
  const isSecret = field.field_type === "password";
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted w-24 shrink-0 truncate">{field.label}</span>
      <span className={`flex-1 text-sm px-3 py-2 rounded-xl bg-surface-2 border border-edge truncate ${isSecret && !revealed ? "font-mono tracking-widest text-muted" : "text-primary"}`}>
        {isSecret && !revealed ? "••••••••" : field.value}
      </span>
      {isSecret && (
        <button onClick={onToggle} className="shrink-0 text-xs text-muted hover:text-primary transition-colors">
          {revealed ? "Masquer" : "Voir"}
        </button>
      )}
      <button onClick={onCopy} className="shrink-0 text-xs px-2 py-1.5 rounded-lg border border-edge text-muted hover:text-accent transition-colors">
        Copier
      </button>
    </div>
  );
}

function TotpDetailRow({ label, secret, onCopy }: { label: string; secret: string; onCopy: (v: string, l: string) => void }) {
  const [code, setCode] = useState<string | null>(null);
  const [secsLeft, setSecsLeft] = useState(30);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      computeTotp(secret).then((r) => {
        if (!cancelled) {
          setCode(r?.code ?? null);
          setSecsLeft(30 - (Math.floor(Date.now() / 1000) % 30));
        }
      });
    };
    tick();
    const iv = setInterval(tick, 1000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [secret]);

  const urgent = secsLeft <= 7;
  const pct = (secsLeft / 30) * 100;

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted w-24 shrink-0 truncate">{label}</span>
      <div className={`flex-1 flex flex-col gap-0.5 px-3 py-2 rounded-xl border ${urgent ? "bg-signal-amber/10 border-signal-amber/30" : "bg-surface-2 border-edge"}`}>
        <span className={`font-mono font-bold text-sm tracking-widest ${urgent ? "text-signal-amber" : "text-accent"}`}>
          {code ?? "——————"}
        </span>
        <span className="w-full h-0.5 rounded-full bg-current/10 overflow-hidden">
          <span className={`block h-full rounded-full transition-none ${urgent ? "bg-signal-amber" : "bg-brand/60"}`} style={{ width: `${pct}%` }} />
        </span>
      </div>
      <button
        onClick={() => code && onCopy(code, label)}
        className="shrink-0 text-xs px-2 py-1.5 rounded-lg border border-edge text-muted hover:text-accent transition-colors"
        title={`${secsLeft}s restantes`}
      >
        Copier
      </button>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted">
      <span className="w-32 shrink-0">{label}</span>
      <span>{value}</span>
    </div>
  );
}
