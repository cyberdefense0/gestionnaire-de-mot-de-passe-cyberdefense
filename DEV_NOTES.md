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
