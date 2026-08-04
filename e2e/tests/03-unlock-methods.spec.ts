import { expect, browser, $ } from "@wdio/globals";

describe("Verrouillage / déverrouillage", () => {
  it("Ctrl/Cmd+L verrouille immédiatement, déverrouillage par master password fonctionne", async () => {
    await browser.keys(["Control", "l"]);
    const masterInput = await $('input[type="password"]');
    await masterInput.waitForDisplayed({ timeout: 10000 });
    await masterInput.setValue("Un-Master-Password-Long-Et-Solide-42!");
    await (await $("button*=Déverrouiller")).click();
    await (await $('input[placeholder*="Rechercher"]')).waitForDisplayed({ timeout: 10000 });
  });

  it("déverrouillage par kit de récupération fonctionne (chemin alternatif)", async () => {
    await browser.keys(["Control", "l"]);
    const useRecoveryLink = await $("button*=kit de récupération");
    await useRecoveryLink.waitForDisplayed({ timeout: 10000 });
    await useRecoveryLink.click();
    const recoveryInput = await $('input[placeholder*="XXXX"], input[name="recoveryCode"]');
    // Remplacer par un vrai code généré lors de la création du coffre de test.
    await recoveryInput.setValue("REMPLACER-PAR-LE-CODE-REEL-DU-COFFRE-DE-TEST");
    await (await $("button*=Déverrouiller")).click();
  });

  it("rate limiting progressif après plusieurs échecs de master password", async () => {
    await browser.keys(["Control", "l"]);
    const masterInput = await $('input[type="password"]');
    await masterInput.waitForDisplayed({ timeout: 10000 });
    for (let i = 0; i < 3; i++) {
      await masterInput.setValue(`mauvais-mot-de-passe-${i}`);
      await (await $("button*=Déverrouiller")).click();
      await browser.pause(300);
    }
    // Après 3 échecs : blocage de 5s attendu, message explicite dans l'UI.
    const rateLimitMsg = await $("p*=Réessayez dans");
    await rateLimitMsg.waitForDisplayed({ timeout: 5000 });
    expect(await rateLimitMsg.isDisplayed()).toBe(true);
  });
});
