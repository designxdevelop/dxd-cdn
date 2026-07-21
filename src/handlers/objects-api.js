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

import { CONTENT_TYPES } from '../config/constants.js';
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

function contentTypeForKey(key, explicit) {
	if (explicit) return explicit;
	const extension = key.split('.').pop()?.toLowerCase() || '';
	return CONTENT_TYPES[extension] || 'application/octet-stream';
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
		key = normalizeObjectKey(payload.key);
		if (!key) return badRequest('Invalid or missing key');
		contentType = payload.contentType || contentTypeForKey(key);
		cacheControl = payload.cacheControl || undefined;
		overwrite = payload.overwrite !== false;
		if (payload.encoding === 'base64') {
			const binary = Uint8Array.from(atob(String(payload.body || '')), (c) => c.charCodeAt(0));
			body = binary;
		} else {
			body = String(payload.body ?? '');
		}
	} else {
		key = normalizeObjectKey(request.headers.get('X-DXD-Object-Key') || url.searchParams.get('key') || '');
		if (!key) return badRequest('Missing X-DXD-Object-Key');
		contentType = contentTypeForKey(key, request.headers.get('Content-Type') || undefined);
		cacheControl = request.headers.get('X-DXD-Cache-Control') || undefined;
		overwrite = request.headers.get('X-DXD-Overwrite') !== 'false';
		body = await request.arrayBuffer();
	}

	if (!overwrite) {
		const existing = await env.CDN_BUCKET.head(key);
		if (existing) {
			return new Response(JSON.stringify({ error: 'Object exists', key }), {
				status: 409,
				headers: { 'Content-Type': 'application/json', ...getCorsHeaders() },
			});
		}
	}

	await env.CDN_BUCKET.put(key, body, {
		httpMetadata: {
			contentType,
			cacheControl: cacheControl || 'public, max-age=31536000, immutable',
		},
	});

	const origin = url.origin;
	return new Response(
		JSON.stringify({
			ok: true,
			key,
			url: `${origin}/${key}`,
			cacheControl: cacheControl || 'public, max-age=31536000, immutable',
		}),
		{
			status: 201,
			headers: { 'Content-Type': 'application/json', ...getCorsHeaders() },
		},
	);
}

/**
 * GET /api/objects?key=... (auth required) — inspect metadata / pull for tools
 * Public consumers should GET https://cdn…/{key} directly (no auth).
 */
export async function handleGetObjectApi(request, env, url) {
	if (!isAuthorizedUpload(request, url, env)) return unauthorized();

	const key = normalizeObjectKey(url.searchParams.get('key') || '');
	if (!key) return badRequest('Missing key');

	const object = await env.CDN_BUCKET.get(key);
	if (!object) {
		return new Response(JSON.stringify({ error: 'Not found', key }), {
			status: 404,
			headers: { 'Content-Type': 'application/json', ...getCorsHeaders() },
		});
	}

	const as = url.searchParams.get('as') || 'meta';
	if (as === 'body') {
		const headers = new Headers({
			'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
			...getCorsHeaders(),
		});
		return new Response(object.body, { headers });
	}

	return new Response(
		JSON.stringify({
			key,
			size: object.size,
			etag: object.httpEtag,
			uploaded: object.uploaded,
			contentType: object.httpMetadata?.contentType || null,
			cacheControl: object.httpMetadata?.cacheControl || null,
			url: `${url.origin}/${key}`,
		}),
		{
			headers: { 'Content-Type': 'application/json', ...getCorsHeaders() },
		},
	);
}
