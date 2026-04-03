# 🔐 SecureVault

Gestionnaire de mots de passe **zero-knowledge** (type Bitwarden).

## 🚀 Features

* 🔐 Chiffrement AES-256 côté client
* 🔑 PBKDF2 (310k iterations)
* 🔒 2FA (TOTP)
* 🔑 WebAuthn (passwordless)
* ☁️ Sync multi-device
* 🤝 Partage sécurisé (RSA/ECC)

## 🏗️ Stack

* Frontend: Next.js
* Backend: FastAPI
* Mobile: React Native
* DB: PostgreSQL

## ⚠️ Sécurité

Le serveur ne voit jamais les mots de passe en clair.

## ▶️ Lancer le projet

```bash
docker-compose up --build
```
