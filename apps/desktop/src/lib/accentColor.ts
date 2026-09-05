/**
 * Gestion de la couleur d'accent (palette de thème).
 * Permet à l'utilisateur de choisir parmi 5 palettes de couleurs qui
 * remplacent les variables CSS --color-brand / --color-accent en live.
 * Le choix est mémorisé en localStorage et appliqué au chargement de l'app.
 *
 * Implémenté sans dépendance : simple manipulation de CSS variables.
 * La palette "Bleu" correspond aux valeurs d'origine du projet.
 */

export type AccentPalette = "blue" | "violet" | "green" | "rose" | "amber";

export interface PaletteDefinition {
  id: AccentPalette;
  label: string;
  /** Couleur CSS à afficher dans le sélecteur (pastille) */
  swatch: string;
  /** Variables CSS injectées dans :root (thème clair) */
  light: Record<string, string>;
  /** Variables CSS injectées dans html.dark (thème sombre) */
  dark: Record<string, string>;
}

export const PALETTES: PaletteDefinition[] = [
  {
    id: "blue",
    label: "Bleu",
    swatch: "#2563eb",
    light: {
      "--color-brand":        "37 99 235",
      "--color-brand-hover":  "26 78 200",
      "--color-accent":       "29 90 176",
      "--color-accent-strong":"17 63 130",
      "--color-surface-2":    "224 236 250",
      "--color-edge":         "205 222 242",
    },
    dark: {
      "--color-brand":        "184 130 62",
      "--color-brand-hover":  "201 154 91",
      "--color-accent":       "201 154 91",
      "--color-accent-strong":"228 203 166",
      "--color-surface-2":    "26 33 43",
      "--color-edge":         "35 44 56",
    },
  },
  {
    id: "violet",
    label: "Violet",
    swatch: "#7c3aed",
    light: {
      "--color-brand":        "124 58 237",
      "--color-brand-hover":  "109 40 217",
      "--color-accent":       "109 40 217",
      "--color-accent-strong":"91 33 182",
      "--color-surface-2":    "237 233 254",
      "--color-edge":         "221 214 254",
    },
    dark: {
      "--color-brand":        "167 139 250",
      "--color-brand-hover":  "196 181 253",
      "--color-accent":       "167 139 250",
      "--color-accent-strong":"196 181 253",
      "--color-surface-2":    "30 27 75",
      "--color-edge":         "49 46 129",
    },
  },
  {
    id: "green",
    label: "Vert",
    swatch: "#16a34a",
    light: {
      "--color-brand":        "22 163 74",
      "--color-brand-hover":  "15 118 55",
      "--color-accent":       "15 118 55",
      "--color-accent-strong":"21 128 61",
      "--color-surface-2":    "220 252 231",
      "--color-edge":         "187 247 208",
    },
    dark: {
      "--color-brand":        "134 239 172",
      "--color-brand-hover":  "187 247 208",
      "--color-accent":       "134 239 172",
      "--color-accent-strong":"187 247 208",
      "--color-surface-2":    "20 46 36",
      "--color-edge":         "6 78 59",
    },
  },
  {
    id: "rose",
    label: "Rose",
    swatch: "#e11d48",
    light: {
      "--color-brand":        "225 29 72",
      "--color-brand-hover":  "190 18 60",
      "--color-accent":       "190 18 60",
      "--color-accent-strong":"159 18 57",
      "--color-surface-2":    "255 228 230",
      "--color-edge":         "254 205 211",
    },
    dark: {
      "--color-brand":        "251 113 133",
      "--color-brand-hover":  "253 164 175",
      "--color-accent":       "251 113 133",
      "--color-accent-strong":"253 164 175",
      "--color-surface-2":    "76 5 25",
      "--color-edge":         "136 19 55",
    },
  },
  {
    id: "amber",
    label: "Orange",
    swatch: "#d97706",
    light: {
      "--color-brand":        "217 119 6",
      "--color-brand-hover":  "180 97 5",
      "--color-accent":       "180 97 5",
      "--color-accent-strong":"146 64 14",
      "--color-surface-2":    "254 243 199",
      "--color-edge":         "253 230 138",
    },
    dark: {
      "--color-brand":        "251 191 36",
      "--color-brand-hover":  "252 211 77",
      "--color-accent":       "251 191 36",
      "--color-accent-strong":"252 211 77",
      "--color-surface-2":    "69 26 3",
      "--color-edge":         "120 53 15",
    },
  },
];

const STORAGE_KEY = "coffre:accentPalette";

export function readStoredPalette(): AccentPalette {
  const v = localStorage.getItem(STORAGE_KEY);
  if (PALETTES.some((p) => p.id === v)) return v as AccentPalette;
  return "blue";
}

/** Injecte les variables CSS de la palette dans le document, selon le thème résolu. */
export function applyPalette(palette: AccentPalette, dark: boolean) {
  const def = PALETTES.find((p) => p.id === palette) ?? PALETTES[0];
  const vars = dark ? def.dark : def.light;
  const root = document.documentElement;
  for (const [key, val] of Object.entries(vars)) {
    root.style.setProperty(key, val);
  }
}

/** Réinitialise les variables CSS injectées (au changement de thème clair/sombre). */
export function reapplyPalette(dark: boolean) {
  applyPalette(readStoredPalette(), dark);
}

export function savePalette(palette: AccentPalette) {
  localStorage.setItem(STORAGE_KEY, palette);
}
