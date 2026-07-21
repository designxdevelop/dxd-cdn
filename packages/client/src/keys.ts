/** Long-lived versioned / content-hashed assets */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * Mutable “live” objects (config.json, platform.js).
 * Short TTL so republish is visible without changing embed snippets.
 */
export const MUTABLE_CACHE_CONTROL = 'public, max-age=60, must-revalidate';

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

/** Public URL; optional `?v=` for extra busting of mutable objects. */
export function publicUrl(origin: string, key: string, cacheBust?: string | number): string {
  const base = `${origin.replace(/\/$/, '')}/${key.replace(/^\//, '')}`;
  if (cacheBust === undefined || cacheBust === '') return base;
  return `${base}?v=${encodeURIComponent(String(cacheBust))}`;
}
