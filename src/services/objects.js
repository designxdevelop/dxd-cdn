/**
 * R2 object storage. HTTP handlers and CdnObjects adapt these results to status codes / RPC errors.
 *
 * Every entry point takes a `Scope` and checks it here rather than in the
 * adapters, so the HTTP API and the RPC entrypoint enforce the same rules.
 */

import {
	CONTENT_TYPES,
	DEFAULT_CDN_ORIGIN,
	IMMUTABLE_CACHE_CONTROL,
	MUTABLE_CACHE_CONTROL,
	RESERVED_KEY_PREFIXES,
} from '../config/constants.js';
import { analyticsKeysFor } from '../utils/files.js';
import { purgeObjectKey } from '../utils/purge.js';
import { ALL_PREFIXES, scopeAllows } from './scopes.js';

/**
 * @param {string} path
 * @returns {string|null}
 */
export function normalizeObjectKey(path) {
	if (!path || typeof path !== 'string') return null;
	const cleaned = path.replace(/^\/+/, '').replace(/\\/g, '/');
	if (!cleaned || cleaned.includes('?') || cleaned.includes('#')) return null;
	if (isReservedKey(cleaned)) return null;
	const segments = cleaned.split('/');
	if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
	return cleaned;
}

/**
 * @param {string} key
 * @returns {boolean}
 */
export function isReservedKey(key) {
	const cleaned = String(key || '').replace(/^\/+/, '');
	return RESERVED_KEY_PREFIXES.some((prefix) => cleaned.startsWith(prefix));
}

/**
 * @typedef {'INVALID_KEY'|'EXISTS'|'NOT_FOUND'|'INVALID_CACHE_CONTROL'|'FORBIDDEN'} ObjectErrorCode
 */

/**
 * @param {ObjectErrorCode} code
 * @returns {string}
 */
export function objectErrorMessage(code) {
	switch (code) {
		case 'INVALID_KEY':
			return 'Invalid or missing key';
		case 'EXISTS':
			return 'Object exists';
		case 'NOT_FOUND':
			return 'Not found';
		case 'INVALID_CACHE_CONTROL':
			return 'Invalid Cache-Control';
		case 'FORBIDDEN':
			return 'Key is outside this token scope';
		default:
			return 'Object error';
	}
}

/**
 * @param {ObjectErrorCode} code
 * @returns {number}
 */
export function objectErrorStatus(code) {
	switch (code) {
		case 'INVALID_KEY':
			return 400;
		case 'INVALID_CACHE_CONTROL':
			return 400;
		case 'FORBIDDEN':
			return 403;
		case 'EXISTS':
			return 409;
		case 'NOT_FOUND':
			return 404;
		default:
			return 500;
	}
}

/**
 * Empty/omitted defaults to live revalidation. Anything else must be one of the two known policies.
 * @param {string|null|undefined} value
 * @returns {{ ok: true, cacheControl: string } | { ok: false, code: 'INVALID_CACHE_CONTROL' }}
 */
export function resolveCacheControl(value) {
	if (value == null) return { ok: true, cacheControl: MUTABLE_CACHE_CONTROL };
	const trimmed = String(value).trim();
	if (!trimmed) return { ok: true, cacheControl: MUTABLE_CACHE_CONTROL };
	if (trimmed === MUTABLE_CACHE_CONTROL || trimmed === IMMUTABLE_CACHE_CONTROL) {
		return { ok: true, cacheControl: trimmed };
	}
	return { ok: false, code: 'INVALID_CACHE_CONTROL' };
}

/**
 * Public origin for object URLs. HTTP handlers pass the request origin; RPC uses env.
 * @param {Object} env
 * @param {string} [requestOrigin]
 * @returns {string}
 */
export function publicOrigin(env, requestOrigin) {
	if (requestOrigin) return requestOrigin.replace(/\/$/, '');
	if (env.PUBLIC_ORIGIN) return String(env.PUBLIC_ORIGIN).replace(/\/$/, '');
	return DEFAULT_CDN_ORIGIN;
}

/**
 * @param {string} key
 * @param {string} [explicit]
 * @returns {string}
 */
function contentTypeForKey(key, explicit) {
	if (explicit) return explicit;
	const extension = key.split('.').pop()?.toLowerCase() || '';
	return CONTENT_TYPES[extension] || 'application/octet-stream';
}

/**
 * @param {Object} env
 * @param {import('./scopes.js').Scope} scope
 * @param {{ key: string, body: BodyInit, contentType?: string, cacheControl?: string, overwrite?: boolean, origin?: string }} input
 * @returns {Promise<{ ok: true, key: string, url: string, cacheControl: string, purged: boolean } | { ok: false, code: ObjectErrorCode, key?: string }>}
 */
