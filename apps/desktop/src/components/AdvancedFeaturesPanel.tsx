import { useState } from "react";
import { useEscapeKey } from "../lib/useEscapeKey";
import {
  shamirApi,
  tempShareApi,
  steganographyApi,
  stringToBytes,
  base64ToBytes,
  bytesToBase64,
} from "../lib/advancedFeatures";
import { copySecretWithAutoClear } from "../lib/clipboard";
import { vaultApi } from "../lib/tauri";

interface Props {
  onClose: () => void;
  /** Si présent, le panneau s'ouvre directement sur l'onglet "Partage temporaire"
   * avec le secret de cette entrée pré-rempli (voir bouton "Partager" sur VaultItemCard). */
  prefill?: { label: string; secret: string } | null;
}

type Tab = "share" | "shamir" | "stego";

const TTL_OPTIONS = [
  { label: "15 minutes", seconds: 15 * 60 },
  { label: "1 heure", seconds: 60 * 60 },
  { label: "24 heures", seconds: 24 * 60 * 60 },
  { label: "7 jours", seconds: 7 * 24 * 60 * 60 },
];

export function AdvancedFeaturesPanel({ onClose, prefill }: Props) {
  useEscapeKey(onClose);
  const [tab, setTab] = useState<Tab>("share");

  return (
    <div className="fixed inset-0 bg-base/90 backdrop-blur-sm flex items-center justify-center px-6 z-40">
      <div className="max-w-lg w-full bg-surface border border-edge rounded-2xl p-7 max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between mb-1">
          <h2 className="font-display text-2xl font-medium text-primary">Fonctionnalités avancées</h2>
          <button onClick={onClose} className="text-muted hover:text-primary text-sm px-2 py-1">
            Fermer
          </button>
        </div>
        <p className="text-sm text-muted mb-5">Partage ponctuel de secrets, hors du fonctionnement habituel du coffre.</p>

        <div className="flex gap-1.5 mb-5 border-b border-edge">
          <TabButton active={tab === "share"} onClick={() => setTab("share")}>
            Partage temporaire
          </TabButton>
          <TabButton active={tab === "shamir"} onClick={() => setTab("shamir")}>
            Partage Shamir
          </TabButton>
          <TabButton active={tab === "stego"} onClick={() => setTab("stego")}>
            Stéganographie
          </TabButton>
        </div>

        <div className="overflow-y-auto -mx-1 px-1">
          {tab === "share" ? <TempShareTab prefill={prefill} /> : tab === "shamir" ? <ShamirTab prefill={prefill} /> : <StegoTab />}
        </div>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
        active ? "border-brand text-primary font-medium" : "border-transparent text-muted hover:text-primary"
      }`}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Partage temporaire (implémentation réelle : AES-256-GCM côté Rust)  */
/* ------------------------------------------------------------------ */

function TempShareTab({ prefill }: { prefill?: { label: string; secret: string } | null }) {
  const [secret, setSecret] = useState(prefill?.secret ?? "");
  const [ttlSeconds, setTtlSeconds] = useState(TTL_OPTIONS[1].seconds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const create = async () => {
    if (!secret) return;
    setBusy(true);
    setError(null);
    setShareUrl(null);
    try {
      const url = await tempShareApi.create(stringToBytes(secret), ttlSeconds);
      setShareUrl(url);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    if (!shareUrl) return;
    await copySecretWithAutoClear(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted leading-relaxed">
        Le secret est chiffré (AES-256-GCM) avec une clé aléatoire générée à la volée. Cette clé n'est présente que
        dans le lien lui-même (après le <code>#</code>) — jamais envoyée ni stockée côté serveur. Le lien expire et
        devient définitivement irrécupérable après la durée choisie, ou dès sa première lecture.
      </p>

      {prefill && (
        <p className="text-xs text-accent-strong bg-brand/10 border border-brand/30 rounded-lg px-3 py-2">
          Secret pré-rempli depuis « {prefill.label} ».
        </p>
      )}

      <div>
        <label className="text-xs text-muted block mb-1">Secret à partager</label>
        <textarea
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          rows={3}
          placeholder="Collez ou saisissez le contenu à partager…"
          className="w-full px-3 py-2 rounded-lg border border-edge bg-base text-sm text-primary outline-none focus:border-brand/50 resize-none font-mono"
        />
      </div>

      <div>
        <label className="text-xs text-muted block mb-1">Expire après</label>
        <div className="flex flex-wrap gap-1.5">
          {TTL_OPTIONS.map((opt) => (
            <button
              key={opt.seconds}
              onClick={() => setTtlSeconds(opt.seconds)}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                ttlSeconds === opt.seconds
                  ? "bg-accent/20 border-accent text-accent-strong"
                  : "border-edge text-muted hover:text-accent hover:border-brand/50"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="text-xs text-signal-red bg-signal-red/10 border border-signal-red/30 rounded-lg px-3 py-2">{error}</p>}

      <button
        onClick={create}
        disabled={busy || !secret}
        className="w-full px-4 py-2.5 rounded-lg bg-brand text-on-brand text-sm font-medium hover:bg-brand-hover transition-colors disabled:opacity-50"
      >
        {busy ? "Création…" : "Créer le lien de partage"}
      </button>

      {shareUrl && (
        <div className="bg-surface-2 p-3 rounded-lg border border-edge space-y-2">
          <p className="text-xs text-muted">Lien à usage unique :</p>
          <p className="text-xs break-all text-primary font-mono">{shareUrl}</p>
          <button
            onClick={copyLink}
            className="text-xs px-3 py-1.5 rounded-lg border border-edge text-accent hover:text-accent-strong hover:border-brand/50 transition-colors"
          >
            {copied ? "Copié ✓" : "Copier le lien"}
          </button>
          <p className="text-[11px] text-muted">
            Remplacez <code>votre-domaine.com</code> par le domaine où vous déployez la page de réception (voir
            src-tauri/src/features/sharing.rs) avant de partager un vrai lien.
          </p>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shamir Secret Sharing — implémentation réelle (crate `shamir` GF256) */
/* ------------------------------------------------------------------ */

function ShamirTab({ prefill }: { prefill?: { label: string; secret: string } | null }) {
  const [secret, setSecret] = useState(prefill?.secret ?? "");
  const [n, setN] = useState(3);
  const [k, setK] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shares, setShares] = useState<number[][] | null>(null);

  const [reconstructInput, setReconstructInput] = useState("");
  const [reconstructed, setReconstructed] = useState<string | null>(null);
  const [reconstructError, setReconstructError] = useState<string | null>(null);

  const generate = async () => {
    if (!secret) return;
    setBusy(true);
    setError(null);
    setShares(null);
    try {
      // L'API Rust prend directement le texte (kit de récupération).
      const result = await shamirApi.generateShares(secret, n, k);
      setShares(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const reconstruct = async () => {
    setReconstructError(null);
    setReconstructed(null);
    try {
      const parsedShares: number[][] = reconstructInput
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      // threshold = k : obligatoire pour l'interpolation de Lagrange.
      const recovered = await shamirApi.reconstructSecret(parsedShares, k);
      setReconstructed(recovered);
    } catch (e) {
      setReconstructError(String(e));
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted leading-relaxed">
        Fragmente un secret (typiquement le kit de récupération du coffre) en <strong>n</strong> parts dont{" "}
        <strong>k</strong> suffisent à le reconstituer. Basé sur le schéma de Shamir dans GF(256) : k−1 fragments
        ne révèlent rien du secret.
      </p>

      {prefill && (
        <p className="text-xs text-accent-strong bg-brand/10 border border-brand/30 rounded-lg px-3 py-2">
          Secret pré-rempli depuis « {prefill.label} ».
        </p>
      )}

      <div>
        <label className="text-xs text-muted block mb-1">Secret à fragmenter (ex : kit de récupération)</label>
        <textarea
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          rows={2}
          placeholder="Collez ici le kit de récupération ou un autre secret texte…"
          className="w-full px-3 py-2 rounded-lg border border-edge bg-base text-sm text-primary outline-none focus:border-brand/50 resize-none font-mono"
        />
      </div>

      <div className="flex gap-4">
        <div className="flex-1">
          <label className="text-xs text-muted block mb-1">Nombre total de fragments (n)</label>
          <input
            type="number"
            min={2}
            max={255}
            value={n}
            onChange={(e) => {
              const val = Math.max(2, Math.min(255, Number(e.target.value) || 2));
              setN(val);
              if (k > val) setK(val);
            }}
            className="w-full px-3 py-2 rounded-lg border border-edge bg-base text-sm text-primary outline-none focus:border-brand/50"
          />
        </div>
        <div className="flex-1">
          <label className="text-xs text-muted block mb-1">Seuil requis (k)</label>
          <input
            type="number"
            min={2}
            max={n}
            value={k}
            onChange={(e) => setK(Math.max(2, Math.min(n, Number(e.target.value) || 2)))}
            className="w-full px-3 py-2 rounded-lg border border-edge bg-base text-sm text-primary outline-none focus:border-brand/50"
          />
        </div>
      </div>

      <p className="text-xs text-signal-amber bg-signal-amber/10 border border-signal-amber/30 rounded-lg px-3 py-2">
        ⚠️ Notez soigneusement le seuil <strong>k = {k}</strong> — il est indispensable pour la reconstruction.
        Sans lui, vous ne pourrez pas retrouver le secret même en réunissant tous les fragments.
      </p>

      {error && <p className="text-xs text-signal-red bg-signal-red/10 border border-signal-red/30 rounded-lg px-3 py-2">{error}</p>}

      <button
        onClick={generate}
        disabled={busy || !secret}
        className="w-full px-4 py-2.5 rounded-lg bg-surface-2 border border-edge-strong text-primary text-sm font-medium hover:border-brand/50 transition-colors disabled:opacity-50"
      >
        {busy ? "Génération…" : `Générer ${n} fragments (seuil k = ${k})`}
      </button>

      {shares && (
        <div className="bg-surface-2 p-3 rounded-lg border border-edge space-y-1.5">
          <p className="text-xs text-muted">
            {shares.length} fragments générés — distribuez-les séparément (1 par ligne, format JSON) :
          </p>
          {shares.map((share, i) => (
            <pre key={i} className="text-[11px] overflow-x-auto text-primary font-mono bg-base rounded px-2 py-1">
              Fragment {i + 1} : {JSON.stringify(share)}
            </pre>
          ))}
        </div>
      )}

      <div className="pt-3 border-t border-edge space-y-2">
        <p className="text-xs text-muted font-medium">Reconstruire depuis des fragments</p>
        <label className="text-xs text-muted block mb-1">
          Collez au moins <strong>k</strong> fragments ci-dessous (1 par ligne, au format JSON) :
        </label>
        <textarea
          value={reconstructInput}
          onChange={(e) => setReconstructInput(e.target.value)}
          rows={3}
          placeholder={"[1,240,17,…]\n[2,83,192,…]"}
          className="w-full px-3 py-2 rounded-lg border border-edge bg-base text-sm text-primary outline-none focus:border-brand/50 resize-none font-mono"
        />
        <div className="flex gap-2 items-center">
          <label className="text-xs text-muted shrink-0">Seuil k utilisé lors de la génération :</label>
          <input
            type="number"
            min={2}
            value={k}
            onChange={(e) => setK(Math.max(2, Number(e.target.value) || 2))}
            className="w-20 px-2 py-1 rounded-lg border border-edge bg-base text-sm text-primary outline-none focus:border-brand/50"
          />
        </div>
        <button
          onClick={reconstruct}
          disabled={!reconstructInput.trim()}
          className="w-full px-4 py-2 rounded-lg border border-edge-strong text-sm text-primary hover:border-brand/50 transition-colors disabled:opacity-50"
        >
          Reconstruire le secret
        </button>
        {reconstructError && (
          <p className="text-xs text-signal-red bg-signal-red/10 border border-signal-red/30 rounded-lg px-3 py-2">{reconstructError}</p>
        )}
        {reconstructed !== null && (
          <p className="text-xs bg-base border border-edge rounded-lg px-3 py-2 font-mono break-all">{reconstructed}</p>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Stéganographie LSB — implémentation réelle côté Rust                */
/* ------------------------------------------------------------------ */

function StegoTab() {
  return (
    <div className="space-y-6">
      <p className="text-xs text-muted leading-relaxed">
        Cache les octets du coffre (déjà chiffré) dans les bits de poids faible des pixels d'une image PNG. La
        stéganographie masque la <em>présence</em> des données, mais ne les chiffre pas en elle-même — c'est le
        chiffrement du coffre lui-même qui protège leur contenu si l'image est découverte.
      </p>
      <StegoEmbedSection />
      <div className="border-t border-edge" />
      <StegoExtractSection />
    </div>
  );
}

function StegoEmbedSection() {
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [vaultBytes, setVaultBytes] = useState<number[] | null>(null); // gardé pour embed()
  const [carrierPath, setCarrierPath] = useState<string | null>(null);
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const exportVault = async () => {
    setError(null);
    const dest = await vaultApi.pickBackupDestination();
    if (!dest) return;
    setBusy(true);
    try {
      await vaultApi.exportBackup(dest);
      const b64 = await vaultApi.readBinaryFile(dest);
      const bytes = base64ToBytes(b64);
      setVaultPath(dest);
      setVaultBytes(bytes);
      setDone(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const pickCarrier = async () => {
    const path = await vaultApi.pickCarrierImage();
    if (path) {
      setCarrierPath(path);
      setDone(false);
    }
  };

  const embed = async () => {
    if (!vaultBytes || !carrierPath) return;
    setError(null);
    const dest = await vaultApi.pickStegoOutputDestination();
    if (!dest) return;
    setBusy(true);
    try {
      await steganographyApi.embed(carrierPath, vaultBytes, dest);
      setOutputPath(dest);
      setDone(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-primary">Cacher le coffre dans une image</h3>

      <StepRow
        done={!!vaultBytes}
        label={vaultPath ? `Coffre exporté : ${vaultPath}` : "1. Exporter le coffre actuel (déjà chiffré)"}
        onClick={exportVault}
        busy={busy}
      />
      <StepRow
        done={!!carrierPath}
        label={carrierPath ? `Image porteuse : ${carrierPath}` : "2. Choisir une image porteuse"}
        onClick={pickCarrier}
        disabled={!vaultBytes}
      />

      {error && <p className="text-xs text-signal-red bg-signal-red/10 border border-signal-red/30 rounded-lg px-3 py-2">{error}</p>}

      <button
        onClick={embed}
        disabled={busy || !vaultBytes || !carrierPath}
        className="w-full px-4 py-2.5 rounded-lg bg-brand text-on-brand text-sm font-medium hover:bg-brand-hover transition-colors disabled:opacity-50"
      >
        {busy ? "En cours…" : "3. Cacher le coffre dans l'image"}
      </button>

      {done && outputPath && (
        <div className="bg-surface-2 p-3 rounded-lg border border-edge space-y-2">
          <p className="text-xs text-accent-strong">✓ Image créée : {outputPath}</p>
          <p className="text-xs text-muted leading-relaxed">
            La longueur du coffre est encodée automatiquement dans l'image — aucune valeur à noter. Pour extraire,
            il suffit de sélectionner l'image dans la section « Extraire » ci-dessous.
          </p>
        </div>
      )}
    </div>
  );
}

function StegoExtractSection() {
  const [imagePath, setImagePath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoredPath, setRestoredPath] = useState<string | null>(null);

  const pickImage = async () => {
    const path = await vaultApi.pickStegoImageToExtract();
    if (path) {
      setImagePath(path);
      setRestoredPath(null);
      setError(null);
    }
  };

  const extract = async () => {
    if (!imagePath) return;
    setError(null);
    const dest = await vaultApi.pickStegoExtractDestination();
    if (!dest) return;
    setBusy(true);
    try {
      // La longueur est auto-détectée depuis les 4 octets d'en-tête encodés
      // dans l'image — plus besoin de la connaître à l'avance.
      const bytes = await steganographyApi.extract(imagePath);
      await vaultApi.writeBinaryFile(dest, bytesToBase64(bytes));
      setRestoredPath(dest);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-primary">Extraire un coffre caché depuis une image</h3>

      <StepRow
        done={!!imagePath}
        label={imagePath ? `Image : ${imagePath}` : "1. Choisir l'image contenant le coffre caché"}
        onClick={pickImage}
      />

      {error && <p className="text-xs text-signal-red bg-signal-red/10 border border-signal-red/30 rounded-lg px-3 py-2">{error}</p>}

      <button
        onClick={extract}
        disabled={busy || !imagePath}
        className="w-full px-4 py-2.5 rounded-lg border border-edge-strong text-primary text-sm font-medium hover:border-brand/50 transition-colors disabled:opacity-50"
      >
        {busy ? "Extraction…" : "2. Extraire et restaurer le fichier .vault"}
      </button>

      {restoredPath && (
        <p className="text-xs text-accent-strong bg-brand/10 border border-brand/30 rounded-lg px-3 py-2">
          Coffre restauré : {restoredPath} — déverrouillez-le via « J'ai déjà un fichier .vault » depuis l'écran d'accueil.
        </p>
      )}
    </div>
  );
}

function StepRow({
  done,
  label,
  onClick,
  disabled,
  busy,
}: {
  done: boolean;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      className={`w-full text-left px-3 py-2 rounded-lg border text-xs flex items-center gap-2 transition-colors disabled:opacity-50 ${
        done ? "border-brand/40 bg-brand/10 text-accent-strong" : "border-edge text-muted hover:border-brand/50 hover:text-primary"
      }`}
    >
      <span className={`shrink-0 w-4 h-4 rounded-full border flex items-center justify-center text-[10px] ${done ? "border-brand bg-brand text-on-brand" : "border-edge-strong"}`}>
        {done ? "✓" : ""}
      </span>
      <span className="truncate">{busy ? "…" : label}</span>
    </button>
  );
}
