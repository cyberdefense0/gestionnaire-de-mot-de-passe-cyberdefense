import { useTheme } from "../lib/theme";

/** Bouton flottant, visible sur tous les écrans, pour basculer clair/sombre. */
export function ThemeToggle() {
  const { resolved, toggle } = useTheme();

  return (
    <button
      onClick={toggle}
      title={resolved === "dark" ? "Passer au thème clair" : "Passer au thème sombre"}
      className="fixed top-4 right-4 z-30 w-9 h-9 rounded-full flex items-center justify-center border border-edge bg-surface text-muted hover:text-accent hover:border-brand/50 transition-colors"
    >
      {resolved === "dark" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z" />
    </svg>
  );
}
