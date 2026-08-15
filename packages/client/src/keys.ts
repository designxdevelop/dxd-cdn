/** Long-lived versioned / content-hashed assets */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** Mutable live objects. Browsers revalidate on each navigation. */
export const MUTABLE_CACHE_CONTROL = 'public, max-age=0, must-revalidate';

/** Edge TTL the Worker applies to mutable public GETs. */
export const EDGE_MUTABLE_CACHE_CONTROL = 'public, max-age=60';

/** @deprecated Use MUTABLE_CACHE_CONTROL */
export const LATEST_CACHE_CONTROL = MUTABLE_CACHE_CONTROL;

export const DEFAULT_CDN_ORIGIN = 'https://cdn.designxdevelop.com';

/**
 * Join key segments. Strips slashes; rejects `..`.
 * Prefer `{client}/{project}/{env}/…`.
 */
export function joinKey(...parts: Array<string | number>): string {
  const key = parts
    .map((p) => String(p).replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  if (!key || key.includes('..')) {
    throw new Error(`Invalid CDN object key: ${JSON.stringify(parts)}`);
  }
  return key;
}

/**
 * `personalization.js` + `abc123def456` → `personalization.abc123def456.js`
 */
export function hashedFilename(liveName: string, hash: string): string {
  const trimmed = String(liveName).replace(/^\/+|\/+$/g, '');
  const digest = String(hash).replace(/[^a-zA-Z0-9]/g, '');
  if (!trimmed || !digest) {
    throw new Error(`Invalid hashed filename: ${JSON.stringify({ liveName, hash })}`);
  }
  const dot = trimmed.lastIndexOf('.');
  if (dot <= 0) return `${trimmed}.${digest}`;
  return `${trimmed.slice(0, dot)}.${digest}${trimmed.slice(dot)}`;
}

/** Public URL; optional `?v=` for extra busting of mutable objects. */
export function publicUrl(origin: string, key: string, cacheBust?: string | number): string {
  const base = `${origin.replace(/\/$/, '')}/${key.replace(/^\//, '')}`;
  if (cacheBust === undefined || cacheBust === '') return base;
  return `${base}?v=${encodeURIComponent(String(cacheBust))}`;
}
