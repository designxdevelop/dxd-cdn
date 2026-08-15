/**
 * Public-asset cache policy.
 *
 * Mutable live URLs must be visible after republish without a hard refresh.
 * Immutable hashed/versioned keys keep a long browser + edge TTL.
 */

import {
	EDGE_MUTABLE_CACHE_CONTROL,
	IMMUTABLE_CACHE_CONTROL,
	MUTABLE_CACHE_CONTROL,
} from '../config/constants.js';

/**
 * @param {string|null|undefined} value
 * @returns {boolean}
 */
export function isImmutableCacheControl(value) {
	return typeof value === 'string' && /\bimmutable\b/i.test(value);
}

/**
 * First path segment as a Cache-Tag so a later purge can target one client prefix.
 * @param {string} key
 * @returns {string}
 */
export function cacheTagForKey(key) {
	const client = String(key || '')
		.replace(/^\/+/, '')
		.split('/')[0];
	return client ? `dxd-cdn:${client}` : 'dxd-cdn';
}

/**
 * Browser + Cloudflare edge cache headers for a public GET.
 * Honors stored per-object Cache-Control when present.
 * @param {string|null|undefined} storedCacheControl
 * @returns {{ 'Cache-Control': string, 'Cloudflare-CDN-Cache-Control': string, 'CDN-Cache-Control': string }}
 */
export function cacheHeadersForObject(storedCacheControl) {
	if (isImmutableCacheControl(storedCacheControl)) {
		const value = storedCacheControl || IMMUTABLE_CACHE_CONTROL;
		return {
			'Cache-Control': value,
			'Cloudflare-CDN-Cache-Control': value,
			'CDN-Cache-Control': value,
		};
	}

	const browser = storedCacheControl || MUTABLE_CACHE_CONTROL;
	return {
		'Cache-Control': browser,
		'Cloudflare-CDN-Cache-Control': EDGE_MUTABLE_CACHE_CONTROL,
		'CDN-Cache-Control': EDGE_MUTABLE_CACHE_CONTROL,
	};
}

/**
 * Apply cache, ETag, and Cache-Tag headers onto an existing Headers object.
 * @param {Headers} headers
 * @param {{ httpEtag?: string, httpMetadata?: { cacheControl?: string }, uploaded?: Date }} object
 * @param {string} key
 * @param {string} [defaultCacheControl]
 */
export function applyPublicCacheHeaders(headers, object, key, defaultCacheControl) {
	const cacheHeaders = cacheHeadersForObject(object?.httpMetadata?.cacheControl || defaultCacheControl);
	for (const [name, value] of Object.entries(cacheHeaders)) {
		headers.set(name, value);
	}
	if (object?.httpEtag) {
		headers.set('ETag', object.httpEtag);
	}
	if (object?.uploaded) {
		headers.set('Last-Modified', object.uploaded.toUTCString());
	}
	headers.set('Cache-Tag', cacheTagForKey(key));
}

/**
 * Return a 304 when If-None-Match matches the object ETag.
 * @param {Request} request
 * @param {string|null|undefined} etag
 * @param {Headers} headers
 * @returns {Response|null}
 */
export function notModifiedResponse(request, etag, headers) {
	if (!etag) return null;
	const incoming = request.headers.get('If-None-Match');
	if (!incoming) return null;
	const candidates = incoming.split(',').map((value) => value.trim());
	if (!candidates.includes(etag) && !candidates.includes('*')) return null;
	return new Response(null, { status: 304, headers });
}

/**
 * R2 keys may be stored percent-encoded. Try the raw request path when decoded lookup misses.
 * @param {Request} request
 * @param {string} decodedPath
 * @returns {string|null}
 */
export function encodedPathFallback(request, decodedPath) {
	const rawUrlPath = request.url
		.replace(/^https?:\/\/[^/]+/, '')
		.split('?')[0]
		.slice(1);
	return rawUrlPath && rawUrlPath !== decodedPath ? rawUrlPath : null;
}
