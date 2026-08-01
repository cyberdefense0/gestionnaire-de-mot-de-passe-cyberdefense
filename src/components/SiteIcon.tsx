import { useState } from "react";
import { extractDomain, faviconUrl } from "../lib/favicon";

interface Props {
  url: string;
  title: string;
  isNote?: boolean;
}

/** Affiche le favicon du site si une URL est renseignée, sinon la première lettre du titre. */
export function SiteIcon({ url, title, isNote }: Props) {
  const [failed, setFailed] = useState(false);
  const domain = !isNote ? extractDomain(url) : null;

  if (domain && !failed) {
    return (
      <div className="w-9 h-9 rounded-lg bg-surface-2 flex items-center justify-center shrink-0 overflow-hidden">
        <img
          src={faviconUrl(domain)}
          alt=""
          className="w-5 h-5"
          onError={() => setFailed(true)}
          draggable={false}
        />
      </div>
    );
  }

  return (
    <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 font-display text-sm ${isNote ? "bg-surface-2 text-muted" : "bg-brand/10 text-accent"}`}>
      {isNote ? <NoteIcon /> : title.charAt(0).toUpperCase() || "?"}
    </div>
  );
}

function NoteIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M9 13h6M9 17h6" />
    </svg>
  );
}
