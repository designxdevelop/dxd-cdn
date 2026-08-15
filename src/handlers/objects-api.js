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

import { loadObjectBody, loadObjectMeta, objectErrorMessage, objectErrorStatus, storeObject } from '../services/objects.js';
import { getCorsHeaders } from '../utils/cors.js';

function jsonHeaders() {
	return {
		'Content-Type': 'application/json',
		'Cache-Control': 'no-store',
		...getCorsHeaders(),
	};
}

function unauthorized() {
	return new Response(JSON.stringify({ error: 'Unauthorized' }), {
		status: 401,
		headers: jsonHeaders(),
	});
}

function badRequest(message) {
	return new Response(JSON.stringify({ error: message }), {
		status: 400,
		headers: jsonHeaders(),
	});
}

function objectFailResponse(result) {
	return new Response(JSON.stringify({ error: objectErrorMessage(result.code), key: result.key }), {
		status: objectErrorStatus(result.code),
		headers: jsonHeaders(),
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
		if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
			return badRequest('Invalid JSON envelope');
		}
		key = payload.key;
		contentType = payload.contentType;
		cacheControl = payload.cacheControl;
		overwrite = payload.overwrite !== false;
		try {
			if (payload.encoding === 'base64') {
				body = Uint8Array.from(atob(String(payload.body || '')), (c) => c.charCodeAt(0));
			} else {
				body = String(payload.body ?? '');
			}
		} catch {
			return badRequest('Invalid JSON envelope');
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

	if (!result.ok) return objectFailResponse(result);

	return new Response(JSON.stringify(result), {
		status: 201,
		headers: jsonHeaders(),
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
		const result = await loadObjectBody(env, key);
		if (!result.ok) return objectFailResponse(result);
		const headers = new Headers({
			'Content-Type': result.object.httpMetadata?.contentType || 'application/octet-stream',
			'Cache-Control': 'no-store',
			...getCorsHeaders(),
		});
		return new Response(result.object.body, { headers });
	}

	const result = await loadObjectMeta(env, key, url.origin);
	if (!result.ok) return objectFailResponse(result);

	const { ok: _ok, ...meta } = result;
	return new Response(JSON.stringify(meta), {
		headers: jsonHeaders(),
	});
}
