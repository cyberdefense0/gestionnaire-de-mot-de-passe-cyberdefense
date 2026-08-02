import { useEffect, useState, type ReactNode, type ChangeEvent } from "react";
import type { VaultItem, GeneratorOptions, ItemType, CustomField, CustomFieldType, Attachment, PasswordHistoryEntry } from "../types";
import { DEFAULT_GENERATOR_OPTIONS } from "../types";
import { generatePassword } from "../lib/passwordGenerator";
import { generateMemorablePassphrase, DEFAULT_PASSPHRASE_OPTIONS, type PassphraseOptions } from "../lib/passphraseGenerator";
import { analyzeStrength, type StrengthLabel } from "../lib/passwordStrength";
import { computeTotp } from "../lib/totp";
import { useEscapeKey } from "../lib/useEscapeKey";

type Draft = Omit<VaultItem, "id" | "created_at" | "updated_at" | "password_history" | "last_used_at">;

interface Props {
  initial?: VaultItem;
  categories: string[];
  defaultCategory?: string;
  onCancel: () => void;
  onSave: (draft: Draft) => void;
}

const NEW_ALBUM_VALUE = "__new_album__";
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024; // 3 Mo, doit rester cohérent avec src-tauri/src/lib.rs

const CUSTOM_FIELD_TYPES: { value: CustomFieldType; label: string }[] = [
  { value: "text", label: "Texte" },
  { value: "password", label: "Mot de passe" },
  { value: "email", label: "Email" },
  { value: "url", label: "URL" },
  { value: "totp", label: "Code 2FA (TOTP)" },
];