export async function storeObject(env, scope, input) {
	const key = normalizeObjectKey(input.key);
	if (!key) return { ok: false, code: 'INVALID_KEY' };
	if (!scopeAllows(scope, 'put', key)) return { ok: false, code: 'FORBIDDEN', key };

	const cache = resolveCacheControl(input.cacheControl);
	if (!cache.ok) return { ok: false, code: 'INVALID_CACHE_CONTROL', key };

	const contentType = contentTypeForKey(key, input.contentType);
	const cacheControl = cache.cacheControl;
	const origin = publicOrigin(env, input.origin);
	const createOnly = cacheControl === IMMUTABLE_CACHE_CONTROL || input.overwrite === false;

	if (createOnly) {
		const existing = await env.CDN_BUCKET.head(key);
		if (existing) {
			return { ok: false, code: 'EXISTS', key };
		}
	}

	const putOptions = {
		httpMetadata: {
			contentType,
			cacheControl,
		},
	};
	if (createOnly) {
		putOptions.onlyIf = new Headers({ 'If-None-Match': '*' });
	}

	const written = await env.CDN_BUCKET.put(key, input.body, putOptions);
	if (createOnly && written === null) {
		return { ok: false, code: 'EXISTS', key };
	}

	// Immutable keys are create-only, so nothing cached under them can go stale.
	// Live keys can be republished, so the edge copy has to go.
	const purge = createOnly ? { purged: false, reason: 'immutable' } : await purgeObjectKey(key);

	console.log('object stored', { app: scope.app, key, cacheControl, purged: purge.purged, purgeReason: purge.reason });

	return {
		ok: true,
		key,
		url: `${origin}/${key}`,
		cacheControl,
		purged: purge.purged,
	};
}

/**
 * Metadata only (`head`). Does not download the object body.
 * @param {Object} env
 * @param {import('./scopes.js').Scope} scope
 * @param {string} key
 * @param {string} [origin]
 * @returns {Promise<{ ok: true, key: string, size: number, etag: string, uploaded: Date, contentType: string|null, cacheControl: string|null, url: string } | { ok: false, code: ObjectErrorCode, key?: string }>}
 */
export async function loadObjectMeta(env, scope, key, origin) {
	const normalized = normalizeObjectKey(key);
	if (!normalized) return { ok: false, code: 'INVALID_KEY' };
	if (!scopeAllows(scope, 'get', normalized)) return { ok: false, code: 'FORBIDDEN', key: normalized };

	const object = await env.CDN_BUCKET.head(normalized);
	if (!object) return { ok: false, code: 'NOT_FOUND', key: normalized };

	return {
		ok: true,
		key: normalized,
		size: object.size,
		etag: object.httpEtag,
		uploaded: object.uploaded,
		contentType: object.httpMetadata?.contentType || null,
		cacheControl: object.httpMetadata?.cacheControl || null,
		url: `${publicOrigin(env, origin)}/${normalized}`,
	};
}

/**
 * @param {Object} env
 * @param {import('./scopes.js').Scope} scope
 * @param {string} key
 * @returns {Promise<{ ok: true, key: string, object: R2ObjectBody } | { ok: false, code: ObjectErrorCode, key?: string }>}
 */
export async function loadObjectBody(env, scope, key) {
	const normalized = normalizeObjectKey(key);
	if (!normalized) return { ok: false, code: 'INVALID_KEY' };
	if (!scopeAllows(scope, 'get', normalized)) return { ok: false, code: 'FORBIDDEN', key: normalized };

	const object = await env.CDN_BUCKET.get(normalized);
	if (!object) return { ok: false, code: 'NOT_FOUND', key: normalized };

	return { ok: true, key: normalized, object };
}

/**
 * @param {Object} env
 * @param {import('./scopes.js').Scope} scope
 * @param {string} key
 * @returns {Promise<{ ok: true, key: string, purged: boolean } | { ok: false, code: ObjectErrorCode, key?: string }>}
 */
export async function removeObject(env, scope, key) {
	const normalized = normalizeObjectKey(key);
	if (!normalized) return { ok: false, code: 'INVALID_KEY' };
	if (!scopeAllows(scope, 'delete', normalized)) return { ok: false, code: 'FORBIDDEN', key: normalized };

	const existing = await env.CDN_BUCKET.head(normalized);
	if (!existing) return { ok: false, code: 'NOT_FOUND', key: normalized };

	await env.CDN_BUCKET.delete(normalized);
	try {
		// The key's request counters go with it.
		await env.CDN_BUCKET.delete(analyticsKeysFor(normalized));
	} catch {
		// Counters are bookkeeping; never fail a delete over them.
	}
	const purge = await purgeObjectKey(normalized);

	console.log('object deleted', { app: scope.app, key: normalized, purged: purge.purged, purgeReason: purge.reason });

	return { ok: true, key: normalized, purged: purge.purged };
}

