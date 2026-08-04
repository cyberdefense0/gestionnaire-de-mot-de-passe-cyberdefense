import { expect, $ } from "@wdio/globals";

describe("CRUD d'une entrée", () => {
  it("ajoute, modifie, recherche puis supprime (avec annulation) une entrée mot de passe", async () => {
    // Suppose un coffre déjà déverrouillé (voir 01-create-vault.spec.ts, ou
    // un coffre de test préparé — à brancher selon la stratégie de fixtures
    // retenue par l'équipe QA).
    const addButton = await $("button*=Ajouter");
    await addButton.click();

    const titleInput = await $('input[placeholder*="Gmail"], input[name="title"]');
    await titleInput.waitForDisplayed({ timeout: 10000 });
    await titleInput.setValue("Test E2E — Exemple");

    const usernameInput = await $("input").nth(1);
    await usernameInput.setValue("e2e@example.com");

    const generateButton = await $("button*=Générer");
    if (await generateButton.isExisting()) await generateButton.click();

    const saveButton = await $("button*=Enregistrer");
    await saveButton.click();

    const card = await $("p*=Test E2E — Exemple");
    await card.waitForDisplayed({ timeout: 10000 });

    // Recherche via "/" (§1.2 navigation clavier)
    await browser.keys("/");
    const search = await $('input[placeholder*="Rechercher"]');
    await search.setValue("Test E2E");
    const filtered = await $("p*=Test E2E — Exemple");
    expect(await filtered.isDisplayed()).toBe(true);
    await search.setValue("");

    // Modification
    await card.click();
    const editTitle = await $('input[value*="Test E2E"]');
    await editTitle.setValue("Test E2E — Modifié");
    await (await $("button*=Enregistrer")).click();
    await (await $("p*=Test E2E — Modifié")).waitForDisplayed({ timeout: 10000 });

    // Suppression avec fenêtre d'annulation (6s)
    const modifiedCard = await $("p*=Test E2E — Modifié");
    await modifiedCard.moveTo();
    const deleteButton = await $('button[title="Modifier"]').nextElement();
    await deleteButton.click(); // premier clic : confirmation
    await deleteButton.click(); // second clic : suppression effective (différée)

    const undoToast = await $("button=Annuler");
    await undoToast.waitForDisplayed({ timeout: 3000 });
    // On laisse expirer les 6s sans annuler : l'entrée doit disparaître
    // définitivement (écriture disque réelle).
    await browser.pause(6500);
    await expect($("p*=Test E2E — Modifié")).not.toBeExisting();
  });
});
