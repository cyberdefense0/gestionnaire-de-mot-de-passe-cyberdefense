import { useEffect, useState } from "react";
import type { VaultItem } from "../types";
import { runLocalAudit, runPwnedAudit, type AuditFinding, type PwnedResult } from "../lib/security";
import { useEscapeKey } from "../lib/useEscapeKey";

interface Props {
  items: VaultItem[];
  onClose: () => void;
  onOpenItem: (item: VaultItem) => void;
}

export function SecurityAudit({ items, onClose, onOpenItem }: Props) {
  useEscapeKey(onClose);

  // runLocalAudit est asynchrone et découpé en tranches côté lib/security.ts
  // (le calcul de force par entrée, via zxcvbn, est coûteux et grimpe vite
  // avec la longueur des mots de passe — un vault avec beaucoup d'entrées à
  // mots de passe longs pourrait sinon geler l'ouverture de cette fenêtre).
  const [localFindings, setLocalFindings] = useState<AuditFinding[]>([]);
  const [localProgress, setLocalProgress] = useState<{ done: number; total: number } | null>({ done: 0, total: 1 });
  useEffect(() => {
    let cancelled = false;
    setLocalProgress({ done: 0, total: 1 });
    runLocalAudit(items, (done, total) => {
      if (!cancelled) setLocalProgress({ done, total });
    }).then((findings) => {
      if (!cancelled) {
        setLocalFindings(findings);
        setLocalProgress(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [items]);

  const [pwnedResults, setPwnedResults] = useState<PwnedResult[] | null>(null);
  const [pwnedProgress, setPwnedProgress] = useState<{ done: number; total: number } | null>(null);
  const [pwnedError, setPwnedError] = useState<string | null>(null);

  const runPwned = async () => {
    setPwnedError(null);
    setPwnedResults(null);
    setPwnedProgress({ done: 0, total: 1 });
    try {
      const results = await runPwnedAudit(items, (done, total) => setPwnedProgress({ done, total }));
      setPwnedResults(results);
    } catch {
      setPwnedError("La vérification a échoué (vérifiez votre connexion).");
    } finally {
      setPwnedProgress(null);
    }
  };

  const pwnedById = new Map((pwnedResults ?? []).map((r) => [r.itemId, r.count]));
  const itemsById = new Map(items.map((i) => [i.id, i]));

  // Fusionne les résultats locaux et HIBP par entrée
  const combined = new Map<string, { item: VaultItem; reasons: string[] }>();
  for (const f of localFindings) combined.set(f.item.id, { item: f.item, reasons: [...f.reasons] });
  for (const [id, count] of pwnedById) {
    if (count <= 0) continue;
    const item = itemsById.get(id);
    if (!item) continue;
    const entry = combined.get(id) ?? { item, reasons: [] };
    entry.reasons.push(`Compromis (${count.toLocaleString("fr-FR")} fois)`);
    combined.set(id, entry);
  }

  const results = Array.from(combined.values()).sort((a, b) => b.reasons.length - a.reasons.length);

  return (
    <div className="fixed inset-0 bg-base/90 backdrop-blur-sm flex items-center justify-center px-6 z-40">
      <div className="max-w-lg w-full bg-surface border border-edge rounded-2xl p-7 max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between mb-1">
          <h2 className="font-display text-2xl font-medium text-primary">Audit de sécurité</h2>
          <button onClick={onClose} className="text-muted hover:text-primary text-sm px-2 py-1">
            Fermer
          </button>
        </div>
        <p className="text-sm text-muted mb-4">
          Mots de passe faibles, réutilisés, anciens ou expirant bientôt — analysé localement, rien n'est envoyé nulle part.
        </p>

        <div className="mb-4 p-3 rounded-xl border border-edge bg-base">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted leading-relaxed">
              Vérification optionnelle auprès de{" "}
              <span className="text-primary">Have I Been Pwned</span> : seuls les 5 premiers
              caractères du hash SHA-1 de chaque mot de passe sont envoyés (k-anonymat) — jamais
              le mot de passe, jamais le hash complet.
            </p>
            <button
              onClick={runPwned}
              disabled={!!pwnedProgress}
              className="shrink-0 text-xs px-3 py-2 rounded-lg bg-brand text-on-brand font-medium hover:bg-brand-hover transition-colors disabled:opacity-50"
            >
              {pwnedProgress ? `${pwnedProgress.done}/${pwnedProgress.total}…` : "Vérifier"}
            </button>
          </div>
          {pwnedError && <p className="text-xs text-signal-red mt-2">{pwnedError}</p>}
          {pwnedResults && <p className="text-xs text-signal-green mt-2">Vérification terminée.</p>}
        </div>

        <div className="overflow-y-auto space-y-2 -mx-1 px-1">
          {localProgress ? (
            <p className="text-sm text-muted text-center py-10">
              Analyse en cours… {localProgress.total > 1 ? `${localProgress.done}/${localProgress.total}` : ""}
            </p>
          ) : results.length === 0 ? (
            <p className="text-sm text-muted text-center py-10">Aucun problème détecté pour le moment. 🎉</p>
          ) : (
            results.map(({ item, reasons }) => (
              <button
                key={item.id}
                onClick={() => onOpenItem(item)}
                className="w-full text-left px-3 py-2.5 rounded-xl border border-edge bg-base hover:border-brand/50 transition-colors"
              >
                <p className="text-sm text-primary font-medium">{item.title}</p>
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {reasons.map((r) => (
                    <span key={r} className={`text-xs px-2 py-0.5 rounded-full ${reasonColor(r)}`}>
                      {r}
                    </span>
                  ))}
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function reasonColor(reason: string): string {
  if (reason.startsWith("Compromis") || reason === "Expiré") return "bg-signal-red/10 text-signal-red";
  if (reason.includes("faible") || reason.includes("Réutilisé")) return "bg-signal-red/10 text-signal-red";
  if (reason.includes("moyen") || reason.startsWith("Expire") || reason.includes("modifié")) return "bg-signal-amber/10 text-signal-amber";
  return "bg-surface-2 text-muted";
}
