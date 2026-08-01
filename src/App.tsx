import { useState } from "react";
import type { Screen, VaultItem, VaultMode } from "./types";
import type { VaultSnapshot } from "./lib/tauri";
import { ModeSelect } from "./pages/ModeSelect";
import { CreateLocalVault } from "./pages/CreateLocalVault";
import { UnlockVault } from "./pages/UnlockVault";
import { VaultView } from "./pages/VaultView";
import { CloudComingSoon } from "./pages/CloudComingSoon";
import { ThemeToggle } from "./components/ThemeToggle";

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
  // Un fichier .vault existant sur cette machine => on propose direct le déverrouillage.
  const [hasExistingChoice, setHasExistingChoice] = useState<"create" | "unlock" | null>(null);

  const backToModeSelect = () => {
    setMode(null);
    setHasExistingChoice(null);
    setScreen("mode-select");
  };

  const enterVault = (snapshot: VaultSnapshot) => {
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
    if (hasExistingChoice === "unlock") {
      return (
        <UnlockVault
          onBack={backToModeSelect}
          onUnlocked={(_path, snapshot) => enterVault(snapshot)}
        />
      );
    }
    return (
      <div>
        <CreateLocalVault
          onBack={backToModeSelect}
          onVaultReady={(_path, snapshot) => enterVault(snapshot)}
        />
        <ExistingVaultLink onClick={() => setHasExistingChoice("unlock")} />
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
        onLocked={() => {
          setVaultItems([]);
          setCategories([]);
          setRecoveryKitConfirmedAt(null);
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
