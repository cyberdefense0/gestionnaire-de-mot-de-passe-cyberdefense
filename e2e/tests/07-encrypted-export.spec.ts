import { expect, $ } from "@wdio/globals";

describe("Export chiffré indépendant (.json, §2.2)", () => {
  it("exporte avec un mot de passe dédié, puis restaure avec succès", async () => {
    await (await $('button[title*="Paramètres"], button*=Paramètres')).click();
    await (await $("button=Exporter…")).click();

    await (await $('input[placeholder*="8 caractères"]')).setValue("mot-de-passe-export-e2e");
    await (await $('input[placeholder*="Confirmer"]')).setValue("mot-de-passe-export-e2e");
    await (await $("button*=Choisir la destination")).click();
    // Boîte de dialogue native pour la destination — même remarque que les
    // autres tests impliquant un file picker natif (à stubber pour du 100% headless).

    const successMsg = await $("p*=Export chiffré créé avec succès");
    await successMsg.waitForDisplayed({ timeout: 10000 });
  });

  it("échoue proprement avec un mauvais mot de passe d'export", async () => {
    await (await $("button=Restaurer…")).click();
    await (await $('input[placeholder*="mot de passe d\'export"]')).setValue("mauvais-mot-de-passe");
    await (await $("button*=Choisir le fichier")).click();

    const errorMsg = await $("p*=Mot de passe d'export incorrect");
    await errorMsg.waitForDisplayed({ timeout: 10000 });
    expect(await errorMsg.isDisplayed()).toBe(true);
  });
});
