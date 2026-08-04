import { expect, browser, $, $$ } from "@wdio/globals";

describe("Navigation 100% clavier (§1.2)", () => {
  it("flèches déplacent la sélection, Entrée ouvre, Espace bascule le favori", async () => {
    const cards = await $$('[id^="item-card-"]');
    expect(cards.length).toBeGreaterThan(0);

    // Focus initial sur la première carte (survol simulé)
    await cards[0].moveTo();

    await browser.keys("ArrowDown");
    const focusedAfterDown = await $('[id^="item-card-"][class*="ring-1"]');
    await focusedAfterDown.waitForDisplayed({ timeout: 5000 });

    // Espace bascule le favori de la carte actuellement sélectionnée
    await browser.keys(" ");
    const favoriteStar = await focusedAfterDown.$("span*=★");
    await favoriteStar.waitForDisplayed({ timeout: 3000 });

    // Entrée ouvre le formulaire d'édition de la carte sélectionnée
    await browser.keys("Enter");
    const editModal = await $("button*=Enregistrer");
    await editModal.waitForDisplayed({ timeout: 5000 });
    await browser.keys("Escape");
  });

  it("Ctrl+C copie le mot de passe de l'entrée sélectionnée", async () => {
    const cards = await $$('[id^="item-card-"]');
    await cards[0].moveTo();
    await browser.keys(["Control", "c"]);
    const toast = await $("span*=copié");
    await toast.waitForDisplayed({ timeout: 5000 });
    // La jauge de progression du presse-papiers doit être visible (§1.1)
    const countdownBar = await $(".bg-accent.rounded-full");
    expect(await countdownBar.isExisting()).toBe(true);
  });
});
