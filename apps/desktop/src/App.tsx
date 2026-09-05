import { useEffect, useState } from "react";
import type { Screen, VaultItem, VaultMode } from "./types";
import type { VaultSnapshot } from "./lib/tauri";
import { rememberVault } from "./lib/recentVaults";
import { isMobilePlatform } from "./lib/platform";
import { getMobileVaultPath, mobileVaultExists } from "./lib/mobileVault";
import { ModeSelect } from "./pages/ModeSelect";
import { CreateLocalVault } from "./pages/CreateLocalVault";
import { UnlockVault } from "./pages/UnlockVault";
import { VaultView } from "./pages/VaultView";
import { CloudComingSoon } from "./pages/CloudComingSoon";
import { ThemeToggle } from "./components/ThemeToggle";
import { applyPalette, readStoredPalette } from "./lib/accentColor";

// Applique la palette d'accent dès le premier rendu (avant VaultView),
// pour éviter un flash de la couleur par défaut sur les pages de connexion.
(function initAccentPalette() {
  const dark = document.documentElement.classList.contains("dark");
  applyPalette(readStoredPalette(), dark);
})();

export default function App() {
  return (
    <>
      <ThemeToggle />
      <AppScreens />
    </>
  );
}

function AppScreens() {
  const [screen, setScreen] = useState<Screen>("mode-select");
  const [mode, setMode] = useState<VaultMode | null>(null);
  const [vaultItems, setVaultItems] = useState<VaultItem[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [recoveryKitConfirmedAt, setRecoveryKitConfirmedAt] = useState<string | null>(null);
  const [vaultRecoveryCode, setVaultRecoveryCode] = useState<string | null>(null);
  // Un fichier .vault existant sur cette machine => on propose direct le déverrouillage.
  const [hasExistingChoice, setHasExistingChoice] = useState<"create" | "unlock" | null>(null);
  // Mobile uniquement (voir lib/mobileVault.ts) : pas de sélecteur de fichier
  // façon desktop dans cette première passe, le vault vit dans le
  // répertoire privé de l'app à un chemin fixe, résolu une fois ici. `null`
  // = pas encore résolu (évite un flash "Créer" avant de savoir qu'un
  // coffre existe déjà côté Android).
  const [mobileFixedPath, setMobileFixedPath] = useState<string | null>(null);

  const backToModeSelect = () => {
    setMode(null);
    setHasExistingChoice(null);
    setScreen("mode-select");
  };

  useEffect(() => {
    if (screen !== "local-create" || mode !== "local" || !isMobilePlatform() || mobileFixedPath) return;
    let cancelled = false;
    (async () => {
      const path = await getMobileVaultPath();
      const exists = await mobileVaultExists(path);
      if (cancelled) return;
      setMobileFixedPath(path);
      setHasExistingChoice(exists ? "unlock" : "create");
    })();
    return () => {
      cancelled = true;
    };
  }, [screen, mode, mobileFixedPath]);

  const enterVault = (path: string, snapshot: VaultSnapshot) => {
    rememberVault(path);
    setVaultItems(snapshot.items);
    setCategories(snapshot.categories);
    setRecoveryKitConfirmedAt(snapshot.recoveryKitConfirmedAt);
    setScreen("vault");
  };

  if (screen === "mode-select") {
    return (
      <ModeSelect
        onSelectLocal={() => {
          setMode("local");
          setScreen("local-create");
        }}
        onSelectCloud={() => {
          setMode("cloud");
          setScreen("cloud-signin");
        }}
      />
    );
  }

  if (screen === "local-create" && mode === "local") {
    const mobile = isMobilePlatform();
    // Le chemin fixe mobile est résolu de façon asynchrone (useEffect
    // ci-dessus) : le temps qu'il le soit, ne rien afficher plutôt que de
    // montrer brièvement l'UI desktop (bouton "choisir l'emplacement").
    if (mobile && !mobileFixedPath) return null;

    if (hasExistingChoice === "unlock") {
      return (
        <UnlockVault
          onBack={backToModeSelect}
          onUnlocked={(path, snapshot) => enterVault(path, snapshot)}
          fixedPath={mobile ? mobileFixedPath : null}
        />
      );
    }
    return (
      <div>
        <CreateLocalVault
          onBack={backToModeSelect}
          onVaultReady={(path, snapshot) => enterVault(path, snapshot)}
          onRecoveryCode={(code) => setVaultRecoveryCode(code)}
          fixedPath={mobile ? mobileFixedPath : null}
        />
        {!mobile && <ExistingVaultLink onClick={() => setHasExistingChoice("unlock")} />}
      </div>
    );
  }

  if (screen === "cloud-signin" && mode === "cloud") {
    return <CloudComingSoon onBack={backToModeSelect} />;
  }

  if (screen === "vault") {
    return (
      <VaultView
        initialItems={vaultItems}
        initialCategories={categories}
        initialRecoveryKitConfirmedAt={recoveryKitConfirmedAt}
        recoveryCode={vaultRecoveryCode}
        onLocked={() => {
          setVaultItems([]);
          setCategories([]);
          setRecoveryKitConfirmedAt(null);
          setVaultRecoveryCode(null);
          setScreen(mode === "local" ? "local-create" : "cloud-signin");
          setHasExistingChoice("unlock");
        }}
      />
    );
  }

  return null;
}

function ExistingVaultLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="fixed bottom-6 left-1/2 -translate-x-1/2 text-xs text-muted hover:text-accent-strong transition-colors"
    >
      J'ai déjà un fichier .vault → Déverrouiller
    </button>
  );
}
