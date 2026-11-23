/**
 * Admin panel: `/admin` (the page) and `/admin/api/*` (what the page calls).
 *
 * Everything here sits behind Cloudflare Access and re-verifies the Access JWT
 * on every request (src/services/access.js). The browser never holds
 * `UPLOAD_PASSWORD` or any other bucket credential: the signed-in person's
 * identity is the credential, and the Worker acts on the bucket for them.
 */

import { ANALYTICS_KEY_PREFIX, IMMUTABLE_CACHE_CONTROL, MUTABLE_CACHE_CONTROL, RESERVED_KEY_PREFIXES } from '../config/constants.js';
import { verifyAccess } from '../services/access.js';
import { moveObject, normalizeObjectKey, objectErrorMessage, objectErrorStatus, removeObject, storeObject } from '../services/objects.js';
import { ALL_PREFIXES, OBJECT_OPS } from '../services/scopes.js';
import adminHtml from '../templates/html/admin.html';
import { MAX_LIST_PAGES, getFileStats } from '../utils/files.js';
import { purgeObjectKey } from '../utils/purge.js';

/** Sent by the page on every write; a cross-site form cannot set it. */
const CSRF_HEADER = 'X-DXD-Admin';

/** How much of a file the text preview reads. */
const PREVIEW_BYTES = 64 * 1024;

/** Counter objects read per usage page. Stays under the 50-subrequest floor. */
const USAGE_PAGE_SIZE = 40;

const SECURITY_HEADERS = {
	'Cache-Control': 'private, no-store',
	'X-Content-Type-Options': 'nosniff',
	'X-Frame-Options': 'DENY',
	'Referrer-Policy': 'no-referrer',
	'Cross-Origin-Opener-Policy': 'same-origin',
};

function json(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', ...SECURITY_HEADERS },
	});
}

function messagePage(status, title, detail) {
	const html = `<!DOCTYPE html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>DXD CDN Admin</title><body><h1>${title}</h1><p>${detail}</p></body></html>`;
	return new Response(html, {
		status,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
			...SECURITY_HEADERS,
		},
	});
}

const DENIED = {
	'not-configured': [
		'Admin panel is not set up',
		'Cloudflare Access is not configured for this Worker, so the panel stays closed. Set ACCESS_TEAM_DOMAIN and ACCESS_AUD (see docs/admin-panel.md).',
	],
	'keys-unavailable': ['Sign-in is temporarily unavailable', 'Cloudflare Access signing keys could not be loaded. Try again shortly.'],
	'no-email': ['Not allowed', 'This panel is for signed-in people, not service tokens.'],
};

function denied(result, wantsJson) {
	const [title, detail] = DENIED[result.reason] || [
		'Sign-in required',
		'This page is only reachable through Cloudflare Access. Open it at the CDN address and sign in.',
	];
	if (wantsJson) return json({ error: title }, result.status);
	return messagePage(result.status, title, detail);
}

/**
 * The page. A fresh nonce per response is the only thing allowed to run script
 * or apply styles, so an object name or anything else rendered into the page
 * cannot become code.
 */
function page() {
	const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
	const csp = [
		"default-src 'none'",
		`script-src 'nonce-${nonce}'`,
		`style-src 'nonce-${nonce}'`,
		"img-src 'self'",
		"media-src 'self'",
		"connect-src 'self'",
		"base-uri 'none'",
		"form-action 'none'",
		"frame-ancestors 'none'",
	].join('; ');
	return new Response(adminHtml.replace(/{{NONCE}}/g, nonce), {
		headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp, ...SECURITY_HEADERS },
	});
}

/**
 * Whole-bucket scope carrying who is acting, so the existing `object stored` /
 * `object deleted` log lines name the person. Only an owner's scope includes
 * `delete`, so the storage layer itself refuses a delete from anyone else.
 */
function scopeFor(identity) {
	const ops = identity.owner ? [...OBJECT_OPS] : OBJECT_OPS.filter((op) => op !== 'delete');
	return { app: `admin:${identity.email}`, prefixes: [ALL_PREFIXES], ops };
}

function objectFail(result) {
	return json({ error: objectErrorMessage(result.code), code: result.code, key: result.key }, objectErrorStatus(result.code));
}

/** Every uploaded object with the fields the panel shows. Filtering happens in the page. */
async function listFiles(env) {
	const objects = [];
	let cursor;
	let truncated = true;

	for (let pageNumber = 0; pageNumber < MAX_LIST_PAGES; pageNumber++) {
		const result = await env.CDN_BUCKET.list({ cursor, limit: 1000, include: ['httpMetadata'] });
		for (const object of result.objects) {
			if (RESERVED_KEY_PREFIXES.some((reserved) => object.key.startsWith(reserved))) continue;
			objects.push({
				key: object.key,
				size: object.size,
				uploaded: object.uploaded instanceof Date ? object.uploaded.toISOString() : object.uploaded,
				type: object.httpMetadata?.contentType || null,
				cache: object.httpMetadata?.cacheControl || null,
			});
		}
		if (!result.truncated) {
			truncated = false;
			break;
		}
		cursor = result.cursor;
	}

	return { objects, truncated };
}

