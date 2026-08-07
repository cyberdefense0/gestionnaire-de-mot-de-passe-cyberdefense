import { useEffect, useState, type ReactNode, type ChangeEvent } from "react";
import type { VaultItem, GeneratorOptions, ItemType, CustomField, CustomFieldType, Attachment, PasswordHistoryEntry } from "../types";
import { DEFAULT_GENERATOR_OPTIONS } from "../types";
import { generatePassword } from "../lib/passwordGenerator";
import { generateMemorablePassphrase, DEFAULT_PASSPHRASE_OPTIONS, type PassphraseOptions } from "../lib/passphraseGenerator";
import { analyzeStrengthAsync, type StrengthLabel } from "../lib/passwordStrength";
import { computeTotp, extractTotpSecret, type TotpCode } from "../lib/totp";
import { copySecretWithAutoClear } from "../lib/clipboard";
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

const PASSKEY_ALGORITHMS = ["ES256", "RS256", "EdDSA", "Autre"];

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
  // Champs personnalisés pas encore "validés" (type + nom en cours de saisie,
  // pas encore de champ valeur affiché). Vide pour une entrée existante :
  // ses champs sont déjà nommés, ils s'affichent directement en mode confirmé.
  const [draftFieldIds, setDraftFieldIds] = useState<Set<string>>(new Set());
  const [attachments, setAttachments] = useState<Attachment[]>(initial?.attachments ?? []);
  const [creatingAlbum, setCreatingAlbum] = useState(false);
  const [newAlbumName, setNewAlbumName] = useState("");
  const [showGenerator, setShowGenerator] = useState(false);
  const [genOpts, setGenOpts] = useState<GeneratorOptions>(() =>
    initial?.generation_rule
      ? {
          length: initial.generation_rule.length || DEFAULT_GENERATOR_OPTIONS.length,
          uppercase: initial.generation_rule.uppercase,
          lowercase: initial.generation_rule.lowercase,
          numbers: initial.generation_rule.numbers,
          symbols: initial.generation_rule.symbols,
          alphanumeric_only: initial.generation_rule.alphanumeric_only,
          exclude_chars: initial.generation_rule.exclude_chars,
        }
      : DEFAULT_GENERATOR_OPTIONS
  );
  const [generatorMode, setGeneratorMode] = useState<"random" | "passphrase">("random");
  const [passphraseOpts, setPassphraseOpts] = useState<PassphraseOptions>(DEFAULT_PASSPHRASE_OPTIONS);
  const [reveal, setReveal] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);

  // --- Passkey (FIDO2/WebAuthn) — métadonnées publiques uniquement, voir
  // types.ts::PasskeyData. Cette app ne réalise aucune cérémonie WebAuthn ni
  // intégration d'autofill : ces champs servent à inventorier/consulter une
  // passkey déjà créée ailleurs (typiquement, plus tard, via l'extension
  // navigateur), ou saisie manuellement pour archive.
  const [pkCredentialId, setPkCredentialId] = useState(initial?.passkey?.credential_id ?? "");
  const [pkRpId, setPkRpId] = useState(initial?.passkey?.rp_id ?? "");
  const [pkRpName, setPkRpName] = useState(initial?.passkey?.rp_name ?? "");
  const [pkUserHandle, setPkUserHandle] = useState(initial?.passkey?.user_handle ?? "");
  const [pkPublicKey, setPkPublicKey] = useState(initial?.passkey?.public_key ?? "");
  const [pkAlgorithm, setPkAlgorithm] = useState(initial?.passkey?.algorithm || "ES256");
  const [showPasskeyAdvanced, setShowPasskeyAdvanced] = useState(false);

  // --- Règle de génération mémorisée par entrée (roadmap §3.2). Si l'entrée
  // en a déjà une, on la précharge dans le générateur pour que "Régénérer"
  // la respecte immédiatement sans reconfigurer les toggles à chaque fois.
  const [rememberRule, setRememberRule] = useState(!!initial?.generation_rule);

  useEscapeKey(onCancel);

  const isNote = itemType === "note";
  const isPasskey = itemType === "passkey";
  const isPassword = itemType === "password";
  const isEditing = !!initial;

  // Le calcul de force (zxcvbn) est coûteux et croît vite avec la longueur
  // (~800ms pour 48 caractères, mesuré). Il tourne désormais entièrement
  // dans un Web Worker dédié (`lib/passwordStrength.worker.ts` — voir
  // roadmap README §2.1), donc plus JAMAIS sur ce thread, même pas
  // brièvement : ce composant ne fait qu'envoyer la requête et attendre.
  // Le debounce (250ms) reste utile pour éviter de spammer le worker à
  // chaque frappe, pas pour protéger le rendu (qui ne bloque plus).
  const [strength, setStrength] = useState<{ label: StrengthLabel; crackTimeDisplay: string } | null>(null);
  const [strengthPending, setStrengthPending] = useState(false);
  useEffect(() => {
    if (isNote || itemType === "passkey" || !password) {
      setStrength(null);
      setStrengthPending(false);
      return;
    }
    let cancelled = false;
    setStrengthPending(true);
    const handle = setTimeout(() => {
      analyzeStrengthAsync(password).then((result) => {
        if (!cancelled) {
          setStrength({ label: result.label, crackTimeDisplay: result.crackTimeDisplay });
          setStrengthPending(false);
        }
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [password, isNote, itemType]);

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
    const id = crypto.randomUUID();
    setCustomFields((prev) => [...prev, { id, label: "", value: "", field_type: "text" }]);
    // Nouveau champ : passe d'abord par l'étape "type + nom", avant de
    // pouvoir saisir une valeur (voir CustomFieldRow ci-dessous).
    setDraftFieldIds((prev) => new Set(prev).add(id));
  };
  const updateCustomField = (id: string, patch: Partial<CustomField>) => {
    setCustomFields((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  };
  const removeCustomField = (id: string) => {
    setCustomFields((prev) => prev.filter((f) => f.id !== id));
    setDraftFieldIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };
  const confirmCustomField = (id: string) => {
    setDraftFieldIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
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
      password: isPassword ? password : "",
      url: isNote ? "" : url,
      notes,
      category,
      tags,
      favorite,
      expires_at: isNote ? "" : expiresAt,
      // Un champ jamais "validé" (étape type+nom abandonnée en cours de
      // route) ne doit pas être persisté silencieusement.
      custom_fields: customFields.filter((f) => !draftFieldIds.has(f.id) && (f.label.trim() || f.value.trim())),
      attachments,
      passkey: isPasskey
        ? {
            credential_id: pkCredentialId.trim(),
            rp_id: pkRpId.trim(),
            rp_name: pkRpName.trim(),
            user_handle: pkUserHandle.trim(),
            public_key: pkPublicKey.trim(),
            algorithm: pkAlgorithm,
          }
        : null,
      generation_rule:
        isPassword && rememberRule
          ? {
              length: genOpts.length,
              uppercase: genOpts.uppercase,
              lowercase: genOpts.lowercase,
              numbers: genOpts.numbers,
              symbols: genOpts.symbols,
              alphanumeric_only: genOpts.alphanumeric_only,
              exclude_chars: genOpts.exclude_chars,
            }
          : null,
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

          {isPassword && (
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

          {isPassword && isEditing && initial && initial.password_history.length > 0 && (
            <PasswordHistoryList history={initial.password_history} />
          )}

          {isPassword && showGenerator && (
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
                    max={128}
                    step={8}
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

                  {/* Règles avancées par site (roadmap §3.2) : certains formulaires
                      (ex: bancaires) rejettent la ponctuation ou des caractères
                      précis. */}
                  <div className="pt-2 border-t border-edge space-y-2">
                    <Toggle
                      label="Alphanumérique uniquement (sans symboles)"
                      checked={genOpts.alphanumeric_only}
                      onChange={(v) => setGenOpts({ ...genOpts, alphanumeric_only: v })}
                    />
                    <div>
                      <span className="text-xs text-muted block mb-1">Caractères à exclure</span>
                      <input
                        value={genOpts.exclude_chars}
                        onChange={(e) => setGenOpts({ ...genOpts, exclude_chars: e.target.value })}
                        placeholder='ex: l1IO0 ou des symboles refusés par ce site'
                        className="input font-mono text-xs"
                      />
                    </div>
                    <label className="flex items-center gap-2 text-xs text-muted cursor-pointer">
                      <input
                        type="checkbox"
                        checked={rememberRule}
                        onChange={(e) => setRememberRule(e.target.checked)}
                        className="accent-brand"
                      />
                      Mémoriser cette règle pour cette entrée (réutilisée à chaque régénération)
                    </label>
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

          {isPasskey && (
            <div className="bg-base border border-edge rounded-xl p-4 space-y-3">
              <p className="text-xs text-muted leading-relaxed">
                🪪 Cette entrée sert de <strong>pense-bête</strong> ("j'ai une
                passkey pour ce compte") — cette app ne crée ni ne signe rien
                via WebAuthn. Les détails techniques ci-dessous seront
                normalement renseignés automatiquement plus tard par votre
                extension navigateur, pas saisis à la main : la plupart des
                navigateurs ne vous donnent pas accès à ces valeurs.
              </p>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Domaine du service">
                  <input value={pkRpId} onChange={(e) => setPkRpId(e.target.value)} placeholder="example.com" className="input" />
                </Field>
                <Field label="Nom du service">
                  <input value={pkRpName} onChange={(e) => setPkRpName(e.target.value)} placeholder="Example Inc." className="input" />
                </Field>
              </div>

              <button
                type="button"
                onClick={() => setShowPasskeyAdvanced((v) => !v)}
                className="text-xs text-accent hover:text-accent-strong transition-colors"
              >
                {showPasskeyAdvanced ? "▾" : "▸"} Détails techniques (avancé, optionnel — remplis automatiquement par l'extension)
              </button>
              {showPasskeyAdvanced && (
                <div className="space-y-3 pt-1">
                  <Field label="ID de l'identifiant (credential.id)">
                    <input value={pkCredentialId} onChange={(e) => setPkCredentialId(e.target.value)} className="input font-mono text-xs" />
                  </Field>
                  <div className="grid grid-cols-2 gap-4">
                    <Field label="Identifiant utilisateur">
                      <input value={pkUserHandle} onChange={(e) => setPkUserHandle(e.target.value)} className="input font-mono text-xs" />
                    </Field>
                    <Field label="Algorithme">
                      <select value={pkAlgorithm} onChange={(e) => setPkAlgorithm(e.target.value)} className="input">
                        {PASSKEY_ALGORITHMS.map((a) => (
                          <option key={a} value={a}>
                            {a}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <Field label="Clé publique (référence seulement)">
                    <textarea
                      value={pkPublicKey}
                      onChange={(e) => setPkPublicKey(e.target.value)}
                      rows={2}
                      className="input resize-none font-mono text-[11px]"
                    />
                  </Field>
                </div>
              )}
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
                  draft={draftFieldIds.has(field.id)}
                  onChange={(patch) => updateCustomField(field.id, patch)}
                  onRemove={() => removeCustomField(field.id)}
                  onConfirm={() => confirmCustomField(field.id)}
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
  draft,
  onChange,
  onRemove,
  onConfirm,
}: {
  field: CustomField;
  draft: boolean;
  onChange: (patch: Partial<CustomField>) => void;
  onRemove: () => void;
  onConfirm: () => void;
}) {
  // Étape 1 — pas encore validé : juste le type et le nom du champ.
  if (draft) {
    return (
      <div className="p-3 rounded-xl border border-dashed border-edge-strong bg-base space-y-2">
        <select
          value={field.field_type}
          onChange={(e) => onChange({ field_type: e.target.value as CustomFieldType })}
          className="input text-xs"
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
          placeholder="Nom du champ (ex : Code PIN)"
          className="input"
          autoFocus
        />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onRemove}
            className="flex-1 py-2 rounded-lg border border-edge text-xs text-muted hover:text-primary transition-colors"
          >
            Annuler
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!field.label.trim()}
            className="flex-1 py-2 rounded-lg bg-brand text-on-brand text-xs font-medium hover:bg-brand-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Valider
          </button>
        </div>
      </div>
    );
  }

  // Étape 2 — champ validé : nom en petit au-dessus, puis l'éditeur de
  // valeur adapté au type (pas de retour à l'étape 1 : retirer et
  // recréer le champ pour changer son type ou son nom).
  return (
    <div className="p-3 rounded-xl border border-edge bg-base">
      <div className="flex items-center justify-between mb-1.5 gap-2">
        <span className="text-xs text-muted truncate">{field.label || "(sans nom)"}</span>
        <button
          type="button"
          onClick={onRemove}
          title="Retirer ce champ"
          className="text-xs text-muted hover:text-signal-red transition-colors shrink-0"
        >
          ✕
        </button>
      </div>
      {field.field_type === "totp" ? (
        <TotpFieldValue field={field} onChange={onChange} />
      ) : field.field_type === "password" ? (
        <SecretFieldValue field={field} onChange={onChange} />
      ) : (
        <input
          type={field.field_type === "email" ? "email" : field.field_type === "url" ? "url" : "text"}
          value={field.value}
          onChange={(e) => onChange({ value: e.target.value })}
          placeholder="Valeur"
          className="input"
        />
      )}
    </div>
  );
}

/** Champ "Mot de passe" : masqué par défaut (******), avec copier + voir dans l'input. */
function SecretFieldValue({ field, onChange }: { field: CustomField; onChange: (patch: Partial<CustomField>) => void }) {
  const [reveal, setReveal] = useState(false);
  return (
    <div className="relative">
      <input
        type={reveal ? "text" : "password"}
        value={field.value}
        onChange={(e) => onChange({ value: e.target.value })}
        placeholder="Valeur"
        className="input font-mono pr-16"
      />
      <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center gap-2.5">
        <CopyIconButton getValue={() => field.value} title="Copier" />
        <button
          type="button"
          onClick={() => setReveal((r) => !r)}
          title={reveal ? "Masquer" : "Voir"}
          className="text-xs text-muted hover:text-accent-strong transition-colors"
        >
          {reveal ? "🙈" : "👁"}
        </button>
      </div>
    </div>
  );
}

/** Champ "Code 2FA (TOTP)" : saisie du secret une seule fois, puis
 * verrouillé — affiche ensuite uniquement le code en direct et un anneau
 * de 30s, plus moyen de modifier la phrase depuis ce champ (retirer et
 * recréer le champ pour en changer). */
function TotpFieldValue({ field, onChange }: { field: CustomField; onChange: (patch: Partial<CustomField>) => void }) {
  // Un secret déjà présent à l'ouverture (entrée existante) démarre
  // directement verrouillé — pas besoin de re-cliquer "Valider" à chaque
  // édition de l'entrée.
  const [locked, setLocked] = useState(() => !!field.value.trim());
  const [draftSecret, setDraftSecret] = useState(field.value);
  const [totp, setTotp] = useState<TotpCode | null>(null);

  useEffect(() => {
    if (!locked || !field.value) {
      setTotp(null);
      return;
    }
    let cancelled = false;
    const tick = () => {
      computeTotp(field.value).then((res) => {
        if (!cancelled) setTotp(res);
      });
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [locked, field.value]);

  if (!locked) {
    const normalized = extractTotpSecret(draftSecret);
    return (
      <div className="flex gap-2">
        <input
          value={draftSecret}
          onChange={(e) => setDraftSecret(e.target.value)}
          placeholder="Secret TOTP (base32, ou coller une URI otpauth://)"
          className="input font-mono flex-1 min-w-0"
          autoFocus
        />
        <button
          type="button"
          disabled={!normalized}
          onClick={() => {
            onChange({ value: normalized });
            setLocked(true);
          }}
          className="px-3 rounded-lg bg-brand text-on-brand text-xs font-medium hover:bg-brand-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
        >
          Valider
        </button>
      </div>
    );
  }

  if (!totp) {
    return <p className="text-xs text-muted">Secret invalide — retirez ce champ et recommencez.</p>;
  }

  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-lg border border-edge bg-surface">
      <span className="font-mono text-lg tracking-[0.25em] text-primary tabular-nums">{totp.code}</span>
      <TotpRing remainingSeconds={totp.remainingSeconds} />
      <div className="flex-1" />
      <CopyIconButton getValue={() => totp.code} title="Copier le code" />
    </div>
  );
}

/** Anneau de compte à rebours (période TOTP de 30s). */
function TotpRing({ remainingSeconds, period = 30 }: { remainingSeconds: number; period?: number }) {
  const size = 22;
  const strokeWidth = 2.5;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - remainingSeconds / period);
  const urgent = remainingSeconds <= 5;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0 -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={strokeWidth} className="stroke-edge" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        className={`transition-[stroke-dashoffset] duration-1000 ease-linear ${urgent ? "stroke-signal-red" : "stroke-accent"}`}
      />
    </svg>
  );
}

/** Bouton copier générique, avec retour visuel bref (✓) au clic. */
function CopyIconButton({ getValue, title }: { getValue: () => string; title: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    const value = getValue();
    if (!value) return;
    try {
      await copySecretWithAutoClear(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // best-effort : on ne bloque pas l'UI pour un échec de copie ici.
    }
  };
  return (
    <button
      type="button"
      onClick={handleCopy}
      title={title}
      className="text-xs text-muted hover:text-accent-strong transition-colors"
    >
      {copied ? "✓" : "📋"}
    </button>
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
