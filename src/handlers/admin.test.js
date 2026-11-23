import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { resetAccessKeyCache } from '../services/access.js';

const ORIGIN = 'https://cdn.designxdevelop.com';
const TEAM = 'dxd-test.cloudflareaccess.com';
const AUD = 'test-audience-tag';
const OWNER = 'owner@example.com';
const TEAMMATE = 'teammate@example.com';

let signingKey;
let publicJwk;
let otherKey;

function base64Url(input) {
	const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

async function assertion(claims = {}, { key = signingKey, header = {} } = {}) {
	const now = Math.floor(Date.now() / 1000);
	const head = base64Url(JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT', ...header }));
	const body = base64Url(
		JSON.stringify({ iss: `https://${TEAM}`, aud: [AUD], email: OWNER, sub: 'user-1', iat: now, exp: now + 300, ...claims }),
	);
	const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${body}`));
	return `${head}.${body}.${base64Url(signature)}`;
}

async function admin(path, { claims, token, method = 'GET', headers = {}, body } = {}) {
	const jwt = token === undefined ? await assertion(claims) : token;
	const all = { ...headers };
	if (jwt) all['Cf-Access-Jwt-Assertion'] = jwt;
	if (method !== 'GET' && !('Origin' in all)) all.Origin = ORIGIN;
	if (method !== 'GET' && !('X-DXD-Admin' in all)) all['X-DXD-Admin'] = '1';
	for (const [name, value] of Object.entries(all)) if (value === null) delete all[name];
	return SELF.fetch(`${ORIGIN}${path}`, { method, headers: all, body, redirect: 'manual' });
}

async function emptyBucket() {
	const page = await env.CDN_BUCKET.list();
	for (const object of page.objects) await env.CDN_BUCKET.delete(object.key);
}

beforeAll(async () => {
	const generate = () =>
		crypto.subtle.generateKey(
			{ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
			true,
			['sign', 'verify'],
		);
	const pair = await generate();
	signingKey = pair.privateKey;
	publicJwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'test-key' };
	otherKey = (await generate()).privateKey;
});

beforeEach(async () => {
	await emptyBucket();
	resetAccessKeyCache();
	env.ACCESS_TEAM_DOMAIN = TEAM;
	env.ACCESS_AUD = AUD;
	env.ADMIN_OWNERS = OWNER;
	delete env.ADMIN_DEV_EMAIL;
	const realFetch = globalThis.fetch;
	vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
		const target = typeof input === 'string' ? input : input.url;
		if (target === `https://${TEAM}/cdn-cgi/access/certs`) return Promise.resolve(Response.json({ keys: [publicJwk] }));
		return realFetch(input, init);
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	await emptyBucket();
});

describe('who gets into /admin', () => {
	test('a valid Access sign-in gets the page with a locked-down CSP', async () => {
		const response = await admin('/admin');
		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('private, no-store');
		expect(response.headers.get('X-Frame-Options')).toBe('DENY');

		const csp = response.headers.get('Content-Security-Policy');
		const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
		expect(nonce).toBeTruthy();
		expect(csp).not.toContain('unsafe-inline');
		const html = await response.text();
		expect(html).toContain(`<script nonce="${nonce}">`);
		expect(html).not.toContain('{{NONCE}}');
		expect(html).not.toContain(env.UPLOAD_PASSWORD);
	});

	test('no assertion is refused, and the operator password does not help', async () => {
		expect((await admin('/admin', { token: '' })).status).toBe(401);
		expect((await admin(`/admin?password=${env.UPLOAD_PASSWORD}`, { token: '' })).status).toBe(401);
		const bearer = await admin('/admin/api/files', { token: '', headers: { Authorization: `Bearer ${env.UPLOAD_PASSWORD}` } });
		expect(bearer.status).toBe(401);
	});

	test('with Access not configured the panel is closed, not open', async () => {
		env.ACCESS_AUD = '';
		expect((await admin('/admin')).status).toBe(503);
		expect((await admin('/admin/api/files')).status).toBe(503);
	});

	test('a team domain that is not Cloudflare Access is treated as not configured', async () => {
		env.ACCESS_TEAM_DOMAIN = 'attacker.example.com';
		expect((await admin('/admin')).status).toBe(503);
	});

	test.each([
		['signed by another key', async () => assertion({}, { key: otherKey })],
		['expired', async () => assertion({ exp: Math.floor(Date.now() / 1000) - 3600 })],
		['for another application', async () => assertion({ aud: ['someone-elses-app'] })],
		['from another issuer', async () => assertion({ iss: 'https://evil.cloudflareaccess.com' })],
		['an unsigned alg:none token', async () => `${(await assertion({}, { header: { alg: 'none' } })).split('.').slice(0, 2).join('.')}.`],
		[
			'tampered after signing',
			async () => {
				const [head, , signature] = (await assertion()).split('.');
				const forged = base64Url(JSON.stringify({ iss: `https://${TEAM}`, aud: [AUD], email: OWNER, exp: 9999999999 }));
				return `${head}.${forged}.${signature}`;
			},
		],
		['not a JWT at all', async () => 'nonsense'],
	])('an assertion %s is refused', async (_label, make) => {
		const response = await admin('/admin/api/files', { token: await make() });
		expect(response.status).toBe(401);
	});

	test('a service token (no email) is refused', async () => {
		expect((await admin('/admin/api/files', { claims: { email: undefined, common_name: 'svc' } })).status).toBe(403);
	});

	test('the local dev stand-in is ignored unless ENVIRONMENT is development', async () => {
		env.ADMIN_DEV_EMAIL = OWNER;
		expect(env.ENVIRONMENT).toBe('production');
		expect((await admin('/admin', { token: '' })).status).toBe(401);
	});

	test('/admin/api/me reports who is signed in and whether they can delete', async () => {
		expect(await (await admin('/admin/api/me')).json()).toEqual({ email: OWNER, canDelete: true });
		expect(await (await admin('/admin/api/me', { claims: { email: TEAMMATE } })).json()).toEqual({ email: TEAMMATE, canDelete: false });
	});
});

describe('admin files', () => {
	test('lists uploaded files and hides platform bookkeeping', async () => {
		await env.CDN_BUCKET.put('acme/site/prod/a.js', 'abc', { httpMetadata: { contentType: 'application/javascript' } });
		await env.CDN_BUCKET.put('_cdn/analytics/acme/site/prod/a.js.json', '{}');

		const body = await (await admin('/admin/api/files')).json();
		expect(body.truncated).toBe(false);
		expect(body.objects).toHaveLength(1);
		expect(body.objects[0]).toMatchObject({ key: 'acme/site/prod/a.js', size: 3, type: 'application/javascript' });
	});

	test('upload stores the file, and will not silently replace one', async () => {
		const first = await admin('/admin/api/objects?key=acme/site/prod/hero.txt', { method: 'PUT', body: 'one' });
		expect(first.status).toBe(201);
		expect((await first.json()).url).toBe(`${ORIGIN}/acme/site/prod/hero.txt`);

		const clash = await admin('/admin/api/objects?key=acme/site/prod/hero.txt', { method: 'PUT', body: 'two' });
		expect(clash.status).toBe(409);
		expect((await clash.json()).code).toBe('EXISTS');
		expect(await (await env.CDN_BUCKET.get('acme/site/prod/hero.txt')).text()).toBe('one');

		const replace = await admin('/admin/api/objects?key=acme/site/prod/hero.txt&overwrite=true', { method: 'PUT', body: 'two' });
		expect(replace.status).toBe(201);
		expect(await (await env.CDN_BUCKET.get('acme/site/prod/hero.txt')).text()).toBe('two');
	});

	test('upload refuses traversal and reserved keys', async () => {
		for (const key of ['../escaped.txt', '_cdn/analytics/x.json', 'admin/index.html', 'api/objects']) {
			const response = await admin(`/admin/api/objects?key=${encodeURIComponent(key)}`, { method: 'PUT', body: 'x' });
			expect(response.status, key).toBe(400);
		}
		expect((await env.CDN_BUCKET.list()).objects).toEqual([]);
	});

	test('a teammate can upload but cannot delete', async () => {
		const teammate = { email: TEAMMATE };
		expect((await admin('/admin/api/objects?key=acme/site/prod/t.txt', { method: 'PUT', body: 'x', claims: teammate })).status).toBe(201);

		const response = await admin('/admin/api/objects?key=acme/site/prod/t.txt', { method: 'DELETE', claims: teammate });
		expect(response.status).toBe(403);
		expect(await env.CDN_BUCKET.head('acme/site/prod/t.txt')).not.toBeNull();
	});

	test('with no owners configured, nobody can delete', async () => {
		env.ADMIN_OWNERS = '';
		await env.CDN_BUCKET.put('acme/site/prod/t.txt', 'x');
		expect((await admin('/admin/api/objects?key=acme/site/prod/t.txt', { method: 'DELETE' })).status).toBe(403);
	});

	test('an owner deletes the file and its counters', async () => {
		await env.CDN_BUCKET.put('acme/site/prod/t.txt', 'x');
		await env.CDN_BUCKET.put('_cdn/analytics/acme/site/prod/t.txt.json', '{"requestCount":2}');

		const response = await admin('/admin/api/objects?key=acme/site/prod/t.txt', { method: 'DELETE' });
		expect(response.status).toBe(200);
		expect(await env.CDN_BUCKET.head('acme/site/prod/t.txt')).toBeNull();
		expect(await env.CDN_BUCKET.head('_cdn/analytics/acme/site/prod/t.txt.json')).toBeNull();
	});

	test.each([
		['from another site', { Origin: 'https://evil.example' }],
		['with no Origin', { Origin: null }],
		['without the panel header', { 'X-DXD-Admin': null }],
	])('a write %s is refused even with a valid sign-in', async (_label, headers) => {
		await env.CDN_BUCKET.put('acme/site/prod/t.txt', 'x');
		const remove = await admin('/admin/api/objects?key=acme/site/prod/t.txt', { method: 'DELETE', headers });
		expect(remove.status).toBe(403);
		expect(await env.CDN_BUCKET.head('acme/site/prod/t.txt')).not.toBeNull();

		const write = await admin('/admin/api/objects?key=acme/site/prod/new.txt', { method: 'PUT', body: 'x', headers });
		expect(write.status).toBe(403);
		expect(await env.CDN_BUCKET.head('acme/site/prod/new.txt')).toBeNull();
	});

	test('stats and usage read the request counters', async () => {
		await env.CDN_BUCKET.put('_cdn/analytics/acme/site/prod/a.js.json', '{"requestCount":7,"lastServed":"2026-11-01T00:00:00.000Z"}');
		await env.CDN_BUCKET.put('_cdn/analytics/other/site/prod/b.js.json', '{"requestCount":1}');

		expect((await (await admin('/admin/api/stats?key=acme/site/prod/a.js')).json()).requestCount).toBe(7);

		const usage = await (await admin('/admin/api/usage?prefix=acme/')).json();
		expect(usage.counters).toEqual([
			{ key: 'acme/site/prod/a.js', requestCount: 7, firstServed: null, lastServed: '2026-11-01T00:00:00.000Z' },
		]);
		expect(usage.cursor).toBeNull();
	});

	test('admin responses are never shared cross-origin', async () => {
		const response = await admin('/admin/api/files');
		expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
		expect(response.headers.get('Cache-Control')).toBe('private, no-store');
	});

	test('unknown admin paths are 404 after sign-in and 401 before it', async () => {
		expect((await admin('/admin/api/nope')).status).toBe(404);
		expect((await admin('/admin/anything')).status).toBe(404);
		expect((await admin('/admin/api/nope', { token: '' })).status).toBe(401);
	});
});
