# Tests E2E Desktop (roadmap §4.1)

Squelette de tests de bout en bout (UI + backend Rust/Tauri), basé sur
[`tauri-driver`](https://v2.tauri.app/develop/tests/webdriver/) (le pattern
officiellement recommandé par Tauri pour WebDriver, compatible
WebdriverIO **et** un client WebDriver générique — ici on utilise
WebdriverIO, plus simple à configurer).

## ⚠️ Non exécuté dans le sandbox de développement

`tauri-driver` pilote le **binaire compilé** de l'application (`src-tauri`),
qui ne compile pas dans le sandbox utilisé pour produire cette livraison —
voir `DEV_NOTES.md` (Rust 1.75 vs édition 2024 requise par une dépendance
transitive de Tauri v2). Ces tests sont donc écrits et prêts, mais
**jamais lancés ni vérifiés ici**. Premliterie build réel à faire chez vous.

## Prérequis (chez vous, pas ici)

```bash
# 1. WebDriver natif par OS (déjà probablement présent) :
#    - Linux : WebKitWebDriver (fourni par webkit2gtk-driver)
#    sudo apt install webkit2gtk-driver
#    - Windows : Microsoft Edge Driver (souvent déjà présent avec Edge)

# 2. tauri-driver
cargo install tauri-driver --locked

# 3. Build de l'app en mode debug (tauri-driver pilote le binaire, pas `tauri dev`)
npm run tauri build -- --debug

# 4. Dépendances de test
cd e2e && npm install
```

## Lancer les tests

```bash
# Terminal 1 : démarrer tauri-driver (garde le terminal ouvert)
tauri-driver --port 4444

# Terminal 2 : lancer la suite WebdriverIO
cd e2e && npm test
```

## Ce qui est couvert (`tests/`)

1. `01-create-vault.spec.ts` — création d'un nouveau coffre local, jauge de
   force du master password, affichage du kit de récupération, confirmation
   de sauvegarde.
2. `02-item-crud.spec.ts` — ajout d'une entrée mot de passe, modification,
   recherche (`/` puis Ctrl+F), suppression avec fenêtre d'annulation.
3. `03-unlock-methods.spec.ts` — verrouillage (`Ctrl+L`), déverrouillage par
   master password, déverrouillage par kit de récupération, rate limiting
   après plusieurs échecs.
4. `04-csv-import.spec.ts` — import CSV (format générique), vérification que
   les entrées apparaissent bien et persistent après un verrouillage/déverrouillage.
5. `05-keyboard-nav.spec.ts` — navigation clavier complète (§1.2) : flèches,
   Entrée, Espace, raccourcis de copie.
6. `06-passkey-item.spec.ts` — création d'une entrée Passkey (métadonnées
   uniquement, voir README), vérifie l'absence de bouton "copier" (rien à
   copier côté client) et la persistance après verrouillage/déverrouillage.
7. `07-encrypted-export.spec.ts` — export chiffré indépendant (.json) avec
   mot de passe dédié, puis restauration dans un second coffre vide,
   vérifie l'échec propre avec un mauvais mot de passe d'export.

## Ce qui n'est PAS couvert (hors périmètre §4.1)

- Toute cérémonie WebAuthn/FIDO2 réelle (création/assertion) : cette app ne
  le fait pas, voir `README.md`/`DEV_NOTES.md`.
- Autofill navigateur : prévu côté extension séparée, pas cette app.
- Notifications natives OS : `tauri-plugin-notification` n'est pas
  observable de façon fiable depuis WebDriver (c'est une notification
  système, hors du DOM piloté) — testé manuellement.
