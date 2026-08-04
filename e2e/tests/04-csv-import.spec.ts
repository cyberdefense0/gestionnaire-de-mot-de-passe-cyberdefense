import { expect, browser, $ } from "@wdio/globals";
import path from "node:path";

describe("Import CSV", () => {
  it("importe un CSV générique et les entrées persistent après verrouillage/déverrouillage", async () => {
    const settingsButton = await $('button[title*="Paramètres"], button*=Paramètres');
    if (await settingsButton.isExisting()) await settingsButton.click();

    const importButton = await $("button*=Importer");
    await importButton.waitForDisplayed({ timeout: 10000 });
    await importButton.click();

    // La sélection de fichier passe par une boîte de dialogue native — à
    // stubber côté mock du plugin dialog pour un run headless, ou fournir
    // le chemin directement si l'équipe QA pilote le picker autrement.
    const fixture = path.resolve(__dirname, "../fixtures/sample-generic.csv");
    // eslint-disable-next-line no-console
    console.log("Fixture attendue :", fixture, "(voir e2e/fixtures/)");

    const previewHeader = await $("p*=aperçu");
    await previewHeader.waitForDisplayed({ timeout: 10000 });
    const confirmImport = await $("button*=Confirmer");
    await confirmImport.click();

    const imported = await $("p*=Exemple Import CSV");
    await imported.waitForDisplayed({ timeout: 10000 });

    // Persistance après verrouillage/déverrouillage
    await browser.keys(["Control", "l"]);
    const masterInput = await $('input[type="password"]');
    await masterInput.setValue("Un-Master-Password-Long-Et-Solide-42!");
    await (await $("button*=Déverrouiller")).click();

    const stillThere = await $("p*=Exemple Import CSV");
    await stillThere.waitForDisplayed({ timeout: 10000 });
    expect(await stillThere.isDisplayed()).toBe(true);
  });
});
