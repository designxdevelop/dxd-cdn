/**
 * R2 object storage. HTTP handlers and CdnObjects adapt these results to status codes / RPC errors.
 */

import { CONTENT_TYPES, DEFAULT_CDN_ORIGIN, MUTABLE_CACHE_CONTROL } from '../config/constants.js';

/**
 * @param {string} path
 * @returns {string|null}
 */
export function normalizeObjectKey(path) {
	if (!path || typeof path !== 'string') return null;
	const cleaned = path.replace(/^\/+/, '').replace(/\\/g, '/');
	if (!cleaned || cleaned.includes('..') || cleaned.startsWith('api/')) return null;
	return cleaned;
}

/**
 * @param {'INVALID_KEY'|'EXISTS'|'NOT_FOUND'} code
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
		default:
			return 'Object error';
	}
}

/**
 * @param {'INVALID_KEY'|'EXISTS'|'NOT_FOUND'} code
 * @returns {number}
 */
export function objectErrorStatus(code) {
	switch (code) {
		case 'INVALID_KEY':
			return 400;
		case 'EXISTS':
			return 409;
		case 'NOT_FOUND':
			return 404;
		default:
			return 500;
	}
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
 * @param {{ key: string, body: BodyInit, contentType?: string, cacheControl?: string, overwrite?: boolean, origin?: string }} input
 * @returns {Promise<{ ok: true, key: string, url: string, cacheControl: string } | { ok: false, code: 'INVALID_KEY'|'EXISTS', key?: string }>}
 */
export async function storeObject(env, input) {
	const key = normalizeObjectKey(input.key);
	if (!key) return { ok: false, code: 'INVALID_KEY' };

	const contentType = contentTypeForKey(key, input.contentType);
	const cacheControl = input.cacheControl || MUTABLE_CACHE_CONTROL;
	const overwrite = input.overwrite !== false;
	const origin = publicOrigin(env, input.origin);

	if (!overwrite) {
		const existing = await env.CDN_BUCKET.head(key);
		if (existing) {
			return { ok: false, code: 'EXISTS', key };
		}
	}

	await env.CDN_BUCKET.put(key, input.body, {
		httpMetadata: {
			contentType,
			cacheControl,
		},
	});

	return {
		ok: true,
		key,
		url: `${origin}/${key}`,
		cacheControl,
	};
}

/**
 * Metadata only (`head`). Does not download the object body.
 * @param {Object} env
 * @param {string} key
 * @param {string} [origin]
 * @returns {Promise<{ ok: true, key: string, size: number, etag: string, uploaded: Date, contentType: string|null, cacheControl: string|null, url: string } | { ok: false, code: 'INVALID_KEY'|'NOT_FOUND', key?: string }>}
 */
export async function loadObjectMeta(env, key, origin) {
	const normalized = normalizeObjectKey(key);
	if (!normalized) return { ok: false, code: 'INVALID_KEY' };

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
 * @param {string} key
 * @returns {Promise<{ ok: true, key: string, object: R2ObjectBody } | { ok: false, code: 'INVALID_KEY'|'NOT_FOUND', key?: string }>}
 */
export async function loadObjectBody(env, key) {
	const normalized = normalizeObjectKey(key);
	if (!normalized) return { ok: false, code: 'INVALID_KEY' };

	const object = await env.CDN_BUCKET.get(normalized);
	if (!object) return { ok: false, code: 'NOT_FOUND', key: normalized };

	return { ok: true, key: normalized, object };
}
