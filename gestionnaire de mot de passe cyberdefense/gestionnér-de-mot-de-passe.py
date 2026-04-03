import tkinter as tk
from tkinter import simpledialog, messagebox
import pyotp
import json, os, base64, secrets, pyperclip
from cryptography.fernet import Fernet

# --- CONFIGURATION ---
DB_FILE = "passwords.enc"
TOTP_SECRET_FILE = "totp.secret"
MAX_TRIES = 5
BACKUP_FILE = "backup.enc"

# --- FONCTIONS DE SÉCURITÉ ---
def derive_key(master_password):
    return base64.urlsafe_b64encode(master_password.encode('utf-8').ljust(32, b'0'))

def generate_password(length=16):
    alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()-_=+"
    return ''.join(secrets.choice(alphabet) for _ in range(length))

def load_db(key):
    if not os.path.exists(DB_FILE):
        return {}
    with open(DB_FILE, "rb") as f:
        encrypted_data = f.read()
    fernet = Fernet(key)
    return json.loads(fernet.decrypt(encrypted_data))

def save_db(db, key):
    fernet = Fernet(key)
    encrypted_data = fernet.encrypt(json.dumps(db).encode())
    with open(DB_FILE, "wb") as f:
        f.write(encrypted_data)

def init_totp():
    if os.path.exists(TOTP_SECRET_FILE):
        with open(TOTP_SECRET_FILE, "r") as f:
            secret = f.read().strip()
    else:
        secret = pyotp.random_base32()
        with open(TOTP_SECRET_FILE, "w") as f:
            f.write(secret)
        messagebox.showinfo("TOTP Secret", f"Enregistre ce secret dans Google Authenticator : {secret}")
    return pyotp.TOTP(secret)

def backup_db():
    fernet = Fernet(Fernet.generate_key())
    with open(DB_FILE, "rb") as f:
        data = f.read()
    encrypted = fernet.encrypt(data)
    with open(BACKUP_FILE, "wb") as f:
        f.write(encrypted)
    messagebox.showinfo("Sauvegarde", f"Sauvegarde chiffrée créée : {BACKUP_FILE}")

# --- AUTHENTIFICATION ---
attempts = 0
totp = init_totp()
while attempts < MAX_TRIES:
    master_password = simpledialog.askstring("Master Password", "Entrez le mot de passe maître :", show="*")
    code_2fa = simpledialog.askstring("2FA", "Entrez le code 2FA :")
    if totp.verify(code_2fa):
        key = derive_key(master_password)
        try:
            db = load_db(key)
            break
        except:
            messagebox.showerror("Erreur", "Mot de passe maître incorrect")
    else:
        messagebox.showerror("Erreur", "Code 2FA invalide")
    attempts += 1

if attempts >= MAX_TRIES:
    if os.path.exists(DB_FILE):
        os.remove(DB_FILE)
    messagebox.showerror("Sécurité", "Trop de tentatives ! Base de données détruite")
    exit()

# --- INTERFACE PRINCIPALE ---
root = tk.Tk()
root.title("Gestionnaire de mots de passe ultra sécurisé")

lst = tk.Listbox(root, width=50)
lst.pack(padx=10, pady=10)

def refresh_list():
    lst.delete(0, tk.END)
    for site in db:
        lst.insert(tk.END, site)

def add_password():
    site = simpledialog.askstring("Ajouter site", "Nom du site :")
    pwd = simpledialog.askstring("Mot de passe", "Mot de passe (laisser vide pour générer) :")
    if not pwd:
        pwd = generate_password()
        messagebox.showinfo("Mot de passe généré", f"Mot de passe : {pwd}")
    db[site] = pwd
    save_db(db, key)
    refresh_list()

def view_password():
    sel = lst.curselection()
    if sel:
        site = lst.get(sel[0])
        pwd = db[site]
        pyperclip.copy(pwd)
        messagebox.showinfo("Mot de passe", f"Mot de passe copié dans le presse-papiers pour {site}")

def modify_password():
    sel = lst.curselection()
    if sel:
        site = lst.get(sel[0])
        new_pwd = simpledialog.askstring("Modifier", f"Nouveau mot de passe pour {site} :")
        if new_pwd:
            db[site] = new_pwd
            save_db(db, key)
            refresh_list()

def delete_password():
    sel = lst.curselection()
    if sel:
        site = lst.get(sel[0])
        if messagebox.askyesno("Supprimer", f"Supprimer {site} ?"):
            db.pop(site)
            save_db(db, key)
            refresh_list()

def generate_and_copy():
    pwd = generate_password()
    pyperclip.copy(pwd)
    messagebox.showinfo("Mot de passe généré", f"Mot de passe généré et copié dans le presse-papiers : {pwd}")

# --- BOUTONS ---
tk.Button(root, text="Ajouter", command=add_password).pack(pady=2)
tk.Button(root, text="Voir / Copier", command=view_password).pack(pady=2)
tk.Button(root, text="Modifier", command=modify_password).pack(pady=2)
tk.Button(root, text="Supprimer", command=delete_password).pack(pady=2)
tk.Button(root, text="Générer mot de passe", command=generate_and_copy).pack(pady=2)
tk.Button(root, text="Sauvegarde chiffrée", command=backup_db).pack(pady=2)

refresh_list()
root.mainloop()