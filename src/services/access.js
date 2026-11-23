/**
 * Cloudflare Access sign-in check for the admin panel.
 *
 * Access sits in front of `/admin` and adds a signed JWT to every request it
 * lets through (`Cf-Access-Jwt-Assertion`). The Worker verifies that JWT itself
 * rather than trusting that Access is in the path: if the Access application is
 * deleted, misrouted, or the Worker is reached some other way, a request with
 * no valid assertion is still refused.
 *
 * Config (wrangler.toml `[vars]`, neither is a secret):
 *   ACCESS_TEAM_DOMAIN  e.g. "your-team.cloudflareaccess.com"
 *   ACCESS_AUD          the Access application's Audience (AUD) tag
 *   ADMIN_OWNERS        comma-separated emails allowed to delete. Everyone
 *                       else Access lets in can browse and upload only. Empty
 *                       means nobody can delete from the panel.
 *
 * With either of the first two unset the panel is closed, not open.
 */

const ASSERTION_HEADER = 'Cf-Access-Jwt-Assertion';
const JWKS_TTL_MS = 60 * 60 * 1000;
/** Tolerated clock difference between Cloudflare's issuer and this isolate. */
const CLOCK_SKEW_SECONDS = 60;

/** @type {Map<string, { keys: Map<string, CryptoKey>, fetchedAt: number }>} */
const jwksCache = new Map();

/**
 * @typedef {{ ok: true, identity: { email: string, sub: string, owner: boolean } } | { ok: false, status: 401|403|503, reason: string }} AccessResult
 */

/**
 * @param {Object} env
 * @returns {{ teamDomain: string, audience: string } | null} null when Access is not configured.
 */
export function accessConfig(env) {
	const teamDomain = String(env.ACCESS_TEAM_DOMAIN || '')
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//, '')
		.replace(/\/+$/, '');
	const audience = String(env.ACCESS_AUD || '').trim();
	// Only ever fetch signing keys from Cloudflare Access itself.
	if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(teamDomain) || !audience) return null;
	return { teamDomain, audience };
}

/**
 * @param {Object} env
 * @param {string} email
 * @returns {boolean}
 */
function isOwner(env, email) {
	return String(env.ADMIN_OWNERS || '')
		.split(',')
		.map((entry) => entry.trim().toLowerCase())
		.filter(Boolean)
		.includes(email.toLowerCase());
}

/**
 * @param {string} value base64url
 * @returns {Uint8Array}
 */
function base64UrlBytes(value) {
	const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
	return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

/**
 * @param {string} value base64url-encoded JSON
 * @returns {any}
 */
function base64UrlJson(value) {
	return JSON.parse(new TextDecoder().decode(base64UrlBytes(value)));
}

/**
 * @param {string} teamDomain
 * @param {boolean} forceRefresh
 * @returns {Promise<Map<string, CryptoKey>>}
 */
async function signingKeys(teamDomain, forceRefresh) {
	const cached = jwksCache.get(teamDomain);
	if (cached && !forceRefresh && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;

	const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
	if (!response.ok) throw new Error(`Access certs returned ${response.status}`);
	const body = await response.json();

	const keys = new Map();
	for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
		if (jwk?.kty !== 'RSA' || !jwk.kid) continue;
		keys.set(
			jwk.kid,
			await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, RSA_SHA256, false, ['verify']),
		);
	}
	jwksCache.set(teamDomain, { keys, fetchedAt: Date.now() });
	return keys;
}

const RSA_SHA256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };

/** For tests: forget cached signing keys. */
export function resetAccessKeyCache() {
	jwksCache.clear();
}

/**
 * Local development only. Access cannot run in front of `wrangler dev`, so two
 * `.dev.vars` lines stand in for it: `ENVIRONMENT=development` and
 * `ADMIN_DEV_EMAIL=you@example.com`. The deployed Worker gets
 * ENVIRONMENT=production from wrangler.toml on every deploy, so this cannot
 * switch on there without two deliberate changes. (The request hostname is no
 * use as a guard: `wrangler dev` rewrites it to the production route.)
 * @param {Object} env
 * @returns {string|null}
 */
function devIdentity(env) {
	if (env.ENVIRONMENT !== 'development') return null;
	return String(env.ADMIN_DEV_EMAIL || '').trim() || null;
}

/**
 * @param {Request} request
 * @param {Object} env
 * @returns {Promise<AccessResult>}
 */
export async function verifyAccess(request, env) {
	const devEmail = devIdentity(env);
	if (devEmail) return { ok: true, identity: { email: devEmail, sub: 'dev', owner: isOwner(env, devEmail) } };

	const config = accessConfig(env);
	if (!config) return { ok: false, status: 503, reason: 'not-configured' };

	const token = request.headers.get(ASSERTION_HEADER) || '';
	const parts = token.split('.');
	if (parts.length !== 3) return { ok: false, status: 401, reason: 'no-assertion' };

	let header;
	let claims;
	let signature;
	try {
		header = base64UrlJson(parts[0]);
		claims = base64UrlJson(parts[1]);
		signature = base64UrlBytes(parts[2]);
	} catch {
		return { ok: false, status: 401, reason: 'malformed' };
	}

	// Pin the algorithm: never let the token choose how it is verified.
	if (header?.alg !== 'RS256' || typeof header.kid !== 'string') return { ok: false, status: 401, reason: 'algorithm' };

	let key;
	try {
		key = (await signingKeys(config.teamDomain, false)).get(header.kid);
		// Access rotates keys; an unknown kid earns one refetch before refusal.
		if (!key) key = (await signingKeys(config.teamDomain, true)).get(header.kid);
	} catch (error) {
		console.error('Access signing keys unavailable', { error: error.message });
		return { ok: false, status: 503, reason: 'keys-unavailable' };
	}
	if (!key) return { ok: false, status: 401, reason: 'unknown-key' };

	const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
	if (!(await crypto.subtle.verify(RSA_SHA256, key, signature, signed))) {
		return { ok: false, status: 401, reason: 'signature' };
	}

	const now = Math.floor(Date.now() / 1000);
	if (typeof claims?.exp !== 'number' || claims.exp < now - CLOCK_SKEW_SECONDS) return { ok: false, status: 401, reason: 'expired' };
	if (typeof claims.nbf === 'number' && claims.nbf > now + CLOCK_SKEW_SECONDS) return { ok: false, status: 401, reason: 'not-yet-valid' };
	if (claims.iss !== `https://${config.teamDomain}`) return { ok: false, status: 401, reason: 'issuer' };

	const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (!audiences.includes(config.audience)) return { ok: false, status: 401, reason: 'audience' };

	const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : '';
	// A person, not a service token: the panel is for signed-in people.
	if (!email) return { ok: false, status: 403, reason: 'no-email' };

	return { ok: true, identity: { email, sub: String(claims.sub || ''), owner: isOwner(env, email) } };
}
