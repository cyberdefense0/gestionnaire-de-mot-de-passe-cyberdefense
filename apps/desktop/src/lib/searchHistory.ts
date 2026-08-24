const KEY = "coffre:searchHistory";
const MAX = 5;

export function getSearchHistory(): string[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function pushSearchHistory(query: string): void {
  const q = query.trim();
  if (q.length < 2) return; // ignorer les requêtes trop courtes
  const prev = getSearchHistory().filter((h) => h !== q);
  const next = [q, ...prev].slice(0, MAX);
  localStorage.setItem(KEY, JSON.stringify(next));
}

export function clearSearchHistory(): void {
  localStorage.removeItem(KEY);
}
