/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Tokens sémantiques : les valeurs réelles (clair/sombre) sont définies
        // en variables CSS dans src/styles.css et changent selon la classe
        // "dark" posée sur <html>. Le format "R G B" permet les modificateurs
        // d'opacité Tailwind (ex: bg-base/90).
        base: "rgb(var(--color-base) / <alpha-value>)",
        surface: "rgb(var(--color-surface) / <alpha-value>)",
        "surface-2": "rgb(var(--color-surface-2) / <alpha-value>)",
        edge: "rgb(var(--color-edge) / <alpha-value>)",
        "edge-strong": "rgb(var(--color-edge-strong) / <alpha-value>)",
        muted: "rgb(var(--color-muted) / <alpha-value>)",
        primary: "rgb(var(--color-primary) / <alpha-value>)",
        accent: "rgb(var(--color-accent) / <alpha-value>)",
        "accent-strong": "rgb(var(--color-accent-strong) / <alpha-value>)",
        brand: "rgb(var(--color-brand) / <alpha-value>)",
        "brand-hover": "rgb(var(--color-brand-hover) / <alpha-value>)",
        "on-brand": "rgb(var(--color-on-brand) / <alpha-value>)",
        signal: {
          green: "#4ADE80",
          red: "#F87171",
          amber: "#FBBF24",
        },
      },
      fontFamily: {
        display: ["'Fraunces'", "serif"],
        sans: ["'Inter'", "sans-serif"],
        mono: ["'JetBrains Mono'", "monospace"],
      },
    },
  },
  plugins: [],
};
