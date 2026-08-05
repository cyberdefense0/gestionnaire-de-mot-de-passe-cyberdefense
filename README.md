# 🔐 Gestionnaire de Mots de Passe

Application de gestion de mots de passe **grand public**, disponible en version **Web** et **Bureau** (Windows/Linux), avec chiffrement **Zero-Knowledge** et deux modes de stockage : **Local** ou **Cloud (Firestore)**.

> **État actuel :** l'application **Desktop en mode Local** est fonctionnelle et va aujourd'hui **au-delà** du périmètre MVP décrit plus bas (favoris, TOTP, pièces jointes, audit de sécurité, import CSV...). Le **mode Cloud** et la **version Web** restent au stade de spécification (écran "bientôt disponible" côté frontend, pas encore de backend Firebase/Firestore). Voir [État actuel du projet](#-état-actuel-du-projet) pour le détail exact de ce qui est codé vs. prévu.

---

## 📋 Sommaire

- [Vue d'ensemble](#vue-densemble)
- [Stack technique](#stack-technique)
- [Sécurité — Zero-Knowledge](#sécurité--zero-knowledge)
- [Modes de fonctionnement](#modes-de-fonctionnement)
- [Modèle de données](#modèle-de-données)
- [État actuel du projet](#-état-actuel-du-projet)
- [Roadmap — idées à explorer](#-roadmap--idées-à-explorer)
- [Plateformes cibles](#plateformes-cibles)

---

## Vue d'ensemble

Le but est de proposer un gestionnaire de mots de passe simple, sécurisé et flexible :
- Utilisable **en ligne** (web, synchronisé via Firestore) ou **hors ligne** (application bureau, fichier local uniquement)
- Chiffrement **Zero-Knowledge** : ni le serveur, ni les développeurs ne peuvent jamais accéder aux données en clair
- Cross-platform : Web (accessible via mobile et desktop), et application native Windows/Linux

---

## Stack technique

| Composant | Choix | Justification |
|---|---|---|
| Frontend (web + desktop) | **React** + TypeScript + TailwindCSS | Écosystème large, bonne compatibilité avec Tauri, nombreuses librairies |
| Application desktop | **Tauri v2** (backend Rust) | Plus léger et plus sécurisé qu'Electron (mémoire sûre en Rust), binaires légers, réutilise le frontend web. Migré de v1 → v2 pour compatibilité avec `libwebkit2gtk-4.1`/`libsoup3` sur les distributions Linux récentes |
| Authentification (mode Cloud) | **Firebase Authentication** (email + mot de passe) | Simple, fiable, cohérent avec l'approche zero-knowledge — *non encore implémenté, voir roadmap* |
| Stockage cloud | **Firestore** | Ne stocke que des données déjà chiffrées côté client — *non encore implémenté, voir roadmap* |
| Stockage local (desktop) | Fichier **`.vault`** chiffré unique, portable, **versionné** (`VaultFile.version`) | Autonome, déplaçable/copiable facilement, aucune dépendance externe, migrations de schéma anticipées dès la V1 |
| Chiffrement des données | **AES-256-GCM** | Standard robuste, chiffrement authentifié. Le tag GCM garantit l'intégrité *au moment du déchiffrement* ; un **checksum SHA-256** distinct, recalculé à chaque sauvegarde et vérifié *avant* même de lancer l'Argon2id, détecte en plus une corruption/troncature du fichier avec un message clair plutôt qu'un échec de déchiffrement générique (`vault-core::verify_checksum`) |
| Dérivation de clé | **Argon2id** — `m_cost=19 Mo`, `t_cost=2`, `p_cost=1` (`vault-core/src/lib.rs`) | Résistant aux attaques par force brute / GPU, recommandé pour les master passwords. Paramètres documentés dans le code ; un audit indépendant des coûts mémoire/temps/parallélisme reste à faire (voir roadmap) |
| Cœur cryptographique | **`vault-core`**, crate Rust pur, testé indépendamment (`cargo test`, 10/10 tests) | Isolé de Tauri/GUI pour rester auditable et réutilisable (ex. par une future implémentation Cloud) |

---

## Sécurité — Zero-Knowledge

Le principe central du projet : **le master password ne quitte jamais l'appareil de l'utilisateur**, et le serveur ne voit jamais aucune donnée en clair.

### Distinction importante

| | Rôle | Où |
|---|---|---|
| **Compte (email/mdp)** | Authentifie l'utilisateur (mode Cloud uniquement) | Firebase Auth |
| **Master Password** | Chiffre/déchiffre le vault | Jamais envoyé au serveur |

### Flux de chiffrement

```
Master Password (connu uniquement de l'utilisateur)
        │
        ▼
   Argon2id (dérivation, salt unique par utilisateur)
        │
        ▼
   Clé de dérivation (KEK) → déchiffre la DEK (clé de chiffrement des données)
        │
        ▼
   DEK → chiffre l'intégralité du vault (AES-256-GCM)
        │
        ▼
   Vault chiffré → stocké en local (.vault) OU envoyé à Firestore (blob illisible)
```

**Ce qui est chiffré :** l'intégralité du contenu du vault (`items` + `categories`) est sérialisée en JSON puis chiffrée **en un seul bloc** avec la DEK. Il n'y a pas de champ qui reste en clair — **`title` et `url` sont chiffrés comme `password` et `notes`**, contrairement à certains gestionnaires du marché qui ne chiffrent que le mot de passe et laissent fuiter le titre/l'URL en cas de compromission de la base.

La DEK elle-même est enveloppée deux fois indépendamment : une fois par une clé dérivée du master password, une fois par une clé dérivée du kit de récupération — ce qui permet de déverrouiller avec l'un OU l'autre sans jamais stocker le master password lui-même.

### Kit de récupération

Étant donné que le master password n'est jamais stocké ni récupérable côté serveur :
- Un **kit de récupération** est généré à la création du vault : un code alphanumérique lisible (24 octets aléatoires, alphabet sans caractères ambigus type `O/0/I/1`, formaté en groupes de 4 séparés par des tirets — pas de format BIP39/liste de mots à ce jour)
- Affiché **une seule fois**, avec trois moyens d'export disponibles : impression / export PDF (via la boîte d'impression native du système), téléchargement en image PNG (rendu Canvas), et téléchargement en **QR code** (utile pour un stockage physique compact)
- L'utilisateur doit le sauvegarder lui-même ; une **bannière de rappel automatique** s'affiche dans le coffre si la dernière confirmation date de plus de 90 jours (ou si elle n'a jamais eu lieu) — `VaultFile.recovery_kit_confirmed_at`, métadonnée non chiffrée du `.vault`, mise à jour par la commande `confirm_recovery_kit_saved`
- En cas d'oubli du master password, seul ce code permet de déchiffrer à nouveau le vault
- Sans master password **ni** kit de récupération : perte définitive des données (comportement volontaire et attendu d'un système zero-knowledge)

### Autres mesures

- Verrouillage automatique du vault après **5 minutes** d'inactivité (re-saisie du master password requise)
- Effacement automatique du presse-papiers après copie d'un mot de passe (**20 secondes**)
- Changement de master password protégé par re-saisie de l'ancien avant toute modification (évite qu'un poste resté déverrouillé sans surveillance permette un changement non autorisé)
- **Limitation des tentatives de déverrouillage local (rate limiting)** : un compteur d'échecs (partagé entre master password et kit de récupération) déclenche un blocage temporaire progressif — 5s dès 3 échecs, 30s dès 5, 2 min dès 7, 10 min dès 10, plafond 30 min. Stocké dans un fichier sidecar en clair à côté du `.vault` (`<fichier>.vault.attempts` — ce n'est pas un secret, voir le commentaire dans `src-tauri/src/lib.rs` pour la justification). Un échec dû à un fichier corrompu ne compte pas comme une tentative de devinette. Réinitialisé à chaque succès.

---

## Modes de fonctionnement

L'application distingue clairement deux modes, avec des logiques différentes :

### 💻 Mode Local (application bureau) — ✅ fonctionnel aujourd'hui

- **Pas de compte, pas d'email, pas d'authentification en ligne**
- À la première ouverture, l'utilisateur crée uniquement un **master password**
- Ce master password protège directement le fichier `.vault` local
- Fonctionne **100% hors ligne**, aucune connexion internet requise
- Le kit de récupération est essentiel ici (aucun autre moyen d'identification)
- Limite connue : un vault = un fichier = un appareil. Pas de synchronisation multi-device pour l'instant, en dehors d'une copie manuelle du fichier `.vault` (fonction "Export / sauvegarde" déjà disponible dans les Paramètres — voir [État actuel](#-état-actuel-du-projet))

### ☁️ Mode Cloud (application bureau + web) — 🔜 non implémenté, écran stub uniquement

- Création d'un **compte** (email + mot de passe via Firebase Auth) → authentification uniquement
- Puis création d'un **master password distinct** → chiffrement zero-knowledge des données
- Synchronisation automatique du vault chiffré avec Firestore
- Le web ne proposera **que** ce mode (pas de stockage local fiable et persistant dans un navigateur classique)
- Aujourd'hui, l'écran correspondant (`CloudComingSoon.tsx`) est un stub : il faut encore créer le projet Firebase, intégrer le SDK côté frontend, et adapter les commandes pour synchroniser le `VaultFile` chiffré avec Firestore. La logique de chiffrement (`vault-core`) ne changera pas : Firestore ne stockera que le JSON déjà chiffré, exactement comme le fichier `.vault` aujourd'hui.

### Choix du mode

- Le mode (Local ou Cloud) est choisi **une seule fois, à la création du vault**, uniquement sur l'application desktop
- **Pas de bascule possible en V1** — fonctionnalité prévue pour une version future

```
┌───────────────────────────────┐
│   Premier lancement (Desktop)  │
├────────────────┬───────────────┤
│   💻 Local      │   ☁️ Cloud     │
│  (hors ligne)   │  (Firestore)  │
│  ✅ fonctionnel  │  🔜 roadmap    │
│                 │               │
│  → Master pwd   │ → Email/mdp   │
│    uniquement   │ → puis Master │
│                 │   pwd         │
└────────────────┴───────────────┘
```

---

## Modèle de données

### User *(mode Cloud uniquement — non implémenté à ce jour)*
- `email`
- `passwordHash` (géré par Firebase Auth)
- `masterPasswordVerifier` (vérificateur, ≠ clé de chiffrement)
- `salt` (unique, pour Argon2id)
- `recoveryKit` (chiffré)

### VaultItem *(reflète l'implémentation réelle, `src/types.ts` / `vault-core/src/lib.rs`)*
- `id`
- `item_type` — `"password"`, `"note"`, ou `"passkey"` (métadonnées FIDO2/WebAuthn publiques uniquement — voir DEV_NOTES.md, aucune cérémonie WebAuthn réalisée par l'app)
- `title` — nom de l'entrée (ex: "Gmail")
- `username` — identifiant / email associé
- `password` — mot de passe
- `url` — lien du site
- `notes` — champ libre
- `category` — nom d'album (liste libre créée par l'utilisateur, plus de catégories figées dans le code ; l'album "Général" ne peut pas être supprimé)
- `tags` — tags libres, multiples, indépendants de `category` (qui reste un classement exclusif "un album par entrée"), normalisés côté Rust (trim, dédoublonnage)
- `favorite` — booléen, épinglage
- `expires_at` — date ISO optionnelle de rotation prévue (déclenche un badge d'expiration et remonte dans l'audit de sécurité)
- `custom_fields` — champs personnalisés libres (`text`, `password`, `email`, `url`, ou `totp` — ce dernier calcule un code à 6 chiffres en direct, RFC 6238, accepte le collage d'une URI `otpauth://`)
- `attachments` — pièces jointes chiffrées, encodées en base64, limitées à 3 Mo par fichier
- `password_history` — anciennes valeurs de `password`, horodatées, alimentées automatiquement quand le mot de passe change réellement (plafonné à 20 entrées) ; sert aussi de base à l'audit de sécurité pour dater précisément le dernier changement, plus fiable que `updated_at` qui bouge sur toute modification du champ
- `last_used_at` / `created_at` / `updated_at`
- `passkey` — présent uniquement pour `item_type: "passkey"` : `credential_id`, `rp_id`, `rp_name`, `user_handle`, `public_key`, `algorithm` (jamais de clé privée)
- `generation_rule` — règle de génération mémorisée pour cette entrée (longueur, alphanumérique uniquement, caractères exclus), préchargée dans le générateur à la réédition

Tous ces champs sont chiffrés ensemble avec le reste du vault (voir [Sécurité](#sécurité--zero-knowledge)) — rien n'en sort en clair, y compris `title` et `url`.

---

## ✅ État actuel du projet

Ce qui suit reflète **ce qui est réellement codé et testé aujourd'hui** (application desktop, mode Local), au-delà des cases cochées du MVP initial.

### Cœur & sécurité
- [x] Création de vault local (`.vault`) protégé par master password
- [x] Génération et affichage unique du kit de récupération (code alphanumérique)
- [x] Déverrouillage par master password ou par kit de récupération
- [x] Chiffrement de l'intégralité du vault (y compris `title`/`url`, pas seulement `password`/`notes`)
- [x] Fichier `.vault` versionné (`VaultFile.version`) pour anticiper les migrations de schéma
- [x] Checksum d'intégrité SHA-256, vérifié avant l'Argon2id (détecte un fichier corrompu/tronqué)
- [x] Limitation progressive des tentatives de déverrouillage local (rate limiting)
- [x] Changement de master password (avec re-saisie de l'ancien)
- [x] Verrouillage automatique après inactivité, durée réglable (1/5/10/15/30 min, ou jamais)
- [x] Verrouillage immédiat au clavier (`Ctrl/Cmd+L`)
- [x] Verrouillage optionnel sur perte de focus de la fenêtre (couvre veille/verrouillage de session)
- [x] Sauvegardes automatiques périodiques vers un dossier au choix, avec rotation
- [x] Effacement automatique du presse-papiers après copie (20s)
- [x] `vault-core` testé indépendamment de la GUI (`cargo test`, 10/10)

### Entrées & organisation
- [x] CRUD complet des entrées (mot de passe et note sécurisée)
- [x] Albums (catégories) libres, créés/renommés/supprimés par l'utilisateur, jamais de perte de données silencieuse au niveau d'un album
- [x] Tags multiples par entrée, filtrables, indépendants des albums
- [x] Champs personnalisés par entrée, y compris TOTP
- [x] Pièces jointes chiffrées (≤3 Mo)
- [x] Historique des mots de passe par entrée (horodaté, plafonné à 20 versions)
- [x] Favoris / épinglage, avec tri "Favoris d'abord"
- [x] Tri par nom, date de modification récente, ou favoris
- [x] Date d'expiration/rappel de rotation par entrée
- [x] Recherche / filtrage des entrées (titre, identifiant, URL, tags, notes)
- [x] Icônes de site automatiques (favicon), repli sur la lettre initiale si indisponible
- [x] Générateur de mots de passe (longueur, majuscules, minuscules, chiffres, symboles) et générateur de phrase de passe mémorisable (liste EFF, façon Diceware)
- [x] Jauge de force visuelle à la création du master password (zxcvbn-ts, avec temps de crack estimé)
- [x] Suppression avec délai d'annulation (6s, toast "Annuler")
- [x] Sélection multiple (déplacer vers un album, ajouter un tag, ou supprimer plusieurs entrées à la fois)

### Audit & import/export
- [x] Audit de sécurité local (mots de passe faibles/réutilisés/inchangés depuis 180j via `password_history`/jamais utilisés depuis 270j/expirant bientôt/doublons probables par site ou titre), 100% local
- [x] Vérification Have I Been Pwned en k-anonymat (seuls les 5 premiers caractères du hash SHA-1 quittent la machine)
- [x] Import CSV avec détection automatique du format (Chrome/Edge/Brave, Firefox, Bitwarden, LastPass, générique)
- [x] Export CSV vers Bitwarden et KeePass (formats vérifiés officiellement), avec avertissement clair (mots de passe en clair dans ces fichiers)
- [x] Export / sauvegarde du fichier `.vault` vers un autre emplacement, sauvegardes automatiques périodiques (dossier + fréquence au choix, rotation)
- [x] Export du kit de récupération en PDF (impression native), image PNG, et QR code
- [x] Rappel automatique (bannière + notification native) de reconfirmer l'accès au kit de récupération après 90 jours
- [x] Notification native pour les entrées expirant sous 7 jours
- [x] Coffres récents (liste des derniers `.vault` ouverts, chemins uniquement — aucun secret)
- [x] Mise à jour automatique (vérification à l'ouverture + bouton manuel, installation avec confirmation explicite)

### Confort
- [x] Thème clair/sombre (suit la préférence système, forçable, mémorisé)
- [x] Raccourcis clavier (`Ctrl/Cmd+F` recherche, `Ctrl/Cmd+N` nouvelle entrée, `Ctrl/Cmd+L` verrouiller, `Échap` ferme les modales)

### Pas encore fait
- [ ] Mode Cloud (Firebase Auth + Firestore) — écran stub uniquement
- [ ] Version Web — dépend du mode Cloud, pas commencée
- [ ] Tests d'intégration Tauri (seul `vault-core` a des tests automatisés aujourd'hui)
- [ ] Audit de sécurité indépendant avant tout usage en production
- [ ] Icônes définitives de l'application (placeholders générés automatiquement)

---

## 🗺️ Roadmap — idées à explorer

Idées non encore implémentées, classées par thème. Une première vague (checksum d'intégrité, rate limiting, tags, historique des mots de passe, rappel du kit de récupération, QR code, jauge de force) a été implémentée et déplacée vers [État actuel du projet](#-état-actuel-du-projet). Ce qui suit reste ouvert :

### Sécurité renforcée
- **Biométrie locale** (Windows Hello / libsecret Linux) pour déverrouiller sans retaper le master password à chaque fois, tout en gardant ce dernier comme clé réelle sous-jacente. Nécessite une intégration native par OS (API Windows Hello, D-Bus `org.freedesktop.secrets` sous Linux) ; une première étape plus simple serait un stockage du master password dans le trousseau OS via la crate Rust `keyring`, gated par un opt-in explicite — mais ce ne serait pas de la biométrie à proprement parler.
- **Mode "leurre" / panic password** (optionnel, plus avancé) qui ouvre un vault vide ou factice sous contrainte — niche mais différenciant. Nécessite de repenser le modèle de déverrouillage (double vault ou vault factice généré à la volée) ; risque de bugs de sécurité si fait à la légère.

### Fonctionnalités utilisateur
- **Mode hors-ligne avec sync différée pour le mode Cloud** — modifications en local si pas de réseau, synchronisation au retour de connexion. À concevoir en même temps que le mode Cloud lui-même, qui aujourd'hui dépendrait totalement du réseau.

### Kit de récupération — approfondissement
- Le format actuel est un **code alphanumérique** (24 octets, groupes de 4) — pas de format BIP39 (liste de mots). À évaluer si un format mnémotechnique serait plus simple à recopier/vérifier à la main.

### Architecture / technique
- **Flux de restauration explicite** d'un `.vault` existant comme point d'entrée dédié — aujourd'hui, ouvrir un vault existant passe par l'écran "Déverrouiller" standard (qui accepte n'importe quel fichier `.vault`, y compris une sauvegarde restaurée), ce qui couvre déjà le besoin sans écran dédié.
- **Audit indépendant du KDF** — les paramètres Argon2id (`m_cost=19 Mo`, `t_cost=2`, `p_cost=1`) sont documentés dans le code et couverts par les tests automatisés de `vault-core`, mais un audit de sécurité tiers justifiant ces valeurs (et leur tenue face à l'évolution du matériel) reste à faire avant tout usage en production.

### UX
- Rien d'identifié pour l'instant au-delà de ce qui a été implémenté (jauge de force, rappel du kit de récupération).

---

## Plateformes cibles

| Plateforme | Mode disponible | Techno | Statut |
|---|---|---|---|
| Web (desktop & mobile via navigateur) | Cloud uniquement | React | 🔜 non démarré (dépend du mode Cloud) |
| Application Windows | Local **ou** Cloud | Tauri v2 + React | ✅ Local fonctionnel · 🔜 Cloud stub |
| Application Linux | Local **ou** Cloud | Tauri v2 + React | ✅ Local fonctionnel · 🔜 Cloud stub |
| Application Android (.apk) | Local uniquement | Tauri v2 + React | 🚧 En cours — stockage app-privé, build CI ajouté mais non vérifié en conditions réelles (voir DEV_NOTES.md) |