/**
 * Rename or move: copy to the new key with the same metadata, then remove the
 * old one. The old URL stops working, so this needs `delete` on the source as
 * well as `put` on the destination, and it never overwrites.
 * @param {Object} env
 * @param {import('./scopes.js').Scope} scope
 * @param {string} from
 * @param {string} to
 * @param {string} [origin]
 * @returns {Promise<{ ok: true, from: string, key: string, url: string, purged: boolean } | { ok: false, code: ObjectErrorCode, key?: string }>}
 */
export async function moveObject(env, scope, from, to, origin) {
	const source = normalizeObjectKey(from);
	const target = normalizeObjectKey(to);
	if (!source || !target || source === target) return { ok: false, code: 'INVALID_KEY' };
	if (!scopeAllows(scope, 'get', source) || !scopeAllows(scope, 'delete', source)) return { ok: false, code: 'FORBIDDEN', key: source };
	if (!scopeAllows(scope, 'put', target)) return { ok: false, code: 'FORBIDDEN', key: target };

	const object = await env.CDN_BUCKET.get(source);
	if (!object) return { ok: false, code: 'NOT_FOUND', key: source };

	const written = await env.CDN_BUCKET.put(target, object.body, {
		httpMetadata: object.httpMetadata,
		customMetadata: object.customMetadata,
		onlyIf: new Headers({ 'If-None-Match': '*' }),
	});
	if (written === null) return { ok: false, code: 'EXISTS', key: target };

	const removed = await removeObject(env, scope, source);
	if (!removed.ok) return removed;

	console.log('object moved', { app: scope.app, from: source, to: target });
	return { ok: true, from: source, key: target, url: `${publicOrigin(env, origin)}/${target}`, purged: removed.purged };
}

/** R2 returns at most this many keys per `list` call. */
export const MAX_LIST_LIMIT = 1000;

/**
 * Resolve which prefix a list request covers. An omitted prefix means "the whole
 * bucket" for an operator and "my prefix" for a token with exactly one, which is
 * the common case; a multi-prefix token has to say which one it means.
 * @param {import('./scopes.js').Scope} scope
 * @param {string} requested
 * @returns {string|null} null when the scope cannot imply a prefix.
 */
function resolveListPrefix(scope, requested) {
	if (requested) return requested.replace(/^\/+/, '');
	const prefixes = Array.isArray(scope?.prefixes) ? scope.prefixes : [];
	if (prefixes.includes(ALL_PREFIXES)) return '';
	if (prefixes.length === 1) return prefixes[0];
	return null;
}

/**
 * Paginated, prefix-scoped listing. Returns one R2 page plus its cursor rather
 * than silently stopping at the first 1000 keys.
 * @param {Object} env
 * @param {import('./scopes.js').Scope} scope
 * @param {{ prefix?: string, cursor?: string, limit?: number, delimiter?: string }} [options]
 * @returns {Promise<{ ok: true, prefix: string, objects: Array<{ key: string, size: number, uploaded: string, etag: string, contentType: string|null, cacheControl: string|null }>, prefixes: string[], truncated: boolean, cursor: string|null } | { ok: false, code: ObjectErrorCode, key?: string }>}
 */
export async function listObjects(env, scope, options = {}) {
	const prefix = resolveListPrefix(scope, String(options.prefix || ''));
	if (prefix === null) return { ok: false, code: 'FORBIDDEN' };
	if (!scopeAllows(scope, 'list', prefix || ALL_PREFIXES)) return { ok: false, code: 'FORBIDDEN', key: prefix };

	const requestedLimit = Number(options.limit);
	const limit =
		Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(Math.floor(requestedLimit), MAX_LIST_LIMIT) : MAX_LIST_LIMIT;

	const page = await env.CDN_BUCKET.list({
		prefix: prefix || undefined,
		cursor: options.cursor || undefined,
		delimiter: options.delimiter || undefined,
		limit,
		include: ['httpMetadata'],
	});

	return {
		ok: true,
		prefix,
		objects: page.objects.map((object) => ({
			key: object.key,
			size: object.size,
			uploaded: object.uploaded instanceof Date ? object.uploaded.toISOString() : object.uploaded,
			etag: object.httpEtag,
			contentType: object.httpMetadata?.contentType || null,
			cacheControl: object.httpMetadata?.cacheControl || null,
		})),
		prefixes: page.delimitedPrefixes || [],
		truncated: Boolean(page.truncated),
		cursor: page.truncated ? page.cursor : null,
	};
}
