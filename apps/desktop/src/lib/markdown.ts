/**
 * Rendu Markdown minimal — uniquement ce qui a du sens dans un champ "Notes"
 * de gestionnaire de mots de passe :
 *   - **gras** et *italique*
 *   - `code inline`
 *   - Listes à puces (- ou *) et listes numérotées
 *   - Titres ## et ###
 *   - Liens [texte](url) — ouverts dans le navigateur via target="_blank"
 *   - Séparateur ---
 *
 * Pas de dépendance externe. Sortie : HTML sûr (les < > & de l'utilisateur
 * sont échappés avant tout traitement pour éviter toute injection XSS).
 *
 * Usage :
 *   import { renderMarkdown } from "../lib/markdown";
 *   <div dangerouslySetInnerHTML={{ __html: renderMarkdown(notes) }} />
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inlineMarkdown(s: string): string {
  return (
    s
      // Liens [texte](url) — uniquement http/https
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_, text, url) =>
        `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="text-accent underline underline-offset-2 hover:text-accent-strong">${escapeHtml(text)}</a>`
      )
      // Gras **text** ou __text__
      .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => `<strong>${escapeHtml(a ?? b)}</strong>`)
      // Italique *text* ou _text_ (pas précédé/suivi d'un autre * ou _)
      .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)|(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, (_, a, b) =>
        `<em>${escapeHtml(a ?? b)}</em>`
      )
      // Code inline `code`
      .replace(/`([^`]+)`/g, (_, c) => `<code class="bg-surface-2 px-1 rounded text-[0.85em] font-mono">${escapeHtml(c)}</code>`)
  );
}

export function renderMarkdown(raw: string): string {
  const lines = raw.split("\n");
  const out: string[] = [];
  let inList: "ul" | "ol" | null = null;

  const closeList = () => {
    if (inList) {
      out.push(`</${inList}>`);
      inList = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine; // already escaped per-token below

    // Ligne vide
    if (!line.trim()) {
      closeList();
      out.push("<br />");
      continue;
    }

    // Séparateur ---
    if (/^-{3,}$/.test(line.trim())) {
      closeList();
      out.push('<hr class="border-edge my-2" />');
      continue;
    }

    // Titres ## et ###
    const h3 = line.match(/^###\s+(.+)/);
    if (h3) {
      closeList();
      out.push(`<h3 class="font-semibold text-sm text-primary mt-3 mb-1">${inlineMarkdown(h3[1])}</h3>`);
      continue;
    }
    const h2 = line.match(/^##\s+(.+)/);
    if (h2) {
      closeList();
      out.push(`<h2 class="font-semibold text-base text-primary mt-4 mb-1">${inlineMarkdown(h2[1])}</h2>`);
      continue;
    }

    // Liste à puces - item ou * item
    const ulMatch = line.match(/^[-*]\s+(.+)/);
    if (ulMatch) {
      if (inList !== "ul") {
        closeList();
        out.push('<ul class="list-disc list-inside space-y-0.5 my-1 text-sm">');
        inList = "ul";
      }
      out.push(`<li>${inlineMarkdown(ulMatch[1])}</li>`);
      continue;
    }

    // Liste numérotée 1. item
    const olMatch = line.match(/^\d+\.\s+(.+)/);
    if (olMatch) {
      if (inList !== "ol") {
        closeList();
        out.push('<ol class="list-decimal list-inside space-y-0.5 my-1 text-sm">');
        inList = "ol";
      }
      out.push(`<li>${inlineMarkdown(olMatch[1])}</li>`);
      continue;
    }

    // Paragraphe normal
    closeList();
    out.push(`<p class="text-sm leading-relaxed">${inlineMarkdown(line)}</p>`);
  }

  closeList();
  return out.join("\n");
}
