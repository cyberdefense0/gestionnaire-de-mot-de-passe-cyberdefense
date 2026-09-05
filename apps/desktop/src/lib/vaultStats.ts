import type { VaultItem } from "../types";

export interface VaultStats {
  total: number;
  passwords: number;
  notes: number;
  passkeys: number;
  favorites: number;
  withTotp: number;
  withAttachments: number;
  withTags: number;
  withExpiry: number;
  expiredSoon: number;   // expire dans ≤ 7 jours
  expired: number;       // déjà expiré
  neverUsed: number;     // last_used_at null
  attachmentsTotalBytes: number;
  oldestEntry: VaultItem | null;
  newestEntry: VaultItem | null;
  byCategory: { name: string; count: number }[];
  topTags: { tag: string; count: number }[];
}

function daysUntil(iso: string): number {
  return (new Date(iso).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
}

function base64ByteSize(b64: string): number {
  // Estimation : chaque char base64 ≈ 0.75 octet, moins les padding =
  const padding = (b64.match(/=/g) ?? []).length;
  return Math.floor((b64.length * 3) / 4) - padding;
}

export function computeStats(items: VaultItem[]): VaultStats {
  let passwords = 0, notes = 0, passkeys = 0, favorites = 0;
  let withTotp = 0, withAttachments = 0, withTags = 0, withExpiry = 0;
  let expiredSoon = 0, expired = 0, neverUsed = 0;
  let attachmentsTotalBytes = 0;
  let oldest: VaultItem | null = null;
  let newest: VaultItem | null = null;
  const byCat = new Map<string, number>();
  const tagCount = new Map<string, number>();

  for (const item of items) {
    if (item.item_type === "password") passwords++;
    else if (item.item_type === "note") notes++;
    else if (item.item_type === "passkey") passkeys++;

    if (item.favorite) favorites++;
    if (item.custom_fields.some((f) => f.field_type === "totp")) withTotp++;
    if (item.attachments.length > 0) {
      withAttachments++;
      for (const a of item.attachments) {
        attachmentsTotalBytes += base64ByteSize(a.data_base64);
      }
    }
    if (item.tags.length > 0) {
      withTags++;
      for (const t of item.tags) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
    }
    if (item.expires_at) {
      withExpiry++;
      const d = daysUntil(item.expires_at);
      if (d < 0) expired++;
      else if (d <= 7) expiredSoon++;
    }
    if (!item.last_used_at) neverUsed++;

    byCat.set(item.category, (byCat.get(item.category) ?? 0) + 1);

    const created = new Date(item.created_at).getTime();
    if (!oldest || created < new Date(oldest.created_at).getTime()) oldest = item;
    if (!newest || created > new Date(newest.created_at).getTime()) newest = item;
  }

  const byCategory = [...byCat.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  const topTags = [...tagCount.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    total: items.length,
    passwords, notes, passkeys, favorites,
    withTotp, withAttachments, withTags, withExpiry,
    expiredSoon, expired, neverUsed,
    attachmentsTotalBytes,
    oldestEntry: oldest,
    newestEntry: newest,
    byCategory,
    topTags,
  };
}

/** Formate une taille en octets en Ko / Mo lisibles. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} Mo`;
}
