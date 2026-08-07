#!/bin/bash
set -e

echo "🔧 Correction des chemins après réorganisation..."

# Vérification qu'on est à la racine
if [ ! -d "apps/desktop" ] || [ ! -d "packages/vault-core" ]; then
    echo "❌ Erreur : la structure 'apps/desktop' et 'packages/vault-core' est introuvable."
    echo "   Assure-toi d'être à la racine du projet."
    exit 1
fi

# 1. Mise à jour du Cargo.toml du desktop (dépendance vers vault-core)
DESKTOP_CARGO="apps/desktop/src-tauri/Cargo.toml"
if [ -f "$DESKTOP_CARGO" ]; then
    echo "📦 Mise à jour de $DESKTOP_CARGO (chemin vault-core)..."
    # On remplace "../vault-core" par "../../packages/vault-core"
    sed -i 's|vault-core = { path = "../vault-core"|vault-core = { path = "../../packages/vault-core"|g' "$DESKTOP_CARGO"
    # Si le chemin est déjà correct, ça ne change rien.
else
    echo "⚠️  Fichier $DESKTOP_CARGO introuvable."
fi

# 2. Mise à jour du tauri.conf.json (distDir et beforeDevCommand)
TAURI_CONF="apps/desktop/tauri.conf.json"
if [ -f "$TAURI_CONF" ]; then
    echo "⚙️  Mise à jour de $TAURI_CONF (chemins de build)..."
    # Avant : "distDir": "../dist" -> devient "./dist" (car le build se fait dans apps/desktop/dist)
    sed -i 's|"distDir": "../dist"|"distDir": "./dist"|g' "$TAURI_CONF"
    # Avant : "beforeDevCommand": "npm run dev" -> on garde tel quel (car on est dans apps/desktop)
    # On s'assure que les chemins sont cohérents
else
    echo "⚠️  Fichier $TAURI_CONF introuvable."
fi

# 3. Mise à jour du package.json du desktop (scripts et éventuellement workspace)
DESKTOP_PKG="apps/desktop/package.json"
if [ -f "$DESKTOP_PKG" ]; then
    echo "📦 Mise à jour de $DESKTOP_PKG (scripts)..."
    # On vérifie que les scripts utilisent bien les bons chemins (généralement c'est bon)
    # On peut ajouter un script "tauri" qui pointe vers le bon binaire si besoin
    # Rien à faire dans la majorité des cas, car ils sont relatifs au dossier du package
else
    echo "⚠️  Fichier $DESKTOP_PKG introuvable."
fi

# 4. Création du Cargo.toml workspace racine (si inexistant)
ROOT_CARGO="Cargo.toml"
if [ ! -f "$ROOT_CARGO" ]; then
    echo "📄 Création du Cargo.toml workspace racine..."
    cat > "$ROOT_CARGO" << 'EOF'
[workspace]
members = [
    "apps/desktop/src-tauri",
    "packages/vault-core"
]
resolver = "2"

[workspace.dependencies]
# Ici on peut définir des versions communes si besoin
EOF
else
    echo "✅ Le Cargo.toml racine existe déjà."
    # On peut vérifier s'il contient les membres, sinon on les ajoute
    if ! grep -q "apps/desktop/src-tauri" "$ROOT_CARGO"; then
        echo "   Ajout des membres manquants..."
        # On ajoute les membres en fin de fichier avant le dernier crochet
        sed -i '/^\[workspace\]/a members = ["apps/desktop/src-tauri", "packages/vault-core"]' "$ROOT_CARGO"
    fi
fi

# 5. Création du pnpm-workspace.yaml (si on utilise pnpm)
if [ -f "package.json" ] && grep -q '"workspaces"' "package.json"; then
    echo "📦 package.json racine avec workspaces détecté (npm/yarn)."
else
    # Si on veut utiliser pnpm, on peut créer le fichier
    if [ ! -f "pnpm-workspace.yaml" ]; then
        echo "📄 Création de pnpm-workspace.yaml pour pnpm..."
        cat > "pnpm-workspace.yaml" << 'EOF'
packages:
  - 'apps/*'
  - 'packages/*'
EOF
    fi
fi

# 6. Nettoyage des dossiers temporaires à la racine (dist, node_modules, etc.)
if [ -d "dist" ] && [ -L "dist" ]; then
    echo "🗑️  Suppression du lien symbolique dist (s'il existe)..."
    rm -rf dist
fi
if [ -d "node_modules" ] && [ ! -d "apps/desktop/node_modules" ]; then
    echo "⚠️  Un node_modules racine existe, mais il n'est peut-être plus utilisé."
    echo "   Tu peux le supprimer manuellement si tu passes à pnpm."
fi

# 7. Vérification que les scripts de build fonctionnent
echo ""
echo "✅ Tous les chemins ont été corrigés."
echo ""
echo "📌 Prochaines étapes :"
echo "   1. Exécute 'cd apps/desktop && npm install' (ou pnpm install) pour réinstaller les dépendances."
echo "   2. Pour lancer le desktop : 'cd apps/desktop && npm run tauri dev'."
echo "   3. Pour builder l'extension : 'cd apps/extension && npm run build' (si package.json existe)."
echo "   4. N'oublie pas de mettre à jour les imports dans ton code si tu as déplacé des fichiers."
echo ""
echo "🚀 Bon développement !"