/** One page of request counters under a key prefix, for the Usage tab. */
async function listUsage(env, url) {
	const prefix = (url.searchParams.get('prefix') || '').replace(/^\/+/, '');
	const listed = await env.CDN_BUCKET.list({
		prefix: `${ANALYTICS_KEY_PREFIX}${prefix}`,
		cursor: url.searchParams.get('cursor') || undefined,
		limit: USAGE_PAGE_SIZE,
	});

	const counters = await Promise.all(
		listed.objects.map(async (entry) => {
			const key = entry.key.slice(ANALYTICS_KEY_PREFIX.length).replace(/\.json$/, '');
			try {
				const stats = JSON.parse(await (await env.CDN_BUCKET.get(entry.key)).text());
				return {
					key,
					requestCount: Number(stats.requestCount) || 0,
					firstServed: stats.firstServed || null,
					lastServed: stats.lastServed || null,
				};
			} catch {
				return { key, requestCount: 0, firstServed: null, lastServed: null };
			}
		}),
	);

	return { counters, cursor: listed.truncated ? listed.cursor : null };
}

/**
 * The first part of a file as plain text, for the code preview. Always
 * `text/plain` with nosniff, so stored HTML or SVG can never run on the admin
 * origin.
 */
async function preview(env, url) {
	const key = normalizeObjectKey(url.searchParams.get('key') || '');
	if (!key) return json({ error: 'Invalid or missing key' }, 400);
	const object = await env.CDN_BUCKET.get(key, { range: { offset: 0, length: PREVIEW_BYTES } });
	if (!object) return json({ error: 'Not found' }, 404);
	return new Response(object.body, {
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
			'Content-Security-Policy': "default-src 'none'; sandbox",
			'X-DXD-Truncated': String(object.size > PREVIEW_BYTES),
			...SECURITY_HEADERS,
		},
	});
}

async function upload(request, env, url, identity) {
	const policy = url.searchParams.get('cache') === 'immutable' ? IMMUTABLE_CACHE_CONTROL : MUTABLE_CACHE_CONTROL;
	const result = await storeObject(env, scopeFor(identity), {
		key: url.searchParams.get('key') || '',
		// Streamed straight to R2; the browser sends a Content-Length for a File.
		body: request.body ?? '',
		contentType: request.headers.get('Content-Type') || undefined,
		cacheControl: policy,
		overwrite: url.searchParams.get('overwrite') === 'true',
		origin: url.origin,
	});
	if (!result.ok) return objectFail(result);
	return json(result, 201);
}

/**
 * @param {Request} request
 * @param {Object} env
 * @param {URL} url
 * @returns {Promise<Response>}
 */
export async function handleAdmin(request, env, url) {
	const isApi = url.pathname.startsWith('/admin/api/');
	const access = await verifyAccess(request, env);
	if (!access.ok) return denied(access, isApi);
	const { identity } = access;

	if (!isApi) {
		if (url.pathname !== '/admin' && url.pathname !== '/admin/') return messagePage(404, 'Not found', 'There is no admin page here.');
		if (request.method !== 'GET' && request.method !== 'HEAD') return messagePage(405, 'Method not allowed', '');
		return page();
	}

	const route = url.pathname.slice('/admin/api/'.length);
	const isWrite = request.method !== 'GET' && request.method !== 'HEAD';

	// Writes must come from the panel itself. The Access cookie alone is not
	// enough: another site could otherwise ride it with a cross-site request.
	if (isWrite && (request.headers.get('Origin') !== url.origin || request.headers.get(CSRF_HEADER) !== '1')) {
		return json({ error: 'Cross-site request refused' }, 403);
	}

	if (route === 'me' && request.method === 'GET') {
		return json({ email: identity.email, canDelete: identity.owner });
	}

	if (route === 'files' && request.method === 'GET') {
		return json(await listFiles(env));
	}

	if (route === 'stats' && request.method === 'GET') {
		const key = normalizeObjectKey(url.searchParams.get('key') || '');
		if (!key) return json({ error: 'Invalid or missing key' }, 400);
		return json(await getFileStats(env.CDN_BUCKET, key));
	}

	if (route === 'preview' && request.method === 'GET') {
		return preview(env, url);
	}

	if (route === 'move' && request.method === 'POST') {
		if (!identity.owner) return json({ error: 'Only an owner can rename or move files' }, 403);
		const result = await moveObject(
			env,
			scopeFor(identity),
			url.searchParams.get('from') || '',
			url.searchParams.get('to') || '',
			url.origin,
		);
		if (!result.ok) return objectFail(result);
		return json(result);
	}

	if (route === 'usage' && request.method === 'GET') {
		return json(await listUsage(env, url));
	}

	if (route === 'objects' && request.method === 'PUT') {
		return upload(request, env, url, identity);
	}

	if (route === 'objects' && request.method === 'DELETE') {
		if (!identity.owner) return json({ error: 'Only an owner can delete files' }, 403);
		const result = await removeObject(env, scopeFor(identity), url.searchParams.get('key') || '');
		if (!result.ok) return objectFail(result);
		return json({ ok: true, key: result.key, purged: result.purged });
	}

	if (route === 'purge' && request.method === 'POST') {
		const key = normalizeObjectKey(url.searchParams.get('key') || '');
		if (!key) return json({ error: 'Invalid or missing key' }, 400);
		const outcome = await purgeObjectKey(key);
		console.log('cache purged by hand', { app: `admin:${identity.email}`, key, purged: outcome.purged, reason: outcome.reason });
		return json({ key, purged: outcome.purged, reason: outcome.reason || null });
	}

	return json({ error: 'Not found' }, 404);
}
