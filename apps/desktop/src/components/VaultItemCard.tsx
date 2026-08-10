import { useEffect, useState, type ReactNode } from "react";
import { writeText as clipboardWriteText } from "@tauri-apps/plugin-clipboard-manager";
import type { VaultItem } from "../types";
import { SiteIcon } from "./SiteIcon";
import { relativeDate, daysUntil } from "../lib/relativeDate";
import { computeTotp } from "../lib/totp";

interface Props {
  item: VaultItem;
  onEdit: () => void;
  onDelete: () => void;
  onCopySecret: () => void;
  onCopyUsername?: () => void;
  onToggleFavorite: () => void;
  /** Auto-Type (⌨️ simule la frappe username → Tab → password → Entrée dans la fenêtre active). */
  onAutoType?: () => void;
  /** Ouvre le panneau de partage temporaire avec le secret de cette entrée pré-rempli. */
  onShare?: () => void;
  /** Mode sélection multiple : remplace les actions rapides par une case à cocher. */
  selectionMode?: boolean;
  selected?: boolean;
  onToggleSelected?: () => void;
  /** "Sélection" clavier/survol (distincte de la sélection multiple) — voir
   * roadmap README §1.1/§1.2 : survol/focus, flèches, Ctrl+C. */
  focused?: boolean;
  onFocusCard?: () => void;
}

export function VaultItemCard({
  item,
  onEdit,
  onDelete,
  onCopySecret,
  onCopyUsername,
  onToggleFavorite,
  onAutoType,
  onShare,
  selectionMode,
  selected,
  onToggleSelected,
  focused,
  onFocusCard,
}: Props) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isNote = item.item_type === "note";
  const isPasskey = item.item_type === "passkey";
  const totpField = item.custom_fields.find((f) => f.field_type === "totp" && f.value);
  const expiry = item.expires_at ? daysUntil(item.expires_at) : null;

  return (
    <div
      id={`item-card-${item.id}`}
      tabIndex={selectionMode ? undefined : 0}
      onMouseEnter={onFocusCard}
      onFocus={onFocusCard}
      onClick={selectionMode ? onToggleSelected : undefined}
      className={`group flex items-center gap-4 px-4 py-3.5 rounded-xl border outline-none transition-colors ${
        selectionMode ? "cursor-pointer" : ""
      } ${
        selectionMode && selected
          ? "border-brand bg-brand/10"
          : !selectionMode && focused
          ? "border-brand bg-brand/10 ring-2 ring-brand ring-offset-2 ring-offset-base"
          : "border-edge bg-surface hover:border-edge-strong"
      }`}
    >
      {selectionMode && (
        <input
          type="checkbox"
          checked={!!selected}
          onChange={onToggleSelected}
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 w-4 h-4 accent-brand"
        />
      )}
      <SiteIcon url={item.url} title={item.title} isNote={isNote} isPasskey={isPasskey} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="text-sm font-medium text-primary truncate">{item.title}</p>
          {item.favorite && <span className="text-signal-amber text-xs shrink-0">★</span>}
        </div>
        <p className="text-xs text-muted truncate">
          {isNote ? previewNote(item.notes) : isPasskey ? (item.passkey?.rp_id || item.username || "Passkey") : item.username || "—"}
          <span className="text-muted/60"> · modifié {relativeDate(item.updated_at)}</span>
          {item.tags.length > 0 && (
            <span className="text-accent/70"> · {item.tags.map((t) => `#${t}`).join(" ")}</span>
          )}
        </p>
      </div>

      {expiry !== null && (
        <span className={`hidden md:inline text-xs px-2 py-1 rounded-full shrink-0 ${expiry < 0 ? "bg-signal-red/10 text-signal-red" : expiry <= 7 ? "bg-signal-amber/10 text-signal-amber" : "bg-surface-2 text-muted"}`}>
          {expiry < 0 ? "Expiré" : `Expire ${expiry}j`}
        </span>
      )}

      {totpField && <TotpBadge secret={totpField.value} />}

      <span className="hidden sm:inline text-xs px-2 py-1 rounded-full bg-surface-2 text-muted shrink-0">
        {item.category}
      </span>

      {/* Actions mobiles : toujours visibles (copier + modifier), car il n'y a pas de hover sur tactile */}
      {!selectionMode && (
        <div className={`flex items-center gap-1 shrink-0 sm:transition-opacity ${focused ? "sm:opacity-100" : "sm:opacity-0 sm:pointer-events-none sm:group-hover:opacity-100 sm:group-hover:pointer-events-auto"}`}>
          <IconButton title={item.favorite ? "Retirer des favoris" : "Ajouter aux favoris"} onClick={onToggleFavorite}>
            <StarIcon filled={item.favorite} />
          </IconButton>
          {!isPasskey && (
            <IconButton
              title={`${isNote ? "Copier le contenu" : "Copier le mot de passe"}`}
              onClick={onCopySecret}
            >
              <CopyIcon />
            </IconButton>
          )}
          {!isNote && !isPasskey && item.username && onCopyUsername && (
            <IconButton title="Copier l'identifiant (Ctrl+Shift+C)" onClick={onCopyUsername} className="hidden sm:flex">
              <UserIcon />
            </IconButton>
          )}
          {!isNote && !isPasskey && item.username && onAutoType && (
            <IconButton title="Auto-Type (identifiant + mot de passe dans la fenêtre active)" onClick={onAutoType} className="hidden sm:flex">
              <ZapIcon />
            </IconButton>
          )}
          {!isPasskey && onShare && (
            <IconButton title="Partager temporairement" onClick={onShare} className="hidden sm:flex">
              <ShareIcon />
            </IconButton>
          )}
          <IconButton title="Modifier" onClick={onEdit}>
            <EditIcon />
          </IconButton>
          {confirmDelete ? (
            <button
              onClick={onDelete}
              onBlur={() => setConfirmDelete(false)}
              className="text-xs px-2 py-1.5 rounded-lg bg-signal-red/10 text-signal-red border border-signal-red/30"
              autoFocus
            >
              Confirmer
            </button>
          ) : (
            <IconButton title="Supprimer" onClick={() => setConfirmDelete(true)} className="hidden sm:flex">
              <TrashIcon />
            </IconButton>
          )}
        </div>
      )}
    </div>
  );
}

