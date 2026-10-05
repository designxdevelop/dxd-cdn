/**
 * Programmatic object put/get for any DXD app or client project.
 *
 * Auth: `Authorization: Bearer <token>` (or `?password=` for parity with the
 * existing APIs). The token is either an `APP_TOKENS` entry, which is limited
 * to its own prefixes and ops, or `UPLOAD_PASSWORD`, which is the operator
 * token and can reach the whole bucket. Prefix and op checks live in
 * src/services/objects.js; this module only maps the result to a status code.
 *
 * Keys are project-agnostic. Convention (recommended):
 *   {client}/{project}/{env}/...
 * Examples:
 *   acme/site/prod/hero.webp
 *   dxd-studio/countdown/prod/widgets/{id}/config.json
 */

import {
	listObjects,
	loadObjectBody,
	loadObjectMeta,
	objectErrorMessage,
	objectErrorStatus,
	removeObject,
	storeObject,
} from '../services/objects.js';
import { resolveScope } from '../services/scopes.js';
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
 * PUT /api/objects
 * Headers:
 *   Authorization: Bearer <app token or UPLOAD_PASSWORD>
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
	const scope = await resolveScope(request, url, env);
	if (!scope) return unauthorized();

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

	const result = await storeObject(env, scope, {
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
	const scope = await resolveScope(request, url, env);
	if (!scope) return unauthorized();

	const key = url.searchParams.get('key') || '';
	const as = url.searchParams.get('as') || 'meta';

	if (as === 'body') {
		const result = await loadObjectBody(env, scope, key);
		if (!result.ok) return objectFailResponse(result);
		const headers = new Headers({
			'Content-Type': result.object.httpMetadata?.contentType || 'application/octet-stream',
			'Cache-Control': 'no-store',
			...getCorsHeaders(),
		});
		return new Response(result.object.body, { headers });
	}

	const result = await loadObjectMeta(env, scope, key, url.origin);
	if (!result.ok) return objectFailResponse(result);

	const { ok: _ok, ...meta } = result;
	return new Response(JSON.stringify(meta), {
		headers: jsonHeaders(),
	});
}

/**
 * HEAD /api/objects?key=…
 *
 * Existence and freshness without a body, for CI and `curl -I`. The metadata
 * travels in headers because a HEAD response cannot carry the JSON that
 * `GET …&as=meta` returns.
 */
export async function handleHeadObjectApi(request, env, url) {
	const scope = await resolveScope(request, url, env);
	if (!scope) return new Response(null, { status: 401, headers: jsonHeaders() });

	const result = await loadObjectMeta(env, scope, url.searchParams.get('key') || '', url.origin);
	if (!result.ok) {
		return new Response(null, { status: objectErrorStatus(result.code), headers: jsonHeaders() });
	}

	const headers = new Headers(jsonHeaders());
	headers.set('ETag', result.etag);
	headers.set('Last-Modified', new Date(result.uploaded).toUTCString());
	headers.set('X-DXD-Object-Key', result.key);
	headers.set('X-DXD-Object-Size', String(result.size));
	if (result.contentType) headers.set('X-DXD-Content-Type', result.contentType);
	if (result.cacheControl) headers.set('X-DXD-Cache-Control', result.cacheControl);

	return new Response(null, { status: 200, headers });
}

/**
 * DELETE /api/objects?key=…
 *
 * Needs the `delete` op in the token scope, which app tokens do not have by
 * default. Purges the key's cached response on the way out.
 */
export async function handleDeleteObjectApi(request, env, url) {
	const scope = await resolveScope(request, url, env);
	if (!scope) return unauthorized();

	const result = await removeObject(env, scope, url.searchParams.get('key') || '');
	if (!result.ok) return objectFailResponse(result);

	return new Response(JSON.stringify({ ok: true, key: result.key, purged: result.purged }), {
		headers: jsonHeaders(),
	});
}

/**
 * GET /api/objects/list?prefix=&cursor=&limit=&delimiter=
 *
 * One R2 page at a time with the cursor to continue. `prefix` may be omitted by
 * an operator token (whole bucket) or by a token with exactly one prefix.
 */
export async function handleListObjectsApi(request, env, url) {
	const scope = await resolveScope(request, url, env);
	if (!scope) return unauthorized();

	const result = await listObjects(env, scope, {
		prefix: url.searchParams.get('prefix') || '',
		cursor: url.searchParams.get('cursor') || '',
		limit: url.searchParams.get('limit'),
		delimiter: url.searchParams.get('delimiter') || '',
	});
	if (!result.ok) return objectFailResponse(result);

	const { ok: _ok, ...page } = result;
	return new Response(JSON.stringify(page), { headers: jsonHeaders() });
}
