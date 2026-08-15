/**
 * Programmatic object put/get for any DXD app or client project.
 * Auth: Authorization Bearer UPLOAD_PASSWORD (or ?password= for parity with existing APIs).
 *
 * Keys are project-agnostic. Convention (recommended):
 *   {client}/{project}/{env}/...
 * Examples:
 *   acme/site/prod/hero.webp
 *   dxd-studio/countdown/prod/widgets/{id}/config.json
 */

import { CONTENT_TYPES, DEFAULT_CDN_ORIGIN, MUTABLE_CACHE_CONTROL } from '../config/constants.js';
import { getCorsHeaders } from '../utils/cors.js';

function unauthorized() {
	return new Response(JSON.stringify({ error: 'Unauthorized' }), {
		status: 401,
		headers: { 'Content-Type': 'application/json', ...getCorsHeaders() },
	});
}

function badRequest(message) {
	return new Response(JSON.stringify({ error: message }), {
		status: 400,
		headers: { 'Content-Type': 'application/json', ...getCorsHeaders() },
	});
}

/**
 * @param {Request} request
 * @param {URL} url
 * @param {Object} env
 * @returns {boolean}
 */
export function isAuthorizedUpload(request, url, env) {
	if (!env.UPLOAD_PASSWORD) return false;
	const header = request.headers.get('Authorization') || '';
	const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
	const queryPassword = url.searchParams.get('password') || '';
	return bearer === env.UPLOAD_PASSWORD || queryPassword === env.UPLOAD_PASSWORD;
}

/**
 * Normalize and validate object keys. Rejects path traversal.
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

function contentTypeForKey(key, explicit) {
	if (explicit) return explicit;
	const extension = key.split('.').pop()?.toLowerCase() || '';
	return CONTENT_TYPES[extension] || 'application/octet-stream';
}

/**
 * Store an object in R2. Used by PUT /api/objects and the CdnObjects service binding.
 * @param {Object} env
 * @param {{ key: string, body: BodyInit, contentType?: string, cacheControl?: string, overwrite?: boolean, origin?: string }} input
 * @returns {Promise<{ ok: true, key: string, url: string, cacheControl: string } | { error: string, status: number, key?: string }>}
 */
export async function storeObject(env, input) {
	const key = normalizeObjectKey(input.key);
	if (!key) return { error: 'Invalid or missing key', status: 400 };

	const contentType = contentTypeForKey(key, input.contentType);
	const cacheControl = input.cacheControl || MUTABLE_CACHE_CONTROL;
	const overwrite = input.overwrite !== false;
	const origin = publicOrigin(env, input.origin);

	if (!overwrite) {
		const existing = await env.CDN_BUCKET.head(key);
		if (existing) {
			return { error: 'Object exists', status: 409, key };
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
 * Load object metadata. Used by GET /api/objects and the CdnObjects service binding.
 * @param {Object} env
 * @param {string} key
 * @param {string} [origin]
 * @returns {Promise<{ key: string, size: number, etag: string, uploaded: Date, contentType: string|null, cacheControl: string|null, url: string } | { error: string, status: number, key?: string }>}
 */
export async function loadObjectMeta(env, key, origin) {
	const normalized = normalizeObjectKey(key);
	if (!normalized) return { error: 'Invalid or missing key', status: 400 };

	const object = await env.CDN_BUCKET.get(normalized);
	if (!object) return { error: 'Not found', status: 404, key: normalized };

	return {
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
 * PUT /api/objects
 * Headers:
 *   Authorization: Bearer <UPLOAD_PASSWORD>
 *   Content-Type: application/json | application/javascript | ...
 *   X-DXD-Object-Key: path/inside/bucket.json  (required)
 *   X-DXD-Cache-Control: optional Cache-Control for public GETs
 *   X-DXD-Overwrite: "true" (default) | "false"
 * Body: raw object bytes
 *
 * JSON alternate (X-DXD-Json-Envelope: true):
 *   { "key": "...", "body": "<string or base64>", "encoding": "utf8"|"base64", "cacheControl": "...", "contentType": "..." }
 */
export async function handlePutObjectApi(request, env, url) {
	if (!isAuthorizedUpload(request, url, env)) return unauthorized();

	const envelope = request.headers.get('X-DXD-Json-Envelope') === 'true';
	let key;
	let body;
	let contentType;
	let cacheControl;
	let overwrite = true;

	if (envelope) {
		let payload;
		try {
			payload = await request.json();
		} catch {
			return badRequest('Invalid JSON envelope');
		}
		key = payload.key;
		contentType = payload.contentType;
		cacheControl = payload.cacheControl;
		overwrite = payload.overwrite !== false;
		if (payload.encoding === 'base64') {
			body = Uint8Array.from(atob(String(payload.body || '')), (c) => c.charCodeAt(0));
		} else {
			body = String(payload.body ?? '');
		}
	} else {
		key = request.headers.get('X-DXD-Object-Key') || url.searchParams.get('key') || '';
		contentType = request.headers.get('Content-Type') || undefined;
		cacheControl = request.headers.get('X-DXD-Cache-Control') || undefined;
		overwrite = request.headers.get('X-DXD-Overwrite') !== 'false';
		body = await request.arrayBuffer();
	}

	const result = await storeObject(env, {
		key,
		body,
		contentType,
		cacheControl,
		overwrite,
		origin: url.origin,
	});

	if (result.error) {
		return new Response(JSON.stringify({ error: result.error, key: result.key }), {
			status: result.status,
			headers: { 'Content-Type': 'application/json', ...getCorsHeaders() },
		});
	}

	return new Response(JSON.stringify(result), {
		status: 201,
		headers: { 'Content-Type': 'application/json', ...getCorsHeaders() },
	});
}

/**
 * GET /api/objects?key=... (auth required) — inspect metadata / pull for tools
 * Public consumers should GET https://cdn…/{key} directly (no auth).
 */
export async function handleGetObjectApi(request, env, url) {
	if (!isAuthorizedUpload(request, url, env)) return unauthorized();

	const key = url.searchParams.get('key') || '';
	const as = url.searchParams.get('as') || 'meta';

	if (as === 'body') {
		const normalized = normalizeObjectKey(key);
		if (!normalized) return badRequest('Missing key');
		const object = await env.CDN_BUCKET.get(normalized);
		if (!object) {
			return new Response(JSON.stringify({ error: 'Not found', key: normalized }), {
				status: 404,
				headers: { 'Content-Type': 'application/json', ...getCorsHeaders() },
			});
		}
		const headers = new Headers({
			'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
			...getCorsHeaders(),
		});
		return new Response(object.body, { headers });
	}

	const result = await loadObjectMeta(env, key, url.origin);
	if (result.error) {
		return new Response(JSON.stringify({ error: result.error, key: result.key }), {
			status: result.status,
			headers: { 'Content-Type': 'application/json', ...getCorsHeaders() },
		});
	}

	return new Response(JSON.stringify(result), {
		headers: { 'Content-Type': 'application/json', ...getCorsHeaders() },
	});
}
