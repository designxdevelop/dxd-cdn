/**
 * Public GET cache policy: live URLs revalidate; hashed/versioned keys stay immutable.
 */

import { MUTABLE_CACHE_CONTROL } from '../config/constants.js';

/**
 * @param {string|null|undefined} value
 * @returns {boolean}
 */
export function isImmutableCacheControl(value) {
	return typeof value === 'string' && /\bimmutable\b/i.test(value);
}

/**
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
 * Weak comparison (RFC 9110). `W/"abc"` matches `"abc"`.
 * @param {string|null|undefined} incoming If-None-Match
 * @param {string|null|undefined} etag
 * @returns {boolean}
 */
export function etagMatches(incoming, etag) {
	if (!incoming || !etag) return false;
	const candidates = incoming
		.split(',')
		.map((value) => value.trim())
		.filter(Boolean);
	if (candidates.includes('*')) return true;
	const normalized = stripWeakEtag(etag);
	return candidates.some((candidate) => stripWeakEtag(candidate) === normalized);
}

/**
 * @param {string} value
 * @returns {string}
 */
function stripWeakEtag(value) {
	return value.replace(/^W\//i, '').trim();
}

/**
 * Browser + edge headers use the same Cache-Control string. Live URLs revalidate;
 * there is no separate short edge TTL.
 * @param {string|null|undefined} storedCacheControl
 * @returns {{ 'Cache-Control': string, 'Cloudflare-CDN-Cache-Control': string, 'CDN-Cache-Control': string }}
 */
export function cacheHeadersForObject(storedCacheControl) {
	const value = storedCacheControl || MUTABLE_CACHE_CONTROL;
	return {
		'Cache-Control': value,
		'Cloudflare-CDN-Cache-Control': value,
		'CDN-Cache-Control': value,
	};
}

/**
 * Apply cache, ETag, and Cache-Tag headers onto an existing Headers object.
 * @param {Headers} headers
 * @param {{ httpEtag?: string, httpMetadata?: { cacheControl?: string }, uploaded?: Date }} object
 * @param {string} key
 */
export function applyPublicCacheHeaders(headers, object, key) {
	const cacheHeaders = cacheHeadersForObject(object?.httpMetadata?.cacheControl);
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
	if (!etagMatches(request.headers.get('If-None-Match'), etag)) return null;
	return new Response(null, { status: 304, headers });
}
