import { useState, useEffect, useCallback } from "react";
import type { Attachment } from "../types";
import { vaultApi } from "../lib/tauri";
import { save } from "@tauri-apps/plugin-dialog";

/* ─── Helpers ─────────────────────────────────────────────────────── */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / 1024 / 1024).toFixed(2)} Mo`;
}

function base64Bytes(b64: string): number {
  const raw = b64.includes(",") ? b64.split(",")[1] : b64;
  return Math.floor((raw.length * 3) / 4);
}

function mimeToCategory(mime: string): "image" | "pdf" | "text" | "audio" | "video" | "other" {
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  if (
    mime.startsWith("text/") ||
    ["application/json", "application/xml", "application/javascript"].includes(mime)
  )
    return "text";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "other";
}

function toDataUrl(a: Attachment): string {
  if (a.data_base64.startsWith("data:")) return a.data_base64;
  return `data:${a.mime};base64,${a.data_base64}`;
}

function rawBase64(a: Attachment): string {
  if (a.data_base64.includes(",")) return a.data_base64.split(",")[1];
  return a.data_base64;
}

/* ─── Icône de type de fichier ─────────────────────────────────────── */

export function FileTypeIcon({
  mime,
  size = 20,
  className = "",
}: {
  mime: string;
  size?: number;
  className?: string;
}) {
  const cat = mimeToCategory(mime);
  const shared = `shrink-0 ${className}`;
  const s = size;

  switch (cat) {
    case "image":
      return (
        <svg width={s} height={s} className={shared} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="2" y="3" width="16" height="14" rx="2" />
          <circle cx="7" cy="8" r="1.5" />
          <path d="M2 14l4-4 3 3 3-4 4 5" strokeLinejoin="round" />
        </svg>
      );
    case "pdf":
      return (
        <svg width={s} height={s} className={shared} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M4 2h8l4 4v12a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" />
          <path d="M12 2v4h4" />
          <text x="4.5" y="15" fontSize="5.5" fill="currentColor" stroke="none" fontWeight="700" fontFamily="sans-serif">PDF</text>
        </svg>
      );
    case "text":
      return (
        <svg width={s} height={s} className={shared} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M4 2h8l4 4v12a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" />
          <path d="M12 2v4h4" />
          <line x1="6" y1="10" x2="14" y2="10" />
          <line x1="6" y1="13" x2="11" y2="13" />
        </svg>
      );
    case "audio":
      return (
        <svg width={s} height={s} className={shared} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M9 4L5 8H2v4h3l4 4V4z" strokeLinejoin="round" />
          <path d="M14 7a4 4 0 010 6" />
        </svg>
      );
    case "video":
      return (
        <svg width={s} height={s} className={shared} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="2" y="5" width="11" height="10" rx="1.5" />
          <path d="M13 8l5-2v8l-5-2V8z" />
        </svg>
      );
    default:
      return (
        <svg width={s} height={s} className={shared} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M4 2h8l4 4v12a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" />
          <path d="M12 2v4h4" />
        </svg>
      );
  }
}

/* ─── Vignette image ───────────────────────────────────────────────── */

function ImageThumb({ a }: { a: Attachment }) {
  return (
    <img
      src={toDataUrl(a)}
      alt={a.filename}
      className="w-10 h-10 rounded-md object-cover border border-edge shrink-0"
      onError={(e) => {
        (e.currentTarget as HTMLImageElement).style.display = "none";
      }}
    />
  );
}

/* ─── Décodage texte ───────────────────────────────────────────────── */

function TextPreview({ a }: { a: Attachment }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    try {
      setText(atob(rawBase64(a)));
    } catch {
      setText("Impossible de décoder ce fichier texte.");
    }
  }, [a]);
  return (
    <pre className="w-full max-h-[55vh] overflow-auto text-xs font-mono text-primary bg-base rounded-xl p-4 border border-edge text-left whitespace-pre-wrap break-words">
      {text ?? "Chargement…"}
    </pre>
  );
}

/* ─── Lightbox ─────────────────────────────────────────────────────── */

function PreviewModal({
  attachment: a,
  onClose,
  onDownload,
}: {
  attachment: Attachment;
  onClose: () => void;
  onDownload: (a: Attachment) => void;
}) {
  const cat = mimeToCategory(a.mime);
  const dataUrl = toDataUrl(a);

  const handleKey = useCallback(
    (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); },
    [onClose]
  );
  useEffect(() => {
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [handleKey]);

  const renderContent = () => {
    switch (cat) {
      case "image":
        return <img src={dataUrl} alt={a.filename} className="max-w-full max-h-[60vh] rounded-xl object-contain" />;
      case "pdf":
        return <iframe src={dataUrl} title={a.filename} className="w-full h-[60vh] rounded-xl border border-edge" />;
      case "text":
        return <TextPreview a={a} />;
      case "audio":
        return <audio controls src={dataUrl} className="w-full rounded-lg" />;
      case "video":
        return <video controls src={dataUrl} className="max-w-full max-h-[55vh] rounded-xl" />;
      default:
        return (
          <div className="flex flex-col items-center gap-4 py-8 text-muted">
            <FileTypeIcon mime={a.mime} size={48} className="text-muted/60" />
            <p className="text-sm">Prévisualisation non disponible pour ce type de fichier.</p>
            <p className="text-xs text-muted/60">{a.mime}</p>
          </div>
        );
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-surface rounded-2xl shadow-2xl border border-edge w-full max-w-2xl flex flex-col overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-3.5 border-b border-edge shrink-0">
          <FileTypeIcon mime={a.mime} size={18} className="text-accent" />
          <span className="flex-1 text-sm font-medium text-primary truncate">{a.filename}</span>
          <span className="text-xs text-muted shrink-0">{formatBytes(base64Bytes(a.data_base64))}</span>
          <button
            onClick={() => onDownload(a)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-brand/10 text-accent hover:bg-brand/20 transition-colors shrink-0"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M8 2v8M5 7l3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M2 11v1.5A1.5 1.5 0 003.5 14h9A1.5 1.5 0 0014 12.5V11" strokeLinecap="round" />
            </svg>
            Enregistrer
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-muted hover:text-primary hover:bg-surface-2 transition-colors"
            title="Fermer (Échap)"
          >
            <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="4" y1="4" x2="12" y2="12" strokeLinecap="round" />
              <line x1="12" y1="4" x2="4" y2="12" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="p-5 overflow-auto flex flex-col items-center justify-center">
          {renderContent()}
        </div>
      </div>
    </div>
  );
}

/* ─── Composant principal ─────────────────────────────────────────── */

interface AttachmentListProps {
  attachments: Attachment[];
  editable?: boolean;
  onRemove?: (id: string) => void;
  onAdd?: () => void;
  addError?: string;
}

export function AttachmentList({
  attachments,
  editable,
  onRemove,
  onAdd,
  addError,
}: AttachmentListProps) {
  const [previewing, setPreviewing] = useState<Attachment | null>(null);
  const [downloadStatus, setDownloadStatus] = useState<Record<string, "ok" | "err">>({});

  const handleDownload = async (a: Attachment) => {
    try {
      const ext = a.filename.includes(".") ? a.filename.split(".").pop() : undefined;
      const dest = await save({
        defaultPath: a.filename,
        filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : undefined,
      });
      if (!dest) return;
      await vaultApi.writeBinaryFile(dest, rawBase64(a));
      setDownloadStatus((s) => ({ ...s, [a.id]: "ok" }));
      setTimeout(
        () => setDownloadStatus((s) => { const n = { ...s }; delete n[a.id]; return n; }),
        2000
      );
    } catch {
      setDownloadStatus((s) => ({ ...s, [a.id]: "err" }));
      setTimeout(
        () => setDownloadStatus((s) => { const n = { ...s }; delete n[a.id]; return n; }),
        3000
      );
    }
  };

  return (
    <>
      {editable && (
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs uppercase tracking-wider text-muted">
            Pièces jointes{" "}
            <span className="normal-case text-muted/60">(max 3 Mo)</span>
          </label>
          <button
            type="button"
            onClick={onAdd}
            className="flex items-center gap-1 text-xs text-accent hover:text-accent-strong transition-colors"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="7" y1="2" x2="7" y2="12" strokeLinecap="round" />
              <line x1="2" y1="7" x2="12" y2="7" strokeLinecap="round" />
            </svg>
            Ajouter
          </button>
        </div>
      )}

      {!editable && attachments.length > 0 && (
        <label className="text-xs uppercase tracking-wider text-muted mb-2 block">
          Pièces jointes
        </label>
      )}

      {addError && <p className="text-xs text-signal-red mb-2">{addError}</p>}
      {attachments.length === 0 && editable && (
        <p className="text-xs text-muted/60 italic">Aucune pièce jointe.</p>
      )}

      {attachments.length > 0 && (
        <div className="space-y-1.5">
          {attachments.map((a) => {
            const isImage = mimeToCategory(a.mime) === "image";
            const status = downloadStatus[a.id];
            return (
              <div
                key={a.id}
                className="group flex items-center gap-2.5 px-3 py-2 rounded-xl border border-edge bg-base hover:border-edge-strong hover:bg-surface-2/40 transition-colors"
              >
                {isImage ? <ImageThumb a={a} /> : <FileTypeIcon mime={a.mime} size={20} className="text-muted" />}

                <div className="flex-1 min-w-0">
                  <p className="text-sm text-primary truncate leading-tight">{a.filename}</p>
                  <p className="text-[11px] text-muted leading-tight">
                    {formatBytes(base64Bytes(a.data_base64))}
                  </p>
                </div>

                <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    type="button"
                    onClick={() => setPreviewing(a)}
                    className="p-1.5 rounded-lg text-muted hover:text-accent hover:bg-brand/10 transition-colors"
                    title="Prévisualiser"
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <ellipse cx="8" cy="8" rx="6" ry="4" />
                      <circle cx="8" cy="8" r="1.8" />
                    </svg>
                  </button>

                  {!editable && (
                    <button
                      type="button"
                      onClick={() => handleDownload(a)}
                      className="p-1.5 rounded-lg text-muted hover:text-accent hover:bg-brand/10 transition-colors"
                      title={status === "ok" ? "Enregistré ✓" : status === "err" ? "Échec" : "Enregistrer"}
                    >
                      {status === "ok" ? (
                        <svg className="w-3.5 h-3.5 text-signal-green" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="3,8 6,11 13,5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      ) : (
                        <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
                          <path d="M8 2v8M5 7l3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
                          <path d="M2 11v1.5A1.5 1.5 0 003.5 14h9A1.5 1.5 0 0014 12.5V11" strokeLinecap="round" />
                        </svg>
                      )}
                    </button>
                  )}

                  {editable && onRemove && (
                    <button
                      type="button"
                      onClick={() => onRemove(a.id)}
                      className="p-1.5 rounded-lg text-muted hover:text-signal-red hover:bg-signal-red/10 transition-colors"
                      title="Retirer"
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="4" y1="4" x2="12" y2="12" strokeLinecap="round" />
                        <line x1="12" y1="4" x2="4" y2="12" strokeLinecap="round" />
                      </svg>
                    </button>
                  )}
                </div>

                {/* Bouton retirer toujours visible hors hover en mode édition */}
                {editable && onRemove && (
                  <button
                    type="button"
                    onClick={() => onRemove(a.id)}
                    className="group-hover:hidden p-1 text-xs text-muted hover:text-signal-red transition-colors shrink-0"
                    title="Retirer"
                  >
                    ✕
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {previewing && (
        <PreviewModal
          attachment={previewing}
          onClose={() => setPreviewing(null)}
          onDownload={handleDownload}
        />
      )}
    </>
  );
}
