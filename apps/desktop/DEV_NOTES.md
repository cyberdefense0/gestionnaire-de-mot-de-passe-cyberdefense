
## Vague "features v6" — palettes d'accent, lecture seule, fuzzy search, ConflictResolver→ImportCsv, Dashboard enrichi

Cinq chantiers priorisés par impact utilisateur visible, implémentés sans modification Rust (vault-core inchangé, 13/13 tests toujours valides).

---

### 1. Palettes de couleur d'accent (`accentColor.ts` + `AccentPicker.tsx`)

**Quoi.** 5 palettes de couleur remplaçant `--color-brand` et ses dérivés en live : Bleu (par défaut, identique à l'existant), Violet, Vert, Rose, Orange.

**Pourquoi maintenant.** Première amélioration visible à 100% par tout utilisateur dès l'ouverture. Coût technique faible (CSS variables), valeur perçue élevée.

**Comment.** `src/lib/accentColor.ts` définit les 5 palettes (`PaletteDefinition[]`) avec des valeurs RGB séparées pour thème clair et sombre (format attendu par les CSS custom properties existantes — `rgb(var(--color-brand) / <alpha-value>)`). `applyPalette(id, dark)` injecte les valeurs directement sur `document.documentElement.style`. Le choix est persisté en `localStorage` (`coffre:accentPalette`).

`src/components/AccentPicker.tsx` : pastille colorée dans le header (desktop uniquement, masquée sur mobile via `hidden sm:block`), clic → popover avec les 5 options. Fermeture au clic extérieur via `mousedown` sur `document`.

**Initialisation au démarrage** : un IIFE dans `App.tsx` (avant le premier rendu React) applique la palette stockée dès que le thème est connu, évitant un flash de la couleur par défaut sur les pages de connexion/création. `VaultView` re-applique à chaque changement de thème clair/sombre via `useEffect([resolvedTheme])`.

**Ce qui ne change pas.** Les couleurs `signal-*` (`signal-red`, `signal-amber`, `signal-green`) sont intentionnellement exclues des palettes — elles encodent une sémantique (erreur, avertissement, succès) et ne doivent pas suivre la couleur de marque.

---

### 2. Mode "Lecture seule" (`readOnlyMode.ts` + bouton header + bannière)

**Quoi.** Un mode qui bloque toute écriture dans le coffre (ajout, modification, suppression) jusqu'à désactivation explicite. Activable par le bouton crayon/cadenas dans le header ou par `Ctrl/Cmd+R`.

**Pourquoi.** Utile pour consulter le coffre sur un poste partagé, passer son écran en réunion, ou éviter les modifications accidentelles lors d'une navigation rapide.

**Comment.** `src/lib/readOnlyMode.ts` : `isReadOnly()` / `setReadOnly(bool)` sur `sessionStorage` (`coffre:readOnly`). Choix du sessionStorage plutôt que localStorage : la protection est ponctuelle (session en cours), pas une préférence persistante entre lancements.

Dans `VaultView` :
- État React `readOnly` initialisé depuis `isReadOnly()`.
- `toggleReadOnly()` : bascule l'état, persiste, affiche un toast de confirmation.
- Guards sur `handleSave` et `handleDelete` : retour immédiat avec toast explicatif si actif.
- Bouton "Ajouter" : `opacity-50 cursor-not-allowed` + titre modifié si actif.
- Bannière ambre sous le header, visible en permanence quand actif, avec bouton "Désactiver".
- Icônes `LockClosedIcon` (cadenas fermé) et `EditIcon` (crayon) ajoutées en bas de fichier.
- Raccourci `Ctrl/Cmd+R` ajouté au gestionnaire de touches existant.
- `KeyboardShortcutsHelp.tsx` mis à jour : `Ctrl+R` dans le groupe "Sécurité".

**Limite assumée.** Le mode lecture seule ne bloque pas la copie dans le presse-papiers ni la navigation — il protège uniquement les écritures sur le fichier `.vault`.

---

### 3. Recherche approximative / fuzzy search (`fuzzySearch.ts`)

**Quoi.** La barre de recherche tolère désormais les fautes de frappe légères : "gmaill" trouve "Gmail", "netflik" trouve "Netflix".

**Pourquoi.** Amélioration invisible mais très impactante au quotidien — les utilisateurs tapent vite et font des erreurs.

**Comment.** `src/lib/fuzzySearch.ts` : distance de Damerau–Levenshtein (gère substitutions, insertions, suppressions, transpositions) implémentée sans dépendance externe. Tableau dp `Uint16Array` pour limiter les allocations.

Seuils calibrés pour éviter les faux positifs :
- longueur < 4 : correspondance exacte uniquement (évite "fb" → "fab", "in" → "inn"…)
- longueur 4–6 : distance ≤ 1
- longueur ≥ 7 : distance ≤ 2

Stratégie : d'abord `includes()` exact sur la concaténation de tous les champs (title, username, url, category, tags, notes) — rapide, sans distance. Si raté, découpe en tokens (`\s\-_./,:@`) et distance par paire (mot de requête × token du texte), avec fenêtre glissante quand le token est plus long que le mot.

Intégration dans `VaultView` : remplacement de la chaîne de `toLowerCase().includes()` dans le `useMemo` `filtered`. Chaque AND implicite (plusieurs mots dans la requête) doit trouver au moins un token correspondant.

**Limite assumée.** Le calcul est synchrone sur le thread principal ; sur un coffre de plusieurs milliers d'entrées avec une requête longue, un léger délai pourrait apparaître. En pratique les coffres typiques (< 500 entrées) ne posent pas de problème mesurable. Un Web Worker serait la vraie solution si ce cas émerge.

---

### 4. Connexion `ConflictResolver` → `ImportCsv` (fonctionnalité manquante depuis la vague v5)

**Quoi.** L'import CSV affiche désormais les conflits détectés (même hostname ou même titre normalisé) et laisse l'utilisateur choisir entrée par entrée : Ignorer / Remplacer / Garder les deux — avant d'écrire quoi que ce soit sur disque.

**Pourquoi.** Noté explicitement dans les DEV_NOTES précédentes ("le composant existe mais n'est pas encore appelé depuis l'écran d'import"). C'est la dernière pièce du flux d'import annoncée dans le README et jamais livrée.

**Comment.** `ImportCsv.tsx` intégralement réécrit. Flux en 4 étapes :

1. **Sélection** (`step: "pick"`) : `vaultApi.pickCsvFile()` → lecture.
2. **Aperçu** (`step: "preview"`) : format détecté, nombre d'entrées, 8 premières en aperçu. Si le coffre est non vide, un message indique que les conflits seront vérifiés à l'étape suivante.
3. **Résolution** (`step: "resolve"`) : rendu de `ConflictResolver` avec les `drafts` et les `existingItems` passés depuis `VaultView`. `ConflictResolver` gère sa propre UI et rappelle `onResolved(toAdd, toReplace)`.
4. **Import** (`step: "importing"`) : overlay de progression. Remplacements via `vaultApi.updateItem` en boucle (pas de commande `update_items_bulk` côté Rust — boucle O(n), acceptable sur un import typique). Ajouts via `vaultApi.importItems` en une seule écriture disque.

`VaultView` passe maintenant `existingItems={items}` à `ImportCsv`.

**Aucun changement Rust requis** : `update_item` et `import_items` existaient déjà.

---

### 5. Dashboard enrichi (nouvelles sections + albums cliquables)

**Quoi.** Le dashboard d'accueil affiche désormais : score de sécurité avec barre de progression colorée, section "Renouvellements à prévoir" (entrées expirant dans 30j), section "À vérifier" (entrées jamais copiées depuis > 6 mois), section "Ajouts récents" (5 dernières créées), et répartition par album sous forme de barres cliquables.

**Pourquoi.** Le dashboard était peu informatif. Ces sections donnent un résumé actionnable de l'état du coffre dès l'ouverture, sans ouvrir l'audit de sécurité.

**Comment.** `Dashboard.tsx` réécrit. Nouvelles dépendances : `relativeDate` (déjà présente), `computeStats` (déjà présente dans `lib/vaultStats.ts`).

- **Score de sécurité** : `Math.max(0, (total - auditIssueCount) / total * 100)`. Barre CSS colorée (vert ≥ 80%, ambre 50–79%, rouge < 50%). `null` si l'audit n'a pas encore été lancé → "Lancer l'audit".
- **Expirations** : filtre `expires_at` dans les 30 prochains jours, triées par date, badge "Aujourd'hui" / "Demain" / "Dans Xj".
- **Entrées dormantes** : `last_used_at` absent ou > 180j → badge "Jamais utilisé" / "Utilisé il y a X". Limité à 3 pour ne pas noyer l'écran.
- **Albums cliquables** : nouvelle prop `onFilterAlbum(album)` dans `Dashboard`. `VaultView` la câble : clic → `setActiveAlbum(album) + setShowDashboard(false)`.
- Composants internes `ItemRow` (ligne d'entrée réutilisée dans plusieurs sections) et `StatCard` (carte stat cliquable ou non).

**Prop ajoutée.** `onFilterAlbum: (album: string) => void` dans l'interface `Props` de Dashboard et dans l'appel depuis `VaultView`.

---

### Corrections de bugs TypeScript préexistants résolus au passage

- `recoveryCode` manquant dans l'interface `Props` de `VaultView` (prop passée depuis `App.tsx` mais non déclarée).
- `RecoveryKitModal` appelé avec `onClose` alors qu'il attend `recoveryCode` + `onConfirm` — corrigé.
- `showToast` appelé avec un objet `{ message, countdownMs }` au lieu de la signature `(message, action?, countdownMs?)` — corrigé.
- Import `isPinEnabled` / `storeMasterPasswordForPin` inutilisé dans `VaultView` — supprimé.

---

### Vérifié dans ce sandbox pour cette vague

- ✅ `npx tsc --noEmit` → **0 erreur**.
- ✅ `npm run build` (Vite) → réussi, même profil de chunks qu'avant (le worker zxcvbn reste isolé dans son chunk séparé).
- ✅ `vault-core` : **aucun changement Rust** dans cette session — les 13 tests précédents restent valides tels quels.
- ❌ Compilation `src-tauri` : toujours non vérifiable dans ce sandbox (limitation Rust préexistante). Aucun changement `src-tauri` dans cette session.

### Points à surveiller au premier build réel

- `AccentPicker` dans le header : vérifier que le popover se ferme bien sur toutes les plateformes (le `mousedown` sur `document` peut parfois être capturé avant la propagation dans WebKitGTK).
- Mode lecture seule + raccourci `Ctrl+R` : s'assurer qu'il n'entre pas en conflit avec un raccourci OS existant sur Windows (Ctrl+R = rechargement dans certains contextes — inoffensif dans une webview Tauri sans rechargement).
- Dashboard "Entrées dormantes" : dépend de `last_used_at` qui est `null` pour toutes les entrées d'un coffre importé d'avant la vague qui a introduit ce champ (vague v4). Ces entrées apparaîtront dans "jamais utilisé" si elles ont plus de 180 jours — comportement intentionnel (c'est la réalité, elles n'ont effectivement jamais eu de `last_used_at` tracé).
