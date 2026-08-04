import { expect, browser, $ } from "@wdio/globals";

/**
 * NOTE : l'app ne pose pas d'attributs `data-testid` systématiques. Les
 * sélecteurs ci-dessous ciblent du texte/placeholder visible, à ajuster au
 * premier vrai run si le wording a changé depuis l'écriture de ce test
 * (voir e2e/README.md — ces tests n'ont jamais été exécutés dans le sandbox
 * de dev).
 */
describe("Création d'un coffre local", () => {
  it("crée un vault, affiche le kit de récupération et entre dans le coffre", async () => {
    // Écran de sélection du mode (Local / Cloud)
    const localButton = await $("button=💻 Local");
    await localButton.waitForDisplayed({ timeout: 15000 });
    await localButton.click();

    const pathButton = await $("button*=Choisir où créer");
    await pathButton.waitForDisplayed();
    // La boîte de dialogue "Enregistrer sous" est native (GTK/Win32) —
    // hors de portée de WebDriver. En test manuel, ce chemin nécessite une
    // interaction humaine ou un stub de dialogue (voir Tauri mock plugins).
    // Ici on documente l'étape ; à automatiser via un mock du plugin dialog
    // si l'équipe QA veut un run 100% headless.

    const masterInput = await $("input[type=password]");
    await masterInput.waitForDisplayed({ timeout: 15000 });
    await masterInput.setValue("Un-Master-Password-Long-Et-Solide-42!");

    // Jauge de force (zxcvbn via Web Worker) doit apparaître sans geler l'UI
    const strengthLabel = await $("p*=Force :");
    await strengthLabel.waitForDisplayed({ timeout: 5000 });
    expect(await strengthLabel.getText()).toContain("Force");

    const createButton = await $("button*=Créer");
    await createButton.click();

    // Kit de récupération affiché une seule fois
    const recoveryCode = await $("[class*=font-mono]");
    await recoveryCode.waitForDisplayed({ timeout: 10000 });
    const code = await recoveryCode.getText();
    expect(code.length).toBeGreaterThan(10);

    const confirmSavedButton = await $("button*=confirmé");
    if (await confirmSavedButton.isExisting()) {
      await confirmSavedButton.click();
    }

    // On doit maintenant être dans le coffre (barre de recherche visible)
    const search = await $('input[placeholder*="Rechercher"]');
    await search.waitForDisplayed({ timeout: 10000 });
  });
});