function TotpBadge({ secret }: { secret: string }) {
  const [code, setCode] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      computeTotp(secret).then((res) => {
        if (!cancelled) setCode(res?.code ?? null);
      });
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [secret]);

  if (!code) return null;
  return (
    <button
      title="Copier le code 2FA"
      onClick={(e) => {
        e.stopPropagation();
        clipboardWriteText(code);
      }}
      className="hidden lg:inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-brand/10 text-accent font-mono shrink-0 hover:bg-brand/20 transition-colors"
    >
      {code}
    </button>
  );
}

function previewNote(content: string): string {
  const trimmed = content.trim().replace(/\s+/g, " ");
  if (!trimmed) return "Note vide";
  return trimmed.length > 60 ? trimmed.slice(0, 60) + "…" : trimmed;
}

function IconButton({ title, onClick, children, className }: { title: string; onClick: () => void; children: ReactNode; className?: string }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`w-8 h-8 rounded-lg flex items-center justify-center text-muted hover:text-primary hover:bg-surface-2 transition-colors ${className ?? ""}`}
    >
      {children}
    </button>
  );
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" className={filled ? "text-signal-amber" : ""}>
      <path d="M12 2.5l2.9 6.5 7 .7-5.3 4.7 1.6 6.9-6.2-3.7-6.2 3.7 1.6-6.9L2.1 9.7l7-.7Z" />
    </svg>
  );
}
function CopyIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}
function UserIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-1a8 8 0 0 1 16 0v1" />
    </svg>
  );
}
function EditIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6" />
    </svg>
  );
}
function ZapIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M13 2 3 14h8l-1 8 10-12h-8l1-8Z" />
    </svg>
  );
}
function ShareIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="18" cy="5" r="2.7" />
      <circle cx="6" cy="12" r="2.7" />
      <circle cx="18" cy="19" r="2.7" />
      <path d="m8.4 10.6 7.2-4.2M8.4 13.4l7.2 4.2" />
    </svg>
  );
}
