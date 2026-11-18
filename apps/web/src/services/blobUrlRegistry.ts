/**
 * Ref-counted Blob Object URL Registry (`URL.createObjectURL` / `URL.revokeObjectURL`).
 * Prevents memory leaks across virtualized timelines, media lightboxes, and voice players.
 */

interface BlobRegistryEntry {
  key: string;
  url: string;
  blob: Blob;
  mimeType: string;
  size: number;
  refCount: number;
  createdAtMs: number;
}

const entriesByKey = new Map<string, BlobRegistryEntry>();
const keyByUrl = new Map<string, string>();
let autoKeySeq = 0;

export function acquireBlobUrl(key: string, blob: Blob): string {
  const existing = entriesByKey.get(key);
  if (existing) {
    existing.refCount += 1;
    return existing.url;
  }

  const url = URL.createObjectURL(blob);
  const entry: BlobRegistryEntry = {
    key,
    url,
    blob,
    mimeType: blob.type || 'application/octet-stream',
    size: blob.size,
    refCount: 1,
    createdAtMs: Date.now(),
  };
  entriesByKey.set(key, entry);
  keyByUrl.set(url, key);
  return url;
}

export function createManagedBlobUrl(blob: Blob, prefix = 'blob'): string {
  autoKeySeq += 1;
  const key = `${prefix}_${Date.now()}_${autoKeySeq}`;
  return acquireBlobUrl(key, blob);
}

export function retainBlobUrl(keyOrUrl: string): string | null {
  const key = keyByUrl.get(keyOrUrl) ?? keyOrUrl;
  const entry = entriesByKey.get(key);
  if (!entry) return null;
  entry.refCount += 1;
  return entry.url;
}

export function getRegisteredBlobUrl(key: string): string | null {
  return entriesByKey.get(key)?.url ?? null;
}

export function getRegisteredBlob(keyOrUrl: string): Blob | null {
  const key = keyByUrl.get(keyOrUrl) ?? keyOrUrl;
  return entriesByKey.get(key)?.blob ?? null;
}

export function releaseBlobUrl(keyOrUrl: string): boolean {
  const key = keyByUrl.get(keyOrUrl) ?? keyOrUrl;
  const entry = entriesByKey.get(key);
  if (!entry) return false;

  entry.refCount -= 1;
  if (entry.refCount <= 0) {
    entriesByKey.delete(key);
    keyByUrl.delete(entry.url);
    try {
      URL.revokeObjectURL(entry.url);
    } catch {
      // Ignore already-revoked URLs
    }
    return true;
  }
  return false;
}

export function revokeAllBlobUrls(): void {
  for (const entry of entriesByKey.values()) {
    try {
      URL.revokeObjectURL(entry.url);
    } catch {
      // Ignore revoke errors
    }
  }
  entriesByKey.clear();
  keyByUrl.clear();
}

export function getActiveBlobUrlStats(): {
  entries: number;
  totalBytes: number;
} {
  let totalBytes = 0;
  for (const entry of entriesByKey.values()) {
    totalBytes += entry.size;
  }
  return {
    entries: entriesByKey.size,
    totalBytes,
  };
}

export const blobUrlRegistry = {
  acquire: acquireBlobUrl,
  createManaged: createManagedBlobUrl,
  retain: retainBlobUrl,
  get: getRegisteredBlobUrl,
  getBlob: getRegisteredBlob,
  release: releaseBlobUrl,
  revokeAll: revokeAllBlobUrls,
  getStats: getActiveBlobUrlStats,
};
