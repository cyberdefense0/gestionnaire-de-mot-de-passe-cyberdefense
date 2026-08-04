import { expect, browser, $ } from "@wdio/globals";

describe("Entrée Passkey (métadonnées uniquement, §3.3)", () => {
  it("crée une entrée passkey, sans bouton copier, et elle persiste après verrouillage", async () => {
    await (await $("button*=Ajouter")).click();
    await (await $("button*=🪪 Passkey")).click();

    await (await $('input[placeholder="https://"]')).setValue(""); // pas de champ URL classique pour ce type

    const titleInput = await $('input[name="title"], input').nth(0);
    await titleInput.setValue("GitHub (passkey test)");

    const rpIdInput = await $('input[placeholder="example.com"]');
    await rpIdInput.setValue("github.com");
    const rpNameInput = await $('input[placeholder="Example Inc."]');
    await rpNameInput.setValue("GitHub");
    const credentialIdInput = await $('input[class*="font-mono"]').nth(0);
    await credentialIdInput.setValue("cred-e2e-test-123");

    await (await $("button*=Enregistrer")).click();

    const card = await $("p*=GitHub (passkey test)");
    await card.waitForDisplayed({ timeout: 10000 });

    // Aucun bouton "copier" pour une passkey : rien de copiable côté client
    await card.moveTo();
    const copyButton = await $('[title*="Copier le mot de passe"]');
    expect(await copyButton.isExisting()).toBe(false);

    // Persistance après verrouillage/déverrouillage
    await browser.keys(["Control", "l"]);
    await (await $('input[type="password"]')).setValue("Un-Master-Password-Long-Et-Solide-42!");
    await (await $("button*=Déverrouiller")).click();
    await (await $("p*=GitHub (passkey test)")).waitForDisplayed({ timeout: 10000 });
  });
});
