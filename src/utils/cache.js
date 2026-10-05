/**
 * Public GET cache policy: live URLs revalidate; hashed/versioned keys stay immutable.
 */

import { MUTABLE_CACHE_CONTROL } from '../config/constants.js';

/** Cloudflare caps a single cache tag at 1024 characters. */
const MAX_CACHE_TAG_LENGTH = 1024;

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
 * Per-object tag, so republishing one key purges one key instead of a whole
 * client's assets. Cache tags must be printable ASCII with no commas, and
 * object keys can contain neither reliably, so the key is percent-encoded.
 * Purge and write both go through here, so the encoding always agrees.
 * @param {string} key
 * @returns {string|null} null when the key cannot produce a usable tag.
 */
export function objectCacheTag(key) {
	const normalized = String(key || '').replace(/^\/+/, '');
	if (!normalized) return null;
	const tag = `dxd-cdn-key:${encodeURIComponent(normalized).replace(/,/g, '%2C')}`;
	return tag.length <= MAX_CACHE_TAG_LENGTH ? tag : null;
}

/**
 * @param {string} key
 * @returns {string[]}
 */
export function cacheTagsForKey(key) {
	const tags = [cacheTagForKey(key)];
	const objectTag = objectCacheTag(key);
	if (objectTag) tags.push(objectTag);
	return tags;
}

/**
 * Headers for the operator and tool pages. With Workers Caching on, HTML that
 * carries no Cache-Control at all can be held at the edge heuristically — and
 * `/browse` interpolates the operator password into inline JS. None of these
 * pages is shareable, so say so explicitly.
 * @returns {{ 'Content-Type': string, 'Cache-Control': string }}
 */
export function uncachedHtmlHeaders() {
	return {
		'Content-Type': 'text/html',
		'Cache-Control': 'private, no-store',
	};
}

/**
 * Edge TTL for live objects. 0 means no edge copy, which is the default and
 * matches the behavior before Workers Caching was enabled.
 * @param {Object} env
 * @returns {number}
 */
export function liveEdgeMaxAge(env) {
	const configured = Number(env?.LIVE_EDGE_MAX_AGE);
	if (!Number.isFinite(configured) || configured <= 0) return 0;
	return Math.floor(configured);
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
 * RFC 9110 origin evaluation for GET/HEAD. Returns 304/412 or null to continue.
 * @param {Request} request
 * @param {{ httpEtag?: string, uploaded?: Date }} object
 * @returns {304|412|null}
 */
export function getPreconditionStatus(request, object) {
	const ifMatch = request.headers.get('If-Match');
	const ifUnmodified = request.headers.get('If-Unmodified-Since');
	const ifNoneMatch = request.headers.get('If-None-Match');
	const ifModified = request.headers.get('If-Modified-Since');
	const uploadedMs = object?.uploaded instanceof Date ? object.uploaded.getTime() : NaN;

	if (ifMatch) {
		if (!etagMatches(ifMatch, object?.httpEtag)) return 412;
	} else if (ifUnmodified) {
		const since = Date.parse(ifUnmodified);
		if (!Number.isNaN(since) && !Number.isNaN(uploadedMs) && uploadedMs > since) return 412;
	}

	if (ifNoneMatch) {
		if (etagMatches(ifNoneMatch, object?.httpEtag)) return 304;
		return null;
	}

	if (ifModified) {
		const since = Date.parse(ifModified);
		if (!Number.isNaN(since) && !Number.isNaN(uploadedMs) && uploadedMs <= since) return 304;
	}

	return null;
}

/**
 * @param {string} value
 * @returns {string}
 */
function stripWeakEtag(value) {
	return value.replace(/^W\//i, '').trim();
}

/**
 * Immutable objects use one policy everywhere. Live objects always tell browsers
 * to revalidate; `edgeMaxAge` decides whether Cloudflare may hold a copy and
 * answer that revalidation instead of R2. Writes purge the object's own tag, so
 * a publish is still visible immediately.
 * @param {string|null|undefined} storedCacheControl
 * @param {number} [edgeMaxAge] Seconds Cloudflare may serve a live object. 0 for no edge copy.
 * @returns {{ 'Cache-Control': string, 'Cloudflare-CDN-Cache-Control': string, 'CDN-Cache-Control': string }}
 */
export function cacheHeadersForObject(storedCacheControl, edgeMaxAge = 0) {
	const value = storedCacheControl || MUTABLE_CACHE_CONTROL;
	const edge = isImmutableCacheControl(value) || edgeMaxAge <= 0 ? value : `public, max-age=${Math.floor(edgeMaxAge)}`;
	return {
		'Cache-Control': value,
		'Cloudflare-CDN-Cache-Control': edge,
		'CDN-Cache-Control': edge,
	};
}

/**
 * Apply cache, ETag, and Cache-Tag headers onto an existing Headers object.
 * @param {Headers} headers
 * @param {{ httpEtag?: string, httpMetadata?: { cacheControl?: string }, uploaded?: Date }} object
 * @param {string} key
 * @param {number} [edgeMaxAge]
 */
export function applyPublicCacheHeaders(headers, object, key, edgeMaxAge = 0) {
	const cacheHeaders = cacheHeadersForObject(object?.httpMetadata?.cacheControl, edgeMaxAge);
	for (const [name, value] of Object.entries(cacheHeaders)) {
		headers.set(name, value);
	}
	if (object?.httpEtag) {
		headers.set('ETag', object.httpEtag);
	}
	if (object?.uploaded) {
		headers.set('Last-Modified', object.uploaded.toUTCString());
	}
	headers.set('Cache-Tag', cacheTagsForKey(key).join(','));
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

/**
 * @param {Request} request
 * @param {{ httpEtag?: string, uploaded?: Date }} object
 * @param {Headers} headers
 * @returns {Response|null}
 */
export function preconditionResponse(request, object, headers) {
	const status = getPreconditionStatus(request, object);
	if (!status) return null;
	return new Response(null, { status, headers });
}
