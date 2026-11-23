/**
 * App tokens made in the admin panel.
 *
 * Each is one object at `_cdn/tokens/<sha256(token)>.json` holding its scope.
 * Only the hash is stored: the token itself is shown once, to the owner who
 * made it, and cannot be recovered afterwards. Deleting the object revokes the
 * token on the next request. `scopeForToken` (scopes.js) does the lookup.
 *
 * Tokens in the `APP_TOKENS` secret keep working and are listed read-only;
 * changing those still takes `wrangler secret put`.
 */

import { TOKENS_KEY_PREFIX } from '../config/constants.js';
import { isReservedKey, normalizeObjectKey } from './objects.js';
import { OBJECT_OPS, normalizeScope, parseAppTokens, sha256Hex } from './scopes.js';

const APP_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_PREFIXES = 10;
const MAX_TOKENS_LISTED = 200;

function base64Url(bytes) {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

/**
 * @param {unknown} value
 * @returns {string|null} The folder as `a/b/`, or null when it cannot be a token's folder.
 */
function normalizePrefix(value) {
	// A panel token is always for named folders, never the whole bucket.
	if (typeof value !== 'string' || value.includes('*')) return null;
	const key = normalizeObjectKey(value.trim().replace(/\/+$/, ''));
	return key && !isReservedKey(`${key}/`) ? `${key}/` : null;
}

/**
 * @param {Object} env
 * @returns {Promise<Array<{ id: string, app: string, prefixes: string[], ops: string[], source: 'panel'|'config', createdAt: string|null, createdBy: string|null }>>}
 */
export async function listTokens(env) {
	const fromConfig = parseAppTokens(env.APP_TOKENS).map(([digest, scope]) => ({
		id: digest,
		...scope,
		source: 'config',
		createdAt: null,
		createdBy: null,
	}));

	const listed = await env.CDN_BUCKET.list({ prefix: TOKENS_KEY_PREFIX, limit: MAX_TOKENS_LISTED });
	const fromPanel = await Promise.all(
		listed.objects.map(async (entry) => {
			try {
				const stored = await (await env.CDN_BUCKET.get(entry.key)).json();
				const scope = normalizeScope(stored);
				if (!scope) return null;
				return {
					id: entry.key.slice(TOKENS_KEY_PREFIX.length).replace(/\.json$/, ''),
					...scope,
					source: 'panel',
					createdAt: typeof stored.createdAt === 'string' ? stored.createdAt : null,
					createdBy: typeof stored.createdBy === 'string' ? stored.createdBy : null,
				};
			} catch {
				return null;
			}
		}),
	);

	return [...fromPanel.filter(Boolean), ...fromConfig].sort((a, b) => a.app.localeCompare(b.app));
}

/**
 * @param {Object} env
 * @param {{ app?: unknown, prefixes?: unknown, ops?: unknown }} input
 * @param {string} createdBy
 * @returns {Promise<{ ok: true, token: string, id: string, app: string, prefixes: string[], ops: string[] } | { ok: false, error: string }>}
 */
export async function mintToken(env, input, createdBy) {
	const app = typeof input?.app === 'string' ? input.app.trim().toLowerCase() : '';
	if (!APP_NAME.test(app)) return { ok: false, error: 'Name must be lowercase letters, numbers and dashes, up to 40 characters.' };

	const rawPrefixes = Array.isArray(input?.prefixes) ? input.prefixes : [];
	if (!rawPrefixes.length || rawPrefixes.length > MAX_PREFIXES) return { ok: false, error: 'Give between one and ten folders.' };
	const prefixes = rawPrefixes.map(normalizePrefix);
	if (prefixes.some((prefix) => !prefix)) return { ok: false, error: 'One of the folders is not a valid path.' };

	const ops = Array.isArray(input?.ops) ? OBJECT_OPS.filter((op) => input.ops.includes(op)) : [];
	if (!ops.length) return { ok: false, error: 'Pick at least one permission.' };

	const token = `dxd_${app}_${base64Url(crypto.getRandomValues(new Uint8Array(24)))}`;
	const id = await sha256Hex(token);
	const scope = { app, prefixes: [...new Set(prefixes)], ops };
	await env.CDN_BUCKET.put(`${TOKENS_KEY_PREFIX}${id}.json`, JSON.stringify({ ...scope, createdAt: new Date().toISOString(), createdBy }), {
		httpMetadata: { contentType: 'application/json' },
	});
	return { ok: true, token, id, ...scope };
}

/**
 * @param {Object} env
 * @param {string} id sha256 of the token
 * @returns {Promise<{ ok: true, app: string } | { ok: false, status: number, error: string }>}
 */
export async function revokeToken(env, id) {
	if (!DIGEST.test(id)) return { ok: false, status: 400, error: 'Invalid token id' };
	const key = `${TOKENS_KEY_PREFIX}${id}.json`;
	const stored = await env.CDN_BUCKET.get(key);
	if (!stored) return { ok: false, status: 404, error: 'No such token. Tokens set in APP_TOKENS are changed with wrangler.' };
	let app = '';
	try {
		app = (await stored.json()).app || '';
	} catch {
		app = '';
	}
	await env.CDN_BUCKET.delete(key);
	return { ok: true, app };
}
