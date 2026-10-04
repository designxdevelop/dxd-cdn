/**
 * Scoped API tokens. One secret per app instead of one secret for the bucket.
 *
 * `APP_TOKENS` is a JSON object keyed by the lowercase hex SHA-256 of each token,
 * so the plaintext tokens only ever exist in the holders' own secret stores:
 *
 *   {
 *     "<sha256(token)>": { "app": "heard",  "prefixes": ["heard/"],      "ops": ["put", "get", "list"] },
 *     "<sha256(token)>": { "app": "studio", "prefixes": ["dxd-studio/"], "ops": ["put", "get"] }
 *   }
 *
 * `UPLOAD_PASSWORD` stays valid as the operator token: every op, every prefix.
 *
 * Enforcement lives in src/services/objects.js so the HTTP Objects API and the
 * CdnObjects RPC entrypoint cannot drift apart.
 */

/** A `prefixes` entry meaning "the whole bucket". */
export const ALL_PREFIXES = '*';

/** Operations a scope can grant. */
export const OBJECT_OPS = ['put', 'get', 'list', 'delete'];

/**
 * @typedef {{ app: string, prefixes: string[], ops: string[] }} Scope
 */

/** @type {Scope} */
export const OPERATOR_SCOPE = Object.freeze({
	app: 'operator',
	prefixes: Object.freeze([ALL_PREFIXES]),
	ops: Object.freeze([...OBJECT_OPS]),
});

/**
 * @param {string} value
 * @returns {Promise<string>} Lowercase hex SHA-256.
 */
export async function sha256Hex(value) {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Compares digests, not secrets, and without an early return on the first
 * differing character.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function digestsMatch(a, b) {
	if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
	let difference = 0;
	for (let index = 0; index < a.length; index++) {
		difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
	}
	return difference === 0;
}

/**
 * `Authorization: Bearer <token>` or `?password=<token>`.
 * @param {Request} request
 * @param {URL} url
 * @returns {string}
 */
export function presentedToken(request, url) {
	const header = request.headers.get('Authorization') || '';
	if (header.startsWith('Bearer ')) return header.slice(7).trim();
	return url.searchParams.get('password') || '';
}

/**
 * @param {unknown} entry
 * @returns {Scope|null}
 */
function normalizeScope(entry) {
	if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
	const app = typeof entry.app === 'string' && entry.app ? entry.app : null;
	const prefixes = Array.isArray(entry.prefixes) ? entry.prefixes.filter((value) => typeof value === 'string' && value) : [];
	const ops = Array.isArray(entry.ops) ? entry.ops.filter((value) => OBJECT_OPS.includes(value)) : [];
	if (!app || !prefixes.length || !ops.length) return null;
	return { app, prefixes, ops };
}

/**
 * @param {string|undefined} raw
 * @returns {Array<[string, Scope]>}
 */
function parseAppTokens(raw) {
	if (!raw) return [];
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		console.error('APP_TOKENS is not valid JSON; no app tokens are active');
		return [];
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		console.error('APP_TOKENS must be a JSON object keyed by sha256(token)');
		return [];
	}
	const entries = [];
	for (const [digest, entry] of Object.entries(parsed)) {
		const scope = normalizeScope(entry);
		if (!scope) {
			console.error('Ignoring malformed APP_TOKENS entry', { digest: `${digest.slice(0, 8)}…` });
			continue;
		}
		entries.push([digest.toLowerCase(), scope]);
	}
	return entries;
}

/**
 * Resolve a token to what it is allowed to do.
 * @param {Object} env
 * @param {string} token
 * @returns {Promise<Scope|null>} null when the token is missing or unknown.
 */
export async function scopeForToken(env, token) {
	if (!token) return null;
	const digest = await sha256Hex(token);

	if (env.UPLOAD_PASSWORD && digestsMatch(digest, await sha256Hex(env.UPLOAD_PASSWORD))) {
		return OPERATOR_SCOPE;
	}

	let match = null;
	for (const [candidate, scope] of parseAppTokens(env.APP_TOKENS)) {
		if (digestsMatch(digest, candidate)) match = scope;
	}
	return match;
}

/**
 * @param {Request} request
 * @param {URL} url
 * @param {Object} env
 * @returns {Promise<Scope|null>}
 */
export async function resolveScope(request, url, env) {
	return scopeForToken(env, presentedToken(request, url));
}

/**
 * Prefixes are path-segment boundaries: `heard` grants `heard/a.js` but not
 * `heard-staging/a.js`. An exact key is a valid single-object prefix.
 * @param {string} key
 * @param {string} prefix
 * @returns {boolean}
 */
export function keyInPrefix(key, prefix) {
	if (prefix === ALL_PREFIXES) return true;
	if (!key || !prefix) return false;
	if (key === prefix) return true;
	return key.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
}

/**
 * @param {Scope|null|undefined} scope
 * @param {'put'|'get'|'list'|'delete'} op
 * @param {string} key Object key, or the prefix being listed.
 * @returns {boolean}
 */
export function scopeAllows(scope, op, key) {
	if (!scope || !Array.isArray(scope.ops) || !Array.isArray(scope.prefixes)) return false;
	if (!scope.ops.includes(op)) return false;
	return scope.prefixes.some((prefix) => keyInPrefix(key, prefix));
}
