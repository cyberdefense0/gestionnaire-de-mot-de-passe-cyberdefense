# Notes de développement — Coffre (gestionnaire de mots de passe)

## ⚠️ À lire en premier : état de ce livrable

Ce projet a été construit dans un environnement sandbox avec un accès réseau limité
(pas d'accès à `rustup.rs`) et un `cargo`/`rustc` **1.75** installé via les dépôts Ubuntu.

- **`vault-core`** (le cœur cryptographique — Argon2id, AES-256-GCM, kit de
  récupération, changement de master password, checksum d'intégrité,
  historique des mots de passe) est **compilé et testé avec succès ici** :
  `cd vault-core && cargo test` → **10/10 tests passent**. C'est la partie qui
  protège réellement vos données, et elle est vérifiée.
- **Le frontend React/TypeScript** compile sans erreur (`tsc --noEmit` propre,
  `npm run build` fonctionne).
- **La couche Tauri** (`src-tauri/`) est du code source complet, mais sa
  compilation n'a **pas pu être vérifiée dans cette sandbox** : l'écosystème
  Tauri actuel tire des dépendances transitives qui exigent l'édition Rust 2024
  (donc Rust ≥ 1.85), alors que cette sandbox ne peut installer que Rust 1.75
  (pas d'accès réseau à rustup.rs pour une version plus récente).

**Sur votre machine, avec Rust installé via `rustup` (la méthode standard et
recommandée pour Tauri), ce problème ne se posera pas** : `rustup` installe et
maintient à jour un compilateur récent. Suivez les étapes ci-dessous.

---

## Prérequis

### Windows
1. [Node.js](https://nodejs.org/) 18 ou plus récent
2. [Rust via rustup](https://rustup.rs/) — **ne pas** utiliser un Rust installé autrement
3. [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (composant "Desktop development with C++")
4. WebView2 (préinstallé sur Windows 10/11 à jour ; sinon [téléchargeable ici](https://developer.microsoft.com/microsoft-edge/webview2/))

### Linux (Debian/Ubuntu)
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev pkg-config build-essential libssl-dev libxdo-dev
```

---

## Lancer le projet en développement

```bash
npm install
npm run tauri dev
```

Ceci ouvre l'application desktop avec rechargement à chaud du frontend.

## Construire les binaires (release)

```bash
npm run tauri build
```

- Linux → `.deb` et `.AppImage` dans `src-tauri/target/release/bundle/`
- Windows → `.msi` et installeur NSIS dans `src-tauri\target\release\bundle\`

---

## Structure du projet

```
password-manager/
├── vault-core/          # Cœur cryptographique pur (testable seul, cargo test)
│   ├── src/lib.rs        # Argon2id, AES-256-GCM, wrapping de clé, kit de récup
│   └── Cargo.toml
├── src-tauri/            # Couche desktop (Rust + Tauri v2)
│   ├── src/lib.rs        # Commandes exposées au frontend (create/unlock/CRUD)
│   ├── src/main.rs
│   ├── tauri.conf.json
│   └── icons/             # icônes placeholder — à remplacer par votre logo
├── src/                   # Frontend React + TypeScript + Tailwind
│   ├── pages/              # Écrans (sélection mode, création, déverrouillage, vault)
│   ├── components/         # Formulaire d'entrée, carte d'entrée, kit de récup
│   ├── lib/tauri.ts         # Wrapper typé des commandes Tauri
│   └── lib/passwordGenerator.ts
└── README.md              # Spécification fonctionnelle complète du projet
```

---

## Pourquoi Tauri v2 (mise à jour)

Le projet est passé de Tauri v1 à **Tauri v2**. La v1 dépend de `libwebkit2gtk-4.0`
et `libsoup2`, absents des distributions Linux récentes (elles fournissent
`libwebkit2gtk-4.1`/`libsoup3`), ce qui provoque une erreur `soup2-sys` /
`libsoup-2.4 not found` à la compilation. La v2 utilise `libwebkit2gtk-4.1`,
déjà installé si vous avez suivi les prérequis ci-dessus — pas d'action
supplémentaire nécessaire.

---

## Thème clair / sombre

L'app suit automatiquement la préférence système (`prefers-color-scheme`) au
premier lancement, et permet de forcer un choix via le bouton en haut à droite
(icône soleil/lune) — ce choix est mémorisé (`localStorage`) pour les lancements
suivants. Voir `src/lib/theme.ts` (logique) et `src/styles.css` (variables CSS
des deux palettes).

## Fix : "l'application ne répond pas" lors du choix du fichier

Ce problème venait de commandes Rust utilisant l'API **bloquante** du plugin
dialog (`blocking_save_file()` / `blocking_pick_file()`). Sur Linux, GTK
impose que les dialogues tournent sur le thread de l'UI ; appeler leur version
bloquante depuis une commande Tauri peut geler l'application selon le thread
d'exécution. La solution (déjà appliquée) : appeler directement les fonctions
`save()` / `open()` du plugin `@tauri-apps/plugin-dialog` **depuis le frontend**
(`src/lib/tauri.ts`), qui sont asynchrones et ne bloquent aucun thread. Les
commandes Rust `pick_new_vault_path` / `pick_existing_vault_path` ont été
supprimées — plus besoin.

Un fichier `src-tauri/capabilities/default.json` a été ajouté : en Tauri v2,
chaque plugin doit être explicitement autorisé pour la fenêtre qui l'utilise.
Sans lui, l'appel à `save()`/`open()` échoue avec une erreur de permission.

- Création d'un vault local (`.vault`) protégé par master password
- Génération et affichage unique du kit de récupération
- Déverrouillage par master password ou par kit de récupération
- CRUD complet des entrées (titre, identifiant, mot de passe, URL, notes, catégorie)
- Générateur de mots de passe (longueur, majuscules, minuscules, chiffres, symboles)
- Recherche / filtrage, regroupement par catégorie
- Copie du mot de passe avec effacement automatique du presse-papiers (20s)
- Verrouillage automatique après 5 minutes d'inactivité
- Changement de master password (commande prête côté backend, écran UI à ajouter)

## Albums personnalisés et notes sécurisées

- **Albums** : il n'y a plus de liste de catégories figée dans le code. Les
  albums sont stockés dans le vault lui-même (`Vault.categories` côté
  `vault-core`), créés par l'utilisateur — soit via le bouton « Gérer les
  albums » (créer/renommer/supprimer), soit directement en tapant un nouveau
  nom depuis le formulaire d'une entrée. Supprimer un album réaffecte ses
  entrées à l'album « Général » (jamais de perte de données silencieuse) ;
  « Général » lui-même ne peut pas être supprimé (toujours un album de secours).
- **Notes sécurisées** : un second type d'entrée (`item_type: "note"`),
  chiffré exactement comme les mots de passe (même `Vault`, même AES-256-GCM).
  Une note n'a ni identifiant, ni URL, ni mot de passe — seulement un titre,
  un album, et un contenu texte libre. Le bouton "+ Ajouter" propose un choix
  Mot de passe / Note sécurisée.

Toutes les commandes de mutation (`add_item`, `update_item`, `delete_item`,
`create_album`, `rename_album`, `delete_album`) renvoient désormais un
`VaultSnapshot` complet (`{ items, categories }`) pour garder le frontend
synchronisé avec ce que Rust a réellement persisté.

## Grande vague de fonctionnalités (favoris, TOTP, audit, import…)

- **Favoris** : étoile cliquable sur chaque carte + pilule de filtre dédiée ;
  tri par défaut "Favoris d'abord".
- **Tri** : nom (A→Z), récemment modifié, favoris d'abord (sélecteur dans l'en-tête).
- **Dernière modification** : affichée en toutes lettres sous chaque entrée
  (`src/lib/relativeDate.ts`).
- **Expiration/rappel** : date optionnelle par entrée ; badge "Expire Xj" /
  "Expiré" sur la carte, remonté aussi dans l'audit de sécurité.
- **Champs personnalisés** (`custom_fields` sur `VaultItem`) : texte, mot de
  passe masqué, email, URL, ou **TOTP** — le type TOTP calcule et affiche le
  code à 6 chiffres en direct (RFC 6238, implémenté en Web Crypto pur dans
  `src/lib/totp.ts`, aucune dépendance externe). Accepte aussi de coller
  directement une URI `otpauth://`.
- **Pièces jointes chiffrées** : petits fichiers (≤3 Mo) encodés en base64 et
  stockés dans le vault lui-même — donc protégés par le même AES-256-GCM que
  le reste. La limite est vérifiée à la fois côté frontend et côté Rust.
- **Audit de sécurité local** (`src/lib/security.ts`) : détecte mots de passe
  faibles, réutilisés entre plusieurs entrées, non modifiés depuis 180 jours,
  ou expirant bientôt — 100% local, aucun réseau.
- **Vérification Have I Been Pwned** (`src/lib/hibp.ts`), déclenchée
  manuellement depuis l'audit : implémente le **k-anonymat** — seul le SHA-1
  du mot de passe est calculé localement, et seuls ses **5 premiers
  caractères hexadécimaux** sont envoyés à l'API. Le mot de passe et le hash
  complet ne quittent jamais la machine. Voir le commentaire en tête du fichier.
- **Import CSV** (`src/lib/csvImport.ts` + `ImportCsv.tsx`) : détection
  automatique du format (Chrome/Edge/Brave, Firefox, Bitwarden, LastPass,
  générique) via les en-têtes de colonnes, aperçu avant confirmation, import
  groupé en une seule écriture disque (`import_items`).
- **Export chiffré (sauvegarde)** : copie du fichier `.vault` courant (déjà
  entièrement chiffré) vers un autre emplacement, via le panneau Paramètres.
- **Export du kit de récupération en PDF/image** : bouton "Imprimer / PDF"
  (utilise `window.print()` avec une vue dédiée `@media print`, donc "Save as
  PDF" natif du système) et bouton "Télécharger en image" (rendu Canvas → PNG).
- **Icônes de site automatiques** : favicon via le service public de Google
  (`src/lib/favicon.ts`), avec repli sur la lettre initiale si indisponible.
- **Changement de master password** : écran dédié (`ChangeMasterPassword.tsx`)
  qui exige de re-taper le master password *actuel* avant tout changement
  (nouvelle commande `verify_master_password_cmd`, qui ne fait que tenter un
  déchiffrement sans toucher à la session) — évite qu'un coffre resté
  déverrouillé sans surveillance permette un changement non autorisé.
- **Raccourcis clavier** : `Ctrl/Cmd+F` focus la recherche, `Ctrl/Cmd+N` ouvre
  une nouvelle entrée, `Échap` ferme la modal ouverte (toutes les modales
  utilisent `src/lib/useEscapeKey.ts`).

### Limite connue : audit "ancien mot de passe" — **résolue**

~~L'audit utilise `updated_at` comme proxy...~~ Cette limitation est corrigée
(voir section « Sécurité renforcée, historique et tags » ci-dessous) :
l'audit se base désormais sur `password_history` pour dater précisément le
dernier changement du mot de passe lui-même, indépendamment des autres
modifications de l'entrée.

### Fix : échec de l'enregistrement de l'image du kit de récupération

Le bouton "Télécharger en image" utilisait un lien `<a download>` généré par
le navigateur — mécanisme peu fiable dans une webview Tauri (particulièrement
WebKitGTK sur Linux), qui peut échouer silencieusement. Remplacé par le même
principe déjà utilisé pour le fichier `.vault` : le dialogue natif
(`pickImageDestination`) choisit l'emplacement, puis une commande Rust dédiée
(`write_binary_file`, qui décode le PNG encodé en base64) écrit réellement le
fichier sur disque. Un message de succès/échec s'affiche désormais sous le bouton.

## Sécurité renforcée, historique et tags (cette session)

Implémenté en réponse à une revue d'idées classées par thème (voir aussi le
README, section Roadmap, mise à jour en conséquence).

- **Checksum d'intégrité du `.vault`** (`vault-core::compute_checksum` /
  `verify_checksum`) : un SHA-256 de `encrypted_vault` est recalculé à chaque
  `save_vault` et vérifié **avant** l'Argon2id lors du déverrouillage. Ce
  n'est volontairement **pas** un HMAC (aucun secret n'est disponible avant
  déchiffrement) : il ne protège pas contre une falsification délibérée
  (l'attaquant peut recalculer le même checksum), mais détecte une
  corruption/troncature accidentelle du fichier, avec un message clair
  plutôt qu'un échec de déchiffrement générique. Rétrocompatible : les
  fichiers `version: 1` sans ce champ ne sont simplement pas vérifiés.
  Version de format bumpée à `2` (`CURRENT_VAULT_VERSION`).
- **Rate limiting sur le déverrouillage local** (`src-tauri/src/lib.rs`,
  section "Rate limiting") : un compteur d'échecs est stocké dans un fichier
  sidecar `<chemin>.vault.attempts` (JSON en clair — voir le commentaire en
  tête de section pour la justification de ce choix). Délai progressif :
  5s dès 3 échecs, 30s dès 5, 2 min dès 7, 10 min dès 10, plafond 30 min.
  Le compteur est partagé entre déverrouillage par master password et par
  kit de récupération (même fichier ciblé). Réinitialisé à chaque succès.
  Un échec dû à un fichier corrompu (checksum invalide) **ne compte pas**
  comme une tentative de devinette (voir `describe_unlock_error`).
- **Historique des mots de passe** (`VaultItem.password_history`) : alimenté
  automatiquement par `update_item` quand `password` change réellement (pas
  à chaque modification d'un autre champ), plafonné à 20 entrées (`MAX_PASSWORD_HISTORY`,
  la plus ancienne est évincée au-delà). Jamais pris depuis ce que le
  frontend envoie — c'est Rust qui en reste seul responsable, pour éviter
  toute incohérence. Affiché en lecture seule (avec révélation individuelle)
  dans `VaultItemForm` en mode édition. Sert aussi désormais de base à
  l'audit de sécurité "mot de passe ancien" (voir plus bas), bien plus
  précis que l'ancien proxy `updated_at`.
- **Tags multiples** (`VaultItem.tags`) : indépendants de `category` (qui
  reste un classement exclusif "un album par entrée"). Normalisés côté Rust
  (`normalize_tags` : trim, entrées vides retirées, dédoublonnage) plutôt que
  côté frontend, pour que toute écriture (import CSV compris) passe par la
  même règle. UI : ajout/retrait dans `VaultItemForm`, filtre par pilules
  dans `VaultView` (cumulable avec la recherche texte et le filtre par album).
- **Rappel du kit de récupération** (`VaultFile.recovery_kit_confirmed_at`,
  commande `confirm_recovery_kit_saved`) : métadonnée **non chiffrée** du
  `.vault` (elle ne révèle rien du contenu), qui date la dernière fois que
  l'utilisateur a confirmé avoir toujours accès à son kit. `VaultView`
  affiche une bannière si plus de 90 jours se sont écoulés (ou si jamais
  confirmé) ; "Plus tard" la masque pour la session en cours sans repousser
  l'échéance réelle. La confirmation initiale (`RecoveryKitModal`, à la
  création du vault) appelle désormais aussi cette commande, au lieu de se
  contenter d'une case à cocher purement locale au frontend.
- **Jauge de force du master password** (`PasswordStrengthMeter.tsx` +
  `src/lib/passwordStrength.ts`) : d'abord implémentée avec l'ancienne
  heuristique maison (`longueur × variété de caractères`), puis **remplacée
  par `zxcvbn-ts`** après retour utilisateur — l'heuristique maison plafonnait
  à "moyen" des mots de passe longs déjà quasi incrackables (16 caractères
  sur 3 types = 48 points = "moyen", alors que l'entropie réelle représente
  des siècles de calcul), ce qui ne correspondait pas du tout à ce
  qu'affichent des testeurs sérieux comme celui de Bitwarden (qui utilise
  aussi zxcvbn). `zxcvbn-ts` (fork TypeScript maintenu de la lib créée par
  Dropbox) simule de vraies attaques — dictionnaires FR+EN, motifs de
  clavier, dates, l33t-speak, répétitions — plutôt qu'un calcul arithmétique
  naïf, et affiche un vrai temps de crack estimé traduit en français (ex:
  "Durée estimée de la fissuration : des siècles"), scénario "offline slow
  hashing" (10⁴ essais/s), cohérent avec un master password protégé par
  Argon2id. Utilisée uniformément à trois endroits : `CreateLocalVault`
  (bloque la création si "faible"), `VaultItemForm` (force affichée par
  entrée), et `security.ts` (audit "mot de passe faible/moyen"). Seul
  bémol assumé : les dictionnaires zxcvbn sont chargés en synchrone au
  démarrage, ce qui fait grossir le bundle JS (~2,5 Mo avant gzip, contre
  ~230 Ko avant) — acceptable pour une app desktop qui tourne en local sans
  contrainte réseau, mais à garder en tête si le bundle grossit encore.
- **Export du kit de récupération en QR code** : nouveau bouton dans
  `RecoveryKitModal`, utilise la librairie `qrcode` (import différé,
  chargée uniquement sur cet écran), suit le même principe que l'export PNG
  existant (dialogue natif + `write_binary_file` côté Rust plutôt qu'un lien
  `<a download>`, peu fiable en webview — voir la note "Fix" plus bas dans ce
  fichier sur l'export image, qui documente pourquoi).

### Volontairement laissé de côté (roadmap, pas implémenté)

- **Biométrie locale** (Windows Hello / libsecret) : nécessite une
  intégration native par OS (API Windows Hello côté Windows, D-Bus
  `org.freedesktop.secrets` côté Linux), impossible à écrire et vérifier de
  façon fiable sans accès à ces environnements. Une première étape réaliste
  serait un stockage du master password dans le trousseau OS via la crate
  `keyring`, gated par un opt-in explicite — mais ce n'est pas de la
  biométrie à proprement parler, donc pas implémenté ici pour éviter de
  survendre la fonctionnalité.
- **Mode "leurre" / panic password** : nécessite de repenser le modèle de
  déverrouillage (double vault, ou vault factice généré à la volée) ; risque
  de bugs de sécurité si fait à la légère. Laissé en roadmap.
- **Sync multi-device en mode Local** : l'export/sauvegarde manuel du
  `.vault` existait déjà avant cette session et reste la seule option ;
  aucun flux de restauration dédié n'a été ajouté (ouvrir un `.vault`
  existant via "Déverrouiller" fonctionne déjà pour ce cas).

## Fix : le formulaire d'entrée rame avec un mot de passe long (zxcvbn)

**Symptôme rapporté** : générer un mot de passe de 48 caractères dans
`VaultItemForm`, puis interagir avec n'importe quel autre champ du même
formulaire (taper un tag, cocher une case, bouger le curseur de longueur du
générateur) devient très lent.

**Cause** : `zxcvbn.check()` est coûteux et son coût grimpe vite avec la
longueur du mot de passe — mesuré dans ce projet : ~17ms à 12 caractères,
~475ms à 32, **~800ms à 48**, ~3,3s à 100. Le calcul de force était placé
directement dans le corps du composant (`const strength =
estimateStrengthLabel(password)`), donc rejoué à **chaque re-render** — pas
seulement quand `password` changeait, mais à chaque frappe ou clic
n'importe où ailleurs dans ce même composant (un seul gros composant, un
seul état React partagé). Avec un mot de passe de 48 caractères déjà
généré, taper un caractère dans le champ tag suffisait à relancer ~800ms de
calcul synchrone qui bloque le thread principal.

**Correctif** (`VaultItemForm.tsx`) : le calcul est sorti du corps du
composant vers un `useEffect` dépendant uniquement de `[password, isNote]`,
avec un debounce de 250ms et un garde-fou anti-résultat-obsolète
(`cancelled`). Un re-render déclenché par un champ sans rapport ne
recalcule plus rien ; le calcul ne se déclenche que quand le mot de passe
change réellement, et au plus une fois par pause de frappe. Vérifié : 10
re-renders avec un mot de passe de 42 caractères stable passent de ~9,6s de
blocage cumulé à un seul calcul (~1s, la seule fois où c'est nécessaire).

**Même risque identifié et corrigé en même temps dans l'audit de
sécurité** (`SecurityAudit.tsx` / `lib/security.ts`) : `runLocalAudit`
appelait `estimateStrengthLabel` en synchrone sur **toutes** les entrées
d'un coup à l'ouverture de la fenêtre — pas un bug de re-render (c'était
déjà dans un `useMemo` correctement dépendant de `items`), mais un vault
avec beaucoup d'entrées à mots de passe longs pouvait quand même geler
l'ouverture de l'audit pendant plusieurs secondes. `runLocalAudit` est
maintenant asynchrone, découpée en tranches de 4 entrées
(`AUDIT_CHUNK_SIZE`) avec un `await` d'un macrotask (`setTimeout(…, 0)`)
entre chaque tranche pour laisser l'UI respirer, et un état de progression
affiché dans la fenêtre d'audit (comme pour la vérification HIBP, qui suit
déjà ce pattern).

**Limite assumée qui reste** : le calcul reste synchrone sur le thread
principal *pendant qu'il tourne* — debouncer/chunker évite de le rejouer
inutilement et laisse l'UI respirer entre les tranches, mais un mot de
passe très long généré d'un coup (ex: 100 caractères, ~3,3s) causera quand
même un gel ponctuel au moment précis du calcul. Une vraie solution sans
aucun gel nécessiterait un Web Worker (zxcvbn tournant hors du thread
principal) — pas fait ici, périmètre plus lourd qu'un simple debounce.
C'est pour ça que le curseur du générateur reste plafonné à 48 : le monter
sans le Web Worker ferait empirer ce gel résiduel (3,3s à 100 caractères)
plutôt que de le corriger.

## CI multi-plateforme (GitHub Actions)

`.github/workflows/release.yml` — build Windows, macOS (Intel + Apple
Silicon) et Linux en parallèle sur de vrais runners natifs pour chaque OS
(pas de cross-compilation depuis Linux, qui n'est pas fiable pour macOS et
seulement "en dernier recours" pour Windows selon la doc officielle Tauri).
Basé sur le workflow officiel [tauri-action](https://v2.tauri.app/distribute/pipelines/github/),
adapté à ce projet.

**Changement associé requis** : `src-tauri/tauri.conf.json` avait
`"targets": ["deb", "appimage", "msi", "nsis"]` — une liste qui ne couvre
QUE Linux et Windows. Sur un runner macOS, `tauri build` n'aurait alors
rien produit (aucun de ces formats n'existe sur macOS), en échouant
silencieusement au niveau du job CI. Remplacé par `"targets": "all"`, qui
laisse Tauri choisir automatiquement le bon format pour la plateforme de
build (`.app`/`.dmg` sur macOS, `.deb`/`.AppImage` sur Linux,
`.msi`/`.exe` sur Windows).

**Pour l'activer** :
1. Pousser ce projet sur un dépôt GitHub (le contenu de ce dossier
   `password-manager/` à la racine du dépôt, ou sinon ajouter
   `projectPath: password-manager` dans l'étape `tauri-apps/tauri-action`
   du workflow).
2. Dans les paramètres du dépôt → `Actions` → `General` → `Workflow
   permissions`, cocher **"Read and write permissions"** (nécessaire pour
   que l'action puisse créer la release — sinon erreur "Resource not
   accessible by integration").
3. Déclencher le build : soit via l'onglet `Actions` → `publish` → `Run
   workflow` (déclenchement manuel), soit en poussant sur une branche
   `release`.
4. Les 4 builds tournent en parallèle (~10-20 min). Une release GitHub en
   **brouillon** est créée avec les installeurs de chaque plateforme en
   pièces jointes — à vérifier avant de la publier.

**Non fait ici, à savoir** : ce workflow produit des builds **non
signés**. Un utilisateur macOS verra "l'app est endommagée" au premier
lancement (Gatekeeper) sans signature Apple — la doc Tauri recommande a
minima une signature "ad-hoc" pour éviter ce message, une vraie signature
notariée nécessitant un compte développeur Apple payant. Idem côté Windows
(SmartScreen avertira sans certificat de signature de code). Pas mis en
place ici : ajoute de la complexité (comptes développeur payants,
certificats) hors périmètre d'un premier build fonctionnel. Voir
[Windows Code Signing](https://v2.tauri.app/distribute/sign/windows/) et
[macOS Code Signing](https://v2.tauri.app/distribute/sign/macos/) si besoin
plus tard.

## v1.1.0 — verrouillage rapide, coffres récents, undo, sélection multiple

Quatre demandes utilisateur distinctes, implémentées ensemble.

### Verrouillage rapide + durée réglable

- **`Ctrl/Cmd+L`** verrouille immédiatement le coffre, à tout moment, ajouté
  au même gestionnaire d'événement clavier que `Ctrl+F`/`Ctrl+N` dans
  `VaultView.tsx`.
- La durée d'inactivité avant verrouillage automatique (5 minutes, codée en
  dur jusque-là) est maintenant réglable dans `VaultSettings` : 1/5/10/15/30
  minutes, ou "Jamais" (désactive complètement le timer d'inactivité —
  `Ctrl+L` reste toujours disponible pour verrouiller manuellement).
- Persistée en `localStorage` (`coffre:autoLockMinutes`, voir
  `src/lib/autoLock.ts`) — c'est une préférence d'application non sensible
  (ne révèle rien du contenu du coffre), donc volontairement globale plutôt
  que stockée par vault. Un petit événement custom (`window.dispatchEvent`)
  synchronise `VaultSettings` (qui écrit) et `VaultView` (qui lit) sans
  passer par un état React partagé entre les deux, puisqu'ils ne sont pas
  dans la même arborescence de composants au même moment (`VaultSettings`
  s'affiche par-dessus `VaultView` en modale).

### Coffres récents

- `src/lib/recentVaults.ts` : liste des 5 derniers `.vault` ouverts avec
  succès (chemin + date), en `localStorage` (`coffre:recentVaults`).
  **Aucun secret n'y transite** — ni mot de passe, ni contenu du coffre,
  juste des chemins de fichiers, comme une liste "fichiers récents"
  classique de n'importe quel logiciel de bureau.
- `App.tsx::enterVault` appelle `rememberVault(path)` à chaque
  déverrouillage ou création réussi (donc pour le mode Local uniquement,
  seul mode fonctionnel actuellement).
- Affiché dans `UnlockVault.tsx`, sous le bouton de sélection de fichier :
  clic pour pré-remplir le chemin (évite de rouvrir le sélecteur de
  fichiers natif à chaque fois), petit ✕ pour retirer une entrée de la
  liste. Un chemin qui ne pointe plus vers un fichier valide (déplacé,
  supprimé) échoue simplement au déverrouillage avec le message d'erreur
  standard déjà géré — pas de vérification d'existence anticipée.

### Annuler une suppression

- Avant : `handleDelete` appelait `vaultApi.deleteItem` immédiatement,
  aucun retour en arrière possible.
- Maintenant : cliquer "Supprimer" (après confirmation, comportement
  inchangé sur `VaultItemCard`) masque l'entrée **immédiatement** côté UI
  (nouvel état `pendingDeleteIds`, filtré dans le `useMemo` `filtered`) et
  affiche un toast avec un bouton "Annuler", pendant `UNDO_DELETE_MS`
  (6 secondes). La suppression réelle côté Rust (`vaultApi.deleteItem`,
  donc l'écriture disque) n'a lieu qu'à l'expiration de ce délai si
  personne n'a cliqué "Annuler" entre-temps — à ce moment-là seulement le
  vault chiffré est effectivement réécrit sans cette entrée.
- Pas de nettoyage spécial au démontage du composant (verrouillage pendant
  la fenêtre d'annulation) : le `setTimeout` est un timer JS global, pas lié
  au cycle de vie React, et `vaultApi.deleteItem` ne dépend pas de l'état du
  composant (appel Tauri direct) — la suppression différée se termine
  normalement même si `VaultView` a déjà été démonté entre-temps.
- Le toast a été généralisé pour accepter une action optionnelle
  (`{ message, action?: { label, onClick } }` au lieu d'une simple chaîne)
  plutôt que de créer un composant de toast séparé juste pour ce cas.

### Sélection multiple

- Nouveau bouton "Sélection multiple" dans le header (icône case à cocher),
  bascule `selectionMode`. En mode sélection : chaque `VaultItemCard`
  affiche une case à cocher à la place des actions rapides
  (favori/copier/modifier/supprimer, cachées pour éviter toute confusion
  entre "action sur cette entrée" et "sélection pour action groupée") ;
  cliquer n'importe où sur la carte bascule sa sélection.
- Barre d'actions flottante (`BulkActionBar`) apparaît dès qu'au moins une
  entrée est sélectionnée : déplacer vers un album (`<select>`), ajouter un
  tag à toutes les entrées sélectionnées, ou les supprimer (avec
  confirmation "Confirmer la suppression" en deux temps, comme sur une
  carte individuelle — **pas** de fenêtre d'annulation ici contrairement à
  la suppression unitaire, pour garder l'implémentation simple ; la
  confirmation en deux clics reste le filet de sécurité).
- Trois nouvelles commandes Rust (`src-tauri/src/lib.rs`) suivant exactement
  le même pattern que les commandes existantes (`with_session` +
  `save_and_snapshot`, une seule écriture disque par action groupée plutôt
  qu'un aller-retour par entrée sélectionnée) :
  - `bulk_delete_items(ids)`
  - `bulk_set_category(ids, category)` — crée l'album cible s'il n'existe pas
  - `bulk_add_tag(ids, tag)` — réutilise `normalize_tags`, pas de doublon si
    l'entrée avait déjà ce tag

## Depuis v1.1.0, pas encore publié — verrouillage sur focus, sauvegardes auto, doublons, phrase de passe

> Ces 4 fonctionnalités sont codées et testées, mais **pas encore publiées** en release GitHub — la dernière version réellement publiée reste `v1.1.0`. Le numéro de version dans `package.json`/`tauri.conf.json`/`Cargo.toml` est volontairement resté à `1.1.0` pour ne pas créer d'incohérence entre "ce qui est dans le repo" et "ce qui a été releasé". À bumper (ex: `1.2.0`) au moment de la prochaine publication, pas avant.

Quatre nouvelles demandes utilisateur.

### ⚠️ Bug évité : `eff-diceware-passphrase` charge un module natif incompatible webview

Pour le générateur de phrase de passe, le paquet npm `eff-diceware-passphrase`
a été installé pour sa liste de mots EFF (7 776 mots). Mais son point
d'entrée (`index.js`) fait `require('secure-sample')` /
`require('secure-shuffle')` **au niveau module**, qui remontent jusqu'à
`sodium-native` — un vrai module natif Node (binaire `.node` compilé via
node-gyp-build). `npm run build` (Vite) a même émis un avertissement
("Module 'fs' has been externalized for browser compatibility...") qui a
alerté sur le problème. Ça se serait construit sans erreur bloquante, mais
aurait **planté au runtime** dans la webview Tauri dès le chargement du
formulaire d'entrée (le frontend tourne dans un moteur de rendu web, pas
dans Node — aucun moyen d'y charger un binaire natif), pas seulement quand
le mode "Phrase de passe" est utilisé.

**Correctif** : `src/lib/passphraseGenerator.ts` n'importe que
`eff-diceware-passphrase/wordlist.json` (donnée JSON pure, aucune
dépendance) — jamais `index.js`. Le tirage aléatoire est réimplémenté
directement avec `crypto.getRandomValues` (Web Crypto API, la même source
que le générateur par caractères existant), au lieu du code RNG du paquet.
`@types/eff-diceware-passphrase` a été retiré des dépendances (son API
typée n'est plus utilisée). Vérifié : le build ne montre plus
d'avertissement d'externalisation `fs`/`path`/`os`, le nombre de modules
transformés par Vite est passé de 244 à 220 (confirme que toute la chaîne
`secure-sample`/`secure-shuffle`/`sodium-native`/`binary-search-bounds` a
disparu du bundle), et un test runtime confirme un tirage de 7 mots
distincts, sans remise, à partir des 7 776 mots réels de la liste EFF.

### Générateur de phrase de passe mémorisable

- Onglet "Aléatoire" / "Phrase de passe" dans le panneau générateur de
  `VaultItemForm`, à côté du générateur par caractères existant (pas de
  remplacement, les deux cohabitent).
- 3 à 10 mots, séparateur au choix (`-`, `_`, `.`, espace), majuscule
  initiale et chiffre final optionnels.
- Mots volontairement en anglais même dans une app francophone : la liste
  EFF est largement auditée par la communauté sécurité (mots courts, non
  ambigus à l'oral/écrit, aucun préfixe partagé) — même choix que la
  plupart des gestionnaires de référence. Documenté comme un choix assumé
  dans le code, pas un oubli de traduction.
- La jauge de force existante (zxcvbn-ts) s'applique sans changement, quel
  que soit le mode de génération utilisé — elle lit juste `password`.

### Verrouillage sur perte de focus / veille

- `src/lib/lockOnBlur.ts` + `getCurrentWindow().onFocusChanged` (API Tauri
  v2, vérifiée dans les types de `@tauri-apps/api/window` avant
  utilisation). Verrouille dès que la fenêtre perd le focus.
- **Nommé et documenté honnêtement** : Tauri n'expose pas d'événement
  "mise en veille système" dédié et fiable cross-plateforme sans plugin
  natif supplémentaire. `onFocusChanged` est le signal le plus robuste
  disponible nativement, et il couvre effectivement la mise en veille/le
  verrouillage de session (ils font perdre le focus en même temps) — mais
  il se déclenche aussi sur un simple Alt+Tab. D'où le réglage nommé
  "Verrouiller si la fenêtre perd le focus" plutôt que quelque chose comme
  "détecter la mise en veille", et **désactivé par défaut** (opt-in dans
  Paramètres) car potentiellement gênant pour un usage normal multi-fenêtres.

### Sauvegardes automatiques périodiques

- Nouvelle commande Rust `auto_backup(folder, keep)` : copie horodatée du
  `.vault` ouvert vers `folder`, puis rotation (supprime les plus
  anciennes au-delà de `keep`, en se basant sur le préfixe
  `coffre-backup-` pour ne jamais toucher à d'autres fichiers présents
  dans ce dossier).
- Réglable dans Paramètres : dossier cible (sélecteur natif), fréquence
  (jour/semaine/mois). Vérifié toutes les 10 minutes tant que le coffre
  reste déverrouillé (`src/lib/autoBackup.ts` + effet dans `VaultView`) —
  pas de tâche de fond après verrouillage/fermeture.
- Échec silencieux si le dossier configuré a été déplacé/supprimé entre
  temps (retente au contrôle suivant) plutôt que d'interrompre
  l'utilisateur avec une erreur pour une action qu'il n'a pas déclenchée
  lui-même.

### Détection de doublons

- Intégrée à l'audit de sécurité existant (`runLocalAudit` dans
  `lib/security.ts`) plutôt qu'une fenêtre séparée — nouvelle passe
  synchrone (pas besoin de découpage en tranches, contrairement au calcul
  de force par mot de passe : pas de zxcvbn ici, donc rapide même sur
  beaucoup d'entrées).
- Deux signaux indépendants, volontairement simples pour limiter les faux
  positifs :
  - **Même site** : comparaison du nom d'hôte normalisé de l'URL
    (minuscules, sans `www.`, sans protocole ni chemin) — détecte "Gmail"
    et "gmail.com" créés séparément par erreur.
  - **Titre identique** : comparaison du titre normalisé (minuscules,
    accents retirés, ponctuation/espaces supprimés) — égalité stricte
    après normalisation, **pas** de correspondance floue/Levenshtein (une
    vraie logique de similarité demanderait un calibrage soigneux pour
    éviter les faux positifs, hors périmètre ici).
- S'applique à toutes les entrées (notes comprises), pas seulement celles
  avec un mot de passe.

## Toujours depuis v1.1.0, pas encore publié — export vers d'autres gestionnaires, notifications, mise à jour auto, comptes jamais utilisés

### Export vers Bitwarden / KeePass (CSV)

- `src/lib/csvExport.ts`. **Formats vérifiés auprès des sources officielles,
  pas devinés** :
  - Bitwarden : en-tête documenté sur `bitwarden.com/help/condition-bitwarden-import`
    (`folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp`)
  - KeePassXC : sortie réelle de `keepassxc-cli export -f csv` (confirmée via
    la PR officielle keepassxreboot/keepassxc#3278) :
    `"Group","Title","Username","Password","URL","Notes"`
- Aucun des deux formats n'a de colonne "tags" nativement : repliés dans
  `notes` (`Tags: a, b, c`) pour ne rien perdre silencieusement. Idem pour
  les champs personnalisés (`Label: valeur`) et, côté KeePass, le code TOTP
  (pas de colonne dédiée contrairement à Bitwarden).
- ⚠️ Ces exports contiennent les mots de passe **en clair** — inhérent au
  format CSV attendu par ces deux gestionnaires, pas un choix de cette app.
  Message d'avertissement explicite dans l'UI (`VaultSettings`).
- Réutilise la commande Rust `write_binary_file` existante (pas de nouvelle
  commande) via un encodage UTF-8 → base64 correct (`utf8ToBase64`, à ne pas
  confondre avec `btoa` seul qui corrompt les caractères accentués).

### Notifications natives OS

- Plugin `tauri-plugin-notification` (Rust + `@tauri-apps/plugin-notification`
  JS), enregistré dans `lib.rs` et `capabilities/default.json`
  (`notification:default`) — API vérifiée auprès du README officiel du
  paquet avant implémentation.
- `src/lib/notifications.ts` : demande la permission une seule fois par
  session, échoue silencieusement si refusée (jamais bloquant).
- Deux déclencheurs, tous deux **en complément** des bannières in-app
  existantes, jamais à leur place :
  - Rappel du kit de récupération, à l'instant où il devient dû (dépendance
    sur `recoveryKitNeedsReminder`, donc pas de spam à chaque re-render).
  - Entrées expirant sous 7 jours, vérifié toutes les heures mais notifié
    au plus une fois par jour (`coffre:lastExpiryNotification` en
    localStorage, une simple date).
- Pas de réglage on/off dédié dans l'app : la permission OS elle-même sert
  déjà de contrôle (l'utilisateur peut refuser/révoquer au niveau système).

### Mise à jour automatique (Tauri updater)

**La plus grosse pièce technique de cette vague.** Configuration vérifiée
intégralement auprès de `v2.tauri.app/plugin/updater` (page officielle
fetchée en entier, pas de détail deviné) :

- Rust : `tauri-plugin-updater` + `tauri-plugin-process` (pour `relaunch()`),
  enregistrés dans `lib.rs`. L'updater suit le pattern officiel — dans
  `.setup()` plutôt qu'en `.plugin()` direct comme les autres, sous
  `#[cfg(desktop)]` (ce projet ne cible pas mobile aujourd'hui, mais c'est
  le pattern documenté et ça évite un piège si ça change).
- `tauri.conf.json` : `bundle.createUpdaterArtifacts: true` +
  `plugins.updater.endpoints` pointant vers
  `.../releases/latest/download/latest.json` (généré automatiquement par
  `tauri-action`, déjà utilisé dans le workflow CI — rien à ajouter côté
  génération du fichier).
- Capacités : `updater:default` et `process:default` (ce dernier vérifié
  via un exemple réel de capabilities.json trouvé sur un ticket GitHub
  officiel tauri-apps/tauri, le README du paquet ne le précisait pas
  explicitement).
- **Paire de clés de signature déjà générée** (`tauri signer generate`,
  exécuté directement dans ce sandbox) et la clé publique déjà insérée
  dans `tauri.conf.json` (`plugins.updater.pubkey`). La clé privée **n'est
  pas dans ce zip** — livrée séparément, à ajouter en secret GitHub
  (`TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, ce
  dernier vide puisque la clé a été générée sans mot de passe pour
  simplifier — voir le message de livraison pour la marche à suivre
  complète). Le workflow `.github/workflows/release.yml` référence déjà
  ces deux secrets.
- Frontend (`src/lib/updater.ts`) : vérification automatique une fois à
  l'ouverture du coffre (`VaultView`, notification native en plus de la
  bannière si une mise à jour est trouvée), plus un bouton de vérification
  manuelle dans Paramètres. Jamais d'installation silencieuse sans action
  explicite de l'utilisateur (bouton "Installer et redémarrer").
- **Non vérifiable en conditions réelles ici** : ce sandbox ne peut pas
  compiler `src-tauri` (limitation Rust 1.75 déjà documentée plus haut) ni
  publier une vraie release pour tester un cycle de mise à jour de bout en
  bout. Premier build réel après publication à surveiller de près.

### Détection de comptes jamais utilisés

- Nouveau champ `VaultItem.last_used_at` (Rust, `Option<String>`,
  rétrocompatible via `serde(default)`), mis à jour par la nouvelle
  commande `mark_item_used`, déclenchée à chaque copie du mot de
  passe/contenu (pas à l'ouverture pour consulter/modifier — signal
  d'usage réel, pas juste de consultation).
- Intégré à l'audit de sécurité existant : `Jamais copié depuis plus de 270
  jours` (ou `Jamais utilisé depuis la création` si `last_used_at` est
  encore `None`). Seuil volontairement plus large que celui des mots de
  passe anciens (180j) — signal différent (pertinence du compte, pas
  rotation du mot de passe), pas la peine de relancer trop vite.

## Fix : E0063 "missing field `last_used_at`" à la compilation

Signalé par l'utilisateur au premier vrai build (`cargo build`/`cargo tauri
dev`) — confirme la limite déjà documentée plus haut : ce sandbox ne peut
pas compiler `src-tauri` (Rust 1.75 vs edition2024 requise par une
dépendance transitive), donc ce genre d'erreur ne pouvait pas être
attrapée avant un vrai build chez l'utilisateur.

**Cause** : `#[serde(default)]` sur `VaultItem::last_used_at` ne joue que
pour la **désérialisation JSON** (lecture d'un `.vault` existant) — pas
pour un littéral de struct construit directement en Rust
(`VaultItem { ... }`). `draft_into_item` (src-tauri/src/lib.rs), qui
construit une nouvelle entrée à partir d'un `ItemDraft` envoyé par le
frontend, n'avait pas été mis à jour avec ce champ au moment de son ajout.

**Correctif** : ajout de `last_used_at: None,` dans ce littéral. Vérifié
qu'il n'existe qu'un seul site de construction de `VaultItem` par littéral
dans `src-tauri` (`grep -n "VaultItem {"`) — celui-ci était donc le seul
concerné. Les deux autres occurrences (dans les tests de `vault-core`)
avaient déjà été corrigées au moment de l'ajout du champ et sont couvertes
par `cargo test` (10/10, qui aurait échoué à la compilation sinon).

**Leçon retenue** : `#[serde(default)]` protège la rétrocompatibilité de
lecture d'anciens fichiers `.vault`, mais PAS la complétude des littéraux
de construction ailleurs dans le code — à vérifier explicitement
(`grep "NomDuStruct {"`) à chaque ajout de champ, pas seulement supposer
que `cargo test`/`cargo check` sur `vault-core` seul suffit puisque
`src-tauri` ne peut pas être compilé dans ce sandbox.

## Ce qui reste à faire

- **Mode Cloud** : l'écran est un stub (`src/pages/CloudComingSoon.tsx`). Il
  faut créer un projet Firebase (Auth + Firestore), ajouter le SDK Firebase
  côté frontend, et adapter les commandes pour synchroniser le `VaultFile`
  chiffré avec Firestore au lieu d'un fichier local. La logique de chiffrement
  (`vault-core`) ne change pas — Firestore ne stockera que le JSON déjà chiffré.
- Icônes définitives (celles fournies sont des placeholders générés automatiquement)
- Tests d'intégration Tauri (aujourd'hui seul `vault-core` a des tests automatisés)
- Audit de sécurité indépendant avant tout usage en production
- Biométrie locale, mode leurre/panic password, restauration explicite d'un
  `.vault` comme point d'entrée dédié (voir "volontairement laissé de côté" ci-dessus)

## Vague "functions(1).md" — UX clavier, Web Worker, export chiffré, HIBP continu, règles de génération, passkeys, E2E (cette session)

Implémentation des 6 chantiers du cahier des charges `functions(1).md`,
**à l'exclusion explicite de l'autofill navigateur** (prévu côté extension
séparée, sur demande de l'utilisateur — cette app ne fait donc aucune
cérémonie WebAuthn/FIDO2 réelle ni intégration d'autofill OS).

- **§1.1/§1.2 UX clavier** (`VaultView.tsx`, `VaultItemCard.tsx`) : jauge de
  progression visuelle sur le toast de copie (`ClipboardCountdownBar`,
  transition CSS pure), `Ctrl/Cmd+C`/`Ctrl/Cmd+Shift+C` sur la carte
  survolée/focalisée, navigation `↑`/`↓`/`Entrée`/`Espace` sur une liste à
  plat (`flatVisible`, dans l'ordre visuel réel des groupes), `/` en plus
  de `Ctrl/Cmd+F` pour la recherche (ignoré si on tape déjà dans un champ).
- **§2.1 Web Worker zxcvbn** (`passwordStrength.worker.ts` +
  `passwordStrength.ts` réécrit) : le calcul ne tourne plus jamais sur le
  thread principal, avec repli synchrone (import dynamique) si les workers
  modules sont indisponibles. Bénéfice constaté au passage : `npm run
  build` isole désormais les dictionnaires zxcvbn dans un chunk séparé
  (`passwordStrength.worker-*.js`, ~2,27 Mo) au lieu de les inclure dans le
  bundle principal — le souci de poids de bundle noté dans la vague
  précédente ("Jauge de force du master password") est donc résolu comme
  effet de bord, pas seulement le gel de l'UI.
- **§2.2 Export chiffré indépendant** (`lib/encryptedExport.ts`) : format
  `.json` séparé du `.vault`, mot de passe d'export dédié (≠ master
  password), AES-256-GCM + PBKDF2-SHA256 (600 000 itérations) en Web Crypto
  pur — volontairement PBKDF2 et non Argon2id ici, pour rester sans
  dépendance native côté export/import. Réutilise `write_binary_file` /
  `read_text_file`, déjà en place, donc **aucun changement Rust requis**
  pour cette fonctionnalité. Import en mode fusion (ajoute au coffre
  courant via `import_items`, ne remplace rien).
- **§3.1 Surveillance HIBP continue** (`lib/hibpMonitoring.ts`) : réutilise
  `checkPasswordPwned` (k-anonymat déjà en place), opt-in, vérification
  toutes les 24h tant que le coffre est déverrouillé (contrôlée toutes les
  10 min, même pattern que les sauvegardes automatiques). Ne notifie que
  les **nouvelles** compromissions (état précédent par entrée en
  localStorage, jamais de mot de passe ni de hash stocké) pour ne pas
  spammer à chaque cycle.
- **§3.2 Règles de génération par site** (`GenerationRule` sur `VaultItem`,
  Rust + TS) : toggle "alphanumérique uniquement" + liste de caractères à
  exclure, dans `GeneratorOptions` des deux côtés (Rust `generate_password`
  et JS `generatePassword`, logique identique, testée côté Rust). Stockée
  **par entrée** (chiffrée avec le reste), pas en préférence globale ni en
  association site→règle en clair, pour ne rien faire fuiter. Préchargée
  automatiquement à la réouverture d'une entrée qui en a une.
- **§3.3 Passkeys — métadonnées uniquement** (`ItemType::Passkey`,
  `PasskeyData` en Rust + TS) : nouveau type d'entrée dédié, stocke
  credential id / rp_id / rp_name / user_handle / clé publique / algorithme
  — **jamais de clé privée**, **aucune cérémonie WebAuthn réalisée par
  l'app**. Round-trip chiffrement/déchiffrement testé côté `vault-core`
  (`passkey_item_round_trips_through_save_and_unlock`). Pensé pour être lu
  plus tard par l'extension navigateur prévue, via les mêmes commandes
  Tauri existantes.
- **§4.1 Tests E2E** (`e2e/`) : squelette WebdriverIO + `tauri-driver` (le
  pattern officiel Tauri v2), 7 specs couvrant création de coffre, CRUD,
  verrouillage/déverrouillage + rate limiting, import CSV, navigation
  clavier, entrée passkey, export chiffré. **Non exécutés dans ce
  sandbox** : `tauri-driver` pilote le binaire compilé de `src-tauri`, qui
  ne compile pas ici (même limitation Rust 1.75/edition2024 déjà
  documentée). Voir `e2e/README.md`.

### Ce qui a été vérifié dans ce sandbox, et ce qui ne l'a pas été

- ✅ `cd vault-core && cargo test` → **12/12** (10 existants + 2 nouveaux :
  génération avec exclusions/alphanumérique, round-trip passkey).
- ✅ `npx tsc --noEmit` propre sur tout le frontend.
- ✅ `npm run build` (Vite) réussit, confirme l'isolation du chunk worker.
- ❌ `src-tauri` (Rust) : toujours non compilable ici (limitation
  préexistante, pas introduite par cette session) — `ItemDraft`,
  `draft_into_item`, `update_item` ont été mis à jour à la main en suivant
  exactement le pattern des champs existants, mais un premier `cargo
  build`/`cargo tauri dev` chez vous est requis pour confirmer.
- ❌ Notifications natives (HIBP continu) et tests E2E : nécessitent un
  vrai build compilé, non vérifiable ici — à valider manuellement,
  fonctionnalité par fonctionnalité, chez l'utilisateur.

## Retours utilisateur post-livraison (7 correctifs)

L'app compile et tourne bien chez l'utilisateur (premier vrai `cargo build`
réussi, confirmant que les ajouts Rust de la vague précédente — `passkey`,
`generation_rule` — étaient corrects). Sept retours ciblés, tous corrigés :

1. **Fenêtre Paramètres non scrollable** (`VaultSettings.tsx`) : le contenu
   dépasse désormais la hauteur de l'écran (beaucoup de nouvelles sections
   ajoutées : HIBP continu, export chiffré...) mais la `<div>` racine
   n'avait ni hauteur maximale ni `overflow-y-auto` — le bas du panneau
   était donc inaccessible. Corrigé : `max-h-[85vh] flex flex-col` sur le
   conteneur, `overflow-y-auto` sur le corps, en-tête fixe (même pattern
   déjà utilisé par `SecurityAudit.tsx`, qui lui ne l'avait pas).
2. **Passkey manuelle jugée inutile** (`VaultItemForm.tsx`) : remarque
   justifiée — un utilisateur normal n'a simplement pas accès à
   `credential.id`/clé publique/etc. sans "bidouiller" (devtools, export
   navigateur non standard). Le formulaire passkey a été restructuré :
   seuls domaine + nom du service restent en champs principaux (ce qu'on
   sait réellement sans accès technique), le reste passe dans une section
   "Détails techniques (avancé)" repliée par défaut, explicitement
   présentée comme destinée à être remplie plus tard par l'extension
   navigateur — pas saisie à la main. L'entrée redevient utile comme
   simple pense-bête ("j'ai une passkey ici") en attendant cette extension.
3. **Ordre de l'album "Général"** (`VaultView.tsx`) : nouveau
   `orderedCategories` (mémoïsé) — "Général" (l'album de secours,
   non supprimable) se place tout à droite des albums créés par
   l'utilisateur par défaut, et passe en tête dès qu'il est sélectionné,
   pour ne pas rester coincé contre le bouton "Gérer les albums" en bout de
   barre. Limite assumée : réordonnancement instantané (pas d'animation de
   déplacement fluide type FLIP) — acceptable pour une liste courte.
4. **Effacement automatique du presse-papiers ne fonctionnait pas sous
   Ubuntu** — bug réel, pas un problème de timer. Cause : `copySecret`
   utilisait `navigator.clipboard.readText()`/`writeText()` (l'API Web du
   navigateur), qui **exige que le document ait le focus**. Sur
   WebKitGTK/Linux, ceci échoue silencieusement (capté par un `.catch(() =>
   "")` existant) dès que la fenêtre perd le focus — précisément ce qui se
   passe en pratique juste après avoir copié un mot de passe pour aller le
   coller ailleurs : le `readText()` de vérification renvoyait `""`, ne
   correspondait jamais au secret copié, et le `writeText("")` d'effacement
   était donc systématiquement sauté. `Ctrl+C` (raccourci de copie, pas
   d'effacement) fonctionnait car il ne dépend pas de ce chemin.
   **Correctif** : remplacement par `@tauri-apps/plugin-clipboard-manager`
   (presse-papiers **natif**, via l'OS, aucune restriction de focus) sur
   les 3 sites de copie (`VaultView.tsx` mot de passe/identifiant,
   `VaultItemCard.tsx` code TOTP, `RecoveryKitModal.tsx` kit de
   récupération). Nouveau : `tauri-plugin-clipboard-manager = "2"`
   (`Cargo.toml`), `.plugin(tauri_plugin_clipboard_manager::init())`
   (`lib.rs`), permission `clipboard-manager:default`
   (`capabilities/default.json`), `@tauri-apps/plugin-clipboard-manager`
   (`package.json`). **Non recompilé dans ce sandbox** (même limitation
   Rust connue) — à vérifier au prochain `cargo build` chez l'utilisateur.
5. **Sélection clavier invisible** (`VaultItemCard.tsx`) : deux bugs
   distincts derrière ce seul symptôme. (a) Le style visuel de la carte
   "focus clavier" (`ring-1 ring-brand/30`, fond à 4% d'opacité) était
   syntaxiquement correct mais bien trop subtil pour être perçu — renforcé
   en `ring-2 ring-brand` plein + fond à 10%. (b) Plus important : les
   icônes d'action rapide (favori/copier/modifier/supprimer) utilisaient
   `opacity-0 group-hover:opacity-100`, un state **CSS pur** qui ne réagit
   qu'au `:hover` de la souris — jamais déclenché par la navigation
   clavier. Donc en pratique, la sélection clavier fonctionnait
   (confirmé : flèches/Entrée/Espace marchaient déjà), mais restait
   invisible et sans action rapide visible. Corrigé en pilotant l'opacité
   depuis la prop React `focused` en plus du `group-hover` CSS.
6. **Curseur de longueur toujours plafonné à 48** (`VaultItemForm.tsx`) :
   oubli — ce plafond datait d'avant le Web Worker (§2.1), voir la note
   "Fix : le formulaire d'entrée rame..." plus haut, qui documentait déjà
   que le lever nécessiterait précisément un Web Worker. Il existe
   maintenant : plafond relevé à 128, pas de 8 (préférence utilisateur
   pour les puissances de 2).
7. **Barre de progression de l'audit "par à-coups"** (`SecurityAudit.tsx`)
   : `onProgress` était déjà appelé à chaque entrée (pas seulement par
   tranche de 4, ce chunk ne contrôlait que la fréquence des
   `yieldToMainThread`), mais l'UI n'affichait qu'un texte "X/Y" statique
   — avec 200 entrées analysées en ~1s via le Worker, les mises à jour trop
   rapprochées donnaient une impression de blocage puis de saut plutôt
   qu'une vraie progression visible. Ajout d'un composant
   `AuditProgressBar` : vraie barre remplie via `width` en pourcentage,
   avec `transition-[width] duration-200` pour lisser visuellement même
   des mises à jour très rapprochées. Réutilisée pour l'audit local et pour
   la vérification HIBP à la demande.

### Vérifié dans ce sandbox pour cette vague

- ✅ `npx tsc --noEmit` propre.
- ✅ `npm run build` (Vite) réussit.
- Pas de nouveau changement `vault-core` cette fois (les 12 tests Rust
  restent valides tels quels) — seul `src-tauri` gagne une dépendance de
  plugin supplémentaire (`clipboard-manager`), non recompilable ici.

## Retours utilisateur post-livraison, round 2 — permission presse-papiers, toggles, passkey retirée, règle de génération incomplète

L'utilisateur a lancé un vrai `cargo build`/`tauri dev` cette fois (log
fourni), confirmant que `tauri-plugin-clipboard-manager` **compile bien**.
Le presse-papiers restait pourtant totalement cassé (plus de copie du
tout, `Ctrl+C` inclus) — cause identifiée avec certitude cette fois :

- **Mauvaise permission** (`capabilities/default.json`) :
  `"clipboard-manager:default"` **n'existe pas** comme permission bundle
  pour ce plugin — la doc officielle Tauri liste explicitement
  `clipboard-manager:allow-read-text`, `clipboard-manager:allow-write-text`,
  `clipboard-manager:allow-clear` comme identifiants valides (confirmé via
  un ticket GitHub officiel listant l'énumération complète des permissions
  reconnues par le plugin). Sans permission valide, chaque appel
  `writeText`/`readText`/`clear` rejette sa Promise ; `copySecret` faisait
  `await clipboardWriteText(secret)` sans `try/catch`, donc toute la
  fonction s'arrêtait avant même d'atteindre le `showToast` — d'où "aucun
  accès au presse-papier, aucune barre de 20s". Corrigé : permissions
  explicites + `try/catch` autour de l'écriture dans `copySecret`/
  `copyUsername` (`VaultView.tsx`), pour qu'un futur problème de ce genre
  remonte un message d'erreur visible au lieu de s'avaler en silence.
- **Interrupteurs (toggles) qui débordent de leur rail** — 3 occurrences
  identiques dans `VaultSettings.tsx` (verrouillage sur perte de focus,
  sauvegardes automatiques, et le nouveau HIBP continu) : le curseur
  (`<span>` en `position: absolute`) n'avait **aucun `left` explicite**,
  seulement une classe de translation. Sans position de départ fixe, le
  point de départ "statique" d'un élément absolu peut se comporter de
  façon incohérente selon le contexte de layout — d'où le curseur qui
  semblait "par défaut à droite" puis ressortait du cadre au clic.
  Remplacé par un composant partagé `ToggleSwitch` avec `left-0.5` explicite
  et une translation en pixels réels (`style={{ transform: ... }}`, pas de
  classe Tailwind ambiguë), réutilisé aux 3 endroits.
- **Passkey manuelle retirée** : après un premier passage qui avait déjà
  simplifié le formulaire (champs techniques repliés), retour clair de
  l'utilisateur — l'onglet de création manuelle n'a **aucune utilité**
  puisque ces données ne sont normalement jamais accessibles à un humain.
  L'onglet "🪪 Passkey" a été retiré du sélecteur de type dans
  `VaultItemForm.tsx`. Le modèle de données (`ItemType::Passkey`,
  `PasskeyData` en Rust et TS, `VaultItemCard`/`SiteIcon`) reste en place
  **sans modification** : une entrée passkey pourra toujours être créée
  plus tard par l'extension navigateur (ou par import), et s'afficherait/
  s'éditerait alors correctement dans cette app — seule la création
  manuelle depuis le "+" est désormais bloquée.
- **`GenerationRule` incomplet** — bug réel distinct de tout problème de
  sauvegarde : le struct (Rust + TS) ne mémorisait que `length`,
  `alphanumeric_only` et `exclude_chars`, jamais
  `uppercase`/`lowercase`/`numbers`/`symbols`. Décocher "Majuscules" par
  exemple puis cocher "Mémoriser" ne pouvait donc jamais restaurer ce choix
  à la réouverture — pas un oubli de sauvegarde, un champ qui n'existait
  simplement pas dans la structure persistée. Élargi aux 7 champs complets
  de `GeneratorOptions`, des deux côtés, avec `#[serde(default = "default_true")]`
  sur les 4 nouveaux booléens Rust pour rester rétrocompatible avec une
  règle déjà sauvegardée par une version antérieure (fichier `.vault` déjà
  en usage). Nouveau test Rust
  (`generation_rule_round_trips_all_fields`) couvrant explicitement ce cas
  (mémoriser une règle avec `symbols: false`).
- **Cartes/entrées : icônes d'action qui décalaient l'alignement de
  l'album** (`VaultItemCard.tsx`) : les icônes rapides (favori/copier/
  modifier/supprimer) restaient montées dans le DOM en permanence
  (`opacity-0`) pour éviter un saut de mise en page au survol — mais leur
  largeur variable (une passkey ou une note a moins de boutons qu'un mot
  de passe avec identifiant) faisait que l'espace réservé différait d'une
  carte à l'autre, décalant le badge d'album visible juste avant. Corrigé :
  la barre d'actions n'est plus montée du tout tant que la carte n'est ni
  survolée ni sélectionnée au clavier (`{focused && (...)}` au lieu de
  `opacity-0`), ce qui élimine la réservation d'espace variable — au prix
  d'une apparition instantanée plutôt qu'un fondu, jugé acceptable.
- **Album "Général" par défaut à droite** et **sélection clavier trop
  discrète** : déjà couverts par le tour précédent, revalidés par
  l'utilisateur (les deux "fonctionnent").

### Vérifié dans ce sandbox pour ce round

- ✅ `cargo test` sur `vault-core` → **13/13** (12 précédents + 1 nouveau :
  round-trip complet de `GenerationRule`).
- ✅ `npx tsc --noEmit` propre.
- ✅ `npm run build` (Vite) réussit.
- ❌ Compilation réelle de `src-tauri` avec la permission
  `clipboard-manager` corrigée : toujours non vérifiable dans ce sandbox
  (même limitation Rust connue) — c'est la correction la plus importante
  de ce round, à confirmer en priorité chez l'utilisateur.