export function VaultItemForm({ initial, categories, defaultCategory, onCancel, onSave }: Props) {
  const [itemType, setItemType] = useState<ItemType>(initial?.item_type ?? "password");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [username, setUsername] = useState(initial?.username ?? "");
  const [password, setPassword] = useState(initial?.password ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [category, setCategory] = useState(initial?.category ?? defaultCategory ?? categories[0] ?? "Général");
  const [tags, setTags] = useState<string[]>(initial?.tags ?? []);
  const [tagInput, setTagInput] = useState("");
  const [favorite, setFavorite] = useState(initial?.favorite ?? false);
  const [expiresAt, setExpiresAt] = useState(initial?.expires_at ?? "");
  const [customFields, setCustomFields] = useState<CustomField[]>(initial?.custom_fields ?? []);
  const [attachments, setAttachments] = useState<Attachment[]>(initial?.attachments ?? []);
  const [creatingAlbum, setCreatingAlbum] = useState(false);
  const [newAlbumName, setNewAlbumName] = useState("");
  const [showGenerator, setShowGenerator] = useState(false);
  const [genOpts, setGenOpts] = useState<GeneratorOptions>(DEFAULT_GENERATOR_OPTIONS);
  const [generatorMode, setGeneratorMode] = useState<"random" | "passphrase">("random");
  const [passphraseOpts, setPassphraseOpts] = useState<PassphraseOptions>(DEFAULT_PASSPHRASE_OPTIONS);
  const [reveal, setReveal] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);

  useEscapeKey(onCancel);

  const isNote = itemType === "note";
  const isEditing = !!initial;

  // Le calcul de force (zxcvbn) est coûteux et croît vite avec la longueur
  // (~800ms pour 48 caractères, mesuré). Il NE DOIT PAS tourner dans le
  // corps du composant : ça le rejouerait à chaque re-render (taper un
  // tag, cocher une case, bouger le curseur de longueur...), pas seulement
  // quand le mot de passe change réellement — c'était le bug. Ici : un
  // effet dédié, débouncé (250ms), avec un id de requête pour ignorer un
  // résultat qui arriverait après un changement plus récent du mot de
  // passe (évite d'afficher un résultat obsolète si on tape/génère vite).
  const [strength, setStrength] = useState<{ label: StrengthLabel; crackTimeDisplay: string } | null>(null);
  const [strengthPending, setStrengthPending] = useState(false);
  useEffect(() => {
    if (isNote || !password) {
      setStrength(null);
      setStrengthPending(false);
      return;
    }
    let cancelled = false;
    setStrengthPending(true);
    const handle = setTimeout(() => {
      const result = analyzeStrength(password);
      if (!cancelled) {
        setStrength({ label: result.label, crackTimeDisplay: result.crackTimeDisplay });
        setStrengthPending(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [password, isNote]);

  const regenerate = () =>
    setPassword(generatorMode === "passphrase" ? generateMemorablePassphrase(passphraseOpts) : generatePassword(genOpts));

  const handleCategoryChange = (value: string) => {
    if (value === NEW_ALBUM_VALUE) {
      setCreatingAlbum(true);
      return;
    }
    setCategory(value);
  };

  const confirmNewAlbum = () => {
    const name = newAlbumName.trim();
    if (!name) {
      setCreatingAlbum(false);
      return;
    }
    setCategory(name);
    setCreatingAlbum(false);
    setNewAlbumName("");
  };

  const addCustomField = () => {
    setCustomFields((prev) => [...prev, { id: crypto.randomUUID(), label: "", value: "", field_type: "text" }]);
  };
  const updateCustomField = (id: string, patch: Partial<CustomField>) => {
    setCustomFields((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  };
  const removeCustomField = (id: string) => {
    setCustomFields((prev) => prev.filter((f) => f.id !== id));
  };

  const handleFilePick = async (e: ChangeEvent<HTMLInputElement>) => {
    setAttachError(null);
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setAttachError(`« ${file.name} » dépasse la limite de ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} Mo.`);
      return;
    }
    const base64 = await fileToBase64(file);
    setAttachments((prev) => [...prev, { id: crypto.randomUUID(), filename: file.name, mime: file.type || "application/octet-stream", data_base64: base64 }]);
  };

  const removeAttachment = (id: string) => setAttachments((prev) => prev.filter((a) => a.id !== id));

  const addTag = () => {
    const value = tagInput.trim();
    setTagInput("");
    if (!value) return;
    setTags((prev) => (prev.includes(value) ? prev : [...prev, value]));
  };
  const removeTag = (value: string) => setTags((prev) => prev.filter((t) => t !== value));

  const submit = () => {
    if (!title.trim()) return;
    onSave({
      item_type: itemType,
      title: title.trim(),
      username: isNote ? "" : username,
      password: isNote ? "" : password,
      url: isNote ? "" : url,
      notes,
      category,
      tags,
      favorite,
      expires_at: isNote ? "" : expiresAt,
      custom_fields: customFields.filter((f) => f.label.trim() || f.value.trim()),
      attachments,
    });
  };

  return (
    <div className="fixed inset-0 bg-base/90 backdrop-blur-sm flex items-center justify-center px-6 z-40 overflow-y-auto py-10">
      <div className="max-w-lg w-full bg-surface border border-edge rounded-2xl p-7">
        <div className="flex items-start justify-between mb-2">
          <h2 className="font-display text-2xl font-medium text-primary">
            {initial ? "Modifier l'entrée" : "Nouvelle entrée"}
          </h2>
          <button
            type="button"
            onClick={() => setFavorite(!favorite)}
            title={favorite ? "Retirer des favoris" : "Ajouter aux favoris"}
            className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${favorite ? "text-signal-amber" : "text-muted hover:text-signal-amber"}`}
          >
            <StarIcon filled={favorite} />
          </button>
        </div>

        {!isEditing && (
          <div className="flex gap-2 mb-6 p-1 rounded-xl bg-base border border-edge">
            <TypeTab active={itemType === "password"} onClick={() => setItemType("password")}>
              🔑 Mot de passe
            </TypeTab>
            <TypeTab active={itemType === "note"} onClick={() => setItemType("note")}>
              📝 Note sécurisée
            </TypeTab>
          </div>
        )}
        {isEditing && <div className="mb-4" />}

        <div className="space-y-4">
          <Field label="Titre">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={isNote ? "ex: Codes de secours 2FA" : "ex: Gmail personnel"}
              className="input"
              autoFocus
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            {!isNote && (
              <Field label="Identifiant">
                <input value={username} onChange={(e) => setUsername(e.target.value)} className="input" />
              </Field>
            )}
            <Field label="Album" full={isNote}>
              {creatingAlbum ? (
                <div className="flex gap-2">
                  <input
                    autoFocus
                    value={newAlbumName}
                    onChange={(e) => setNewAlbumName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && confirmNewAlbum()}
                    placeholder="Nom de l'album"
                    className="input"
                  />
                  <button type="button" onClick={confirmNewAlbum} className="px-3 rounded-xl border border-edge text-sm text-accent hover:border-brand/50 transition-colors">
                    OK
                  </button>
                </div>
              ) : (
                <select value={category} onChange={(e) => handleCategoryChange(e.target.value)} className="input">
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                  {!categories.includes(category) && <option value={category}>{category}</option>}
                  <option value={NEW_ALBUM_VALUE}>+ Nouvel album…</option>
                </select>
              )}
            </Field>
          </div>

          {!isNote && (
            <Field label="Mot de passe">
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <input
                    type={reveal ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="input pr-10 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setReveal(!reveal)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted hover:text-accent-strong"
                  >
                    {reveal ? "Masquer" : "Voir"}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setShowGenerator(!showGenerator)}
                  className="px-3 rounded-xl border border-edge text-sm text-accent hover:border-brand/50 transition-colors"
                >
                  Générer
                </button>
              </div>
              {strengthPending && <p className="text-xs mt-1.5 text-muted">Calcul de la force…</p>}
              {!strengthPending && strength && (
                <p className={`text-xs mt-1.5 ${strengthColor(strength.label)}`}>
                  Force : {strength.label} — {strength.crackTimeDisplay}
                </p>
              )}
            </Field>
          )}

          {!isNote && isEditing && initial && initial.password_history.length > 0 && (
            <PasswordHistoryList history={initial.password_history} />
          )}

          {!isNote && showGenerator && (
            <div className="bg-base border border-edge rounded-xl p-4 space-y-3">
              <div className="flex gap-1 p-1 rounded-lg bg-surface-2">
                <button
                  type="button"
                  onClick={() => setGeneratorMode("random")}
                  className={`flex-1 text-xs py-1.5 rounded-md transition-colors ${
                    generatorMode === "random" ? "bg-surface text-primary shadow-sm" : "text-muted"
                  }`}
                >
                  Aléatoire
                </button>
                <button
                  type="button"
                  onClick={() => setGeneratorMode("passphrase")}
                  className={`flex-1 text-xs py-1.5 rounded-md transition-colors ${
                    generatorMode === "passphrase" ? "bg-surface text-primary shadow-sm" : "text-muted"
                  }`}
                >
                  Phrase de passe
                </button>
              </div>

              {generatorMode === "random" ? (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted">Longueur</span>
                    <span className="text-xs text-primary font-mono">{genOpts.length}</span>
                  </div>
                  <input
                    type="range"
                    min={8}
                    max={48}
                    value={genOpts.length}
                    onChange={(e) => setGenOpts({ ...genOpts, length: Number(e.target.value) })}
                    className="w-full accent-brand"
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <Toggle label="Majuscules" checked={genOpts.uppercase} onChange={(v) => setGenOpts({ ...genOpts, uppercase: v })} />
                    <Toggle label="Minuscules" checked={genOpts.lowercase} onChange={(v) => setGenOpts({ ...genOpts, lowercase: v })} />
                    <Toggle label="Chiffres" checked={genOpts.numbers} onChange={(v) => setGenOpts({ ...genOpts, numbers: v })} />
                    <Toggle label="Symboles" checked={genOpts.symbols} onChange={(v) => setGenOpts({ ...genOpts, symbols: v })} />
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted">Nombre de mots</span>
                    <span className="text-xs text-primary font-mono">{passphraseOpts.wordCount}</span>
                  </div>
                  <input
                    type="range"
                    min={3}
                    max={10}
                    value={passphraseOpts.wordCount}
                    onChange={(e) => setPassphraseOpts({ ...passphraseOpts, wordCount: Number(e.target.value) })}
                    className="w-full accent-brand"
                  />
                  <p className="text-xs text-muted">
                    Mots tirés de la liste EFF (référence sécurité, ~7 776 mots en anglais — plus faciles à retenir/retaper à la main qu'une suite de caractères aléatoires).
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <Toggle
                      label="Majuscule initiale"
                      checked={passphraseOpts.capitalize}
                      onChange={(v) => setPassphraseOpts({ ...passphraseOpts, capitalize: v })}
                    />
                    <Toggle
                      label="Ajouter un chiffre"
                      checked={passphraseOpts.includeNumber}
                      onChange={(v) => setPassphraseOpts({ ...passphraseOpts, includeNumber: v })}
                    />
                  </div>
                  <div>
                    <span className="text-xs text-muted block mb-1.5">Séparateur</span>
                    <div className="flex gap-1.5">
                      {["-", "_", ".", " "].map((sep) => (
                        <button
                          type="button"
                          key={sep}
                          onClick={() => setPassphraseOpts({ ...passphraseOpts, separator: sep })}
                          className={`flex-1 text-xs py-1.5 rounded-lg border font-mono transition-colors ${
                            passphraseOpts.separator === sep
                              ? "border-brand bg-brand/10 text-accent-strong"
                              : "border-edge text-muted hover:border-edge-strong"
                          }`}
                        >
                          {sep === " " ? "espace" : sep}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}

              <button
                onClick={regenerate}
                className="w-full py-2 rounded-lg bg-brand/10 border border-brand/30 text-accent text-sm hover:bg-brand/20 transition-colors"
              >
                Régénérer
              </button>
            </div>
          )}

          {!isNote && (
            <div className="grid grid-cols-2 gap-4">
              <Field label="URL">
                <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" className="input" />
              </Field>
              <Field label="Expiration (optionnel)">
                <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className="input" />
              </Field>
            </div>
          )}

          <Field label={isNote ? "Contenu" : "Notes"}>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={isNote ? 8 : 3}
              placeholder={isNote ? "Le texte de votre note, chiffré comme le reste du coffre…" : undefined}
              className="input resize-none font-mono text-[13px]"
            />
          </Field>

          {/* Tags libres, multiples — indépendants de l'album (classement exclusif) */}
          <Field label="Tags">
            <div className="flex flex-wrap gap-1.5 mb-2">
              {tags.map((t) => (
                <span key={t} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-brand/10 border border-brand/30 text-accent text-xs">
                  {t}
                  <button type="button" onClick={() => removeTag(t)} className="hover:text-signal-red">
                    ✕
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    addTag();
                  }
                }}
                placeholder="ex: pro, urgent… (Entrée pour ajouter)"
                className="input"
              />
              <button type="button" onClick={addTag} className="px-3 rounded-xl border border-edge text-sm text-accent hover:border-brand/50 transition-colors">
                Ajouter
              </button>
            </div>
          </Field>

          {/* Champs personnalisés */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs uppercase tracking-wider text-muted">Champs personnalisés</label>
              <button type="button" onClick={addCustomField} className="text-xs text-accent hover:text-accent-strong transition-colors">
                + Ajouter
              </button>
            </div>
            <div className="space-y-2">
              {customFields.map((field) => (
                <CustomFieldRow
                  key={field.id}
                  field={field}
                  onChange={(patch) => updateCustomField(field.id, patch)}
                  onRemove={() => removeCustomField(field.id)}
                />
              ))}
            </div>
          </div>

          {/* Pièces jointes */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs uppercase tracking-wider text-muted">
                Pièces jointes <span className="normal-case text-muted/70">(max {MAX_ATTACHMENT_BYTES / (1024 * 1024)} Mo)</span>
              </label>
              <label className="text-xs text-accent hover:text-accent-strong transition-colors cursor-pointer">
                + Ajouter
                <input type="file" onChange={handleFilePick} className="hidden" />
              </label>
            </div>
            {attachError && <p className="text-xs text-signal-red mb-2">{attachError}</p>}
            {attachments.length > 0 && (
              <div className="space-y-1.5">
                {attachments.map((a) => (
                  <div key={a.id} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-edge bg-base text-sm">
                    <span className="flex-1 truncate text-primary">{a.filename}</span>
                    <span className="text-xs text-muted shrink-0">{formatBytes(a.data_base64.length * 0.75)}</span>
                    <button type="button" onClick={() => removeAttachment(a.id)} className="text-xs text-muted hover:text-signal-red shrink-0">
                      Retirer
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex gap-3 mt-7">
          <button onClick={onCancel} className="flex-1 py-2.5 rounded-xl border border-edge text-sm text-muted hover:text-primary transition-colors">
            Annuler
          </button>
          <button onClick={submit} className="flex-1 py-2.5 rounded-xl bg-brand text-on-brand text-sm font-medium hover:bg-brand-hover transition-colors">
            Enregistrer
          </button>
        </div>
      </div>

      <style>{`
        .input {
          width: 100%;
          padding: 0.65rem 1rem;
          border-radius: 0.75rem;
          border: 1px solid rgb(var(--color-edge));
          background: rgb(var(--color-base));
          color: rgb(var(--color-primary));
          font-size: 0.875rem;
          outline: none;
        }
        .input:focus { border-color: rgb(var(--color-brand) / 0.5); }
      `}</style>
    </div>
  );
}

function CustomFieldRow({
  field,
  onChange,
  onRemove,
}: {
  field: CustomField;
  onChange: (patch: Partial<CustomField>) => void;
  onRemove: () => void;
}) {
  const [reveal, setReveal] = useState(false);
  const [totp, setTotp] = useState<string | null>(null);

  useEffect(() => {
    if (field.field_type !== "totp" || !field.value) {
      setTotp(null);
      return;
    }
    let cancelled = false;
    const tick = () => {
      computeTotp(field.value).then((res) => {
        if (!cancelled) setTotp(res ? `${res.code} (${res.remainingSeconds}s)` : "secret invalide");
      });
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [field.field_type, field.value]);

  const isSecret = field.field_type === "password" || field.field_type === "totp";

  return (
    <div className="flex gap-2 items-start">
      <select
        value={field.field_type}
        onChange={(e) => onChange({ field_type: e.target.value as CustomFieldType })}
        className="input w-32 shrink-0 text-xs"
      >
        {CUSTOM_FIELD_TYPES.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>
      <input
        value={field.label}
        onChange={(e) => onChange({ label: e.target.value })}
        placeholder="Nom du champ"
        className="input flex-1"
      />
      <div className="relative flex-1">
        <input
          type={isSecret && !reveal ? "password" : "text"}
          value={field.value}
          onChange={(e) => onChange({ value: e.target.value })}
          placeholder={field.field_type === "totp" ? "Secret TOTP (base32)" : "Valeur"}
          className="input font-mono pr-9"
        />
        {isSecret && (
          <button
            type="button"
            onClick={() => setReveal(!reveal)}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted hover:text-accent-strong"
          >
            {reveal ? "🙈" : "👁"}
          </button>
        )}
      </div>
      <button type="button" onClick={onRemove} className="w-8 h-8 shrink-0 rounded-lg text-muted hover:text-signal-red hover:bg-base transition-colors">
        ✕
      </button>
      {totp && <p className="w-full text-xs text-accent font-mono -mt-1">Code actuel : {totp}</p>}
    </div>
  );
}

function PasswordHistoryList({ history }: { history: PasswordHistoryEntry[] }) {
  const [revealedId, setRevealedId] = useState<number | null>(null);
  // Plus récent en premier ; `password_history` est stocké plus ancien -> plus récent côté Rust.
  const ordered = [...history].reverse();

  return (
    <div className="bg-base border border-edge rounded-xl p-3">
      <p className="text-xs uppercase tracking-wider text-muted mb-2">
        Historique des mots de passe <span className="normal-case text-muted/70">({history.length})</span>
      </p>
      <div className="space-y-1.5 max-h-40 overflow-y-auto">
        {ordered.map((entry, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <code className="flex-1 font-mono text-muted truncate">
              {revealedId === i ? entry.password : "•".repeat(Math.min(entry.password.length, 16))}
            </code>
            <button
              type="button"
              onClick={() => setRevealedId(revealedId === i ? null : i)}
              className="text-muted hover:text-accent-strong shrink-0"
            >
              {revealedId === i ? "🙈" : "👁"}
            </button>
            <span className="text-muted/70 shrink-0">{formatHistoryDate(entry.changed_at)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatHistoryDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
  } catch {
    return iso;
  }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1] ?? "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

function Field({ label, children, full }: { label: string; children: ReactNode; full?: boolean }) {
  return (
    <div className={full ? "col-span-2" : undefined}>
      <label className="text-xs uppercase tracking-wider text-muted mb-1.5 block">{label}</label>
      {children}
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs text-muted cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-brand" />
      {label}
    </label>
  );
}

function TypeTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
        active ? "bg-brand text-on-brand" : "text-muted hover:text-primary"
      }`}
    >
      {children}
    </button>
  );
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8">
      <path d="M12 2.5l2.9 6.5 7 .7-5.3 4.7 1.6 6.9-6.2-3.7-6.2 3.7 1.6-6.9L2.1 9.7l7-.7Z" />
    </svg>
  );
}

function strengthColor(s: string) {
  switch (s) {
    case "faible":
      return "text-signal-red";
    case "moyen":
      return "text-signal-amber";
    default:
      return "text-signal-green";
  }
}
