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

describe('admin rename, move and preview', () => {
	test('an owner moves a file: new key has the same bytes and metadata, the old key and its counters are gone', async () => {
		await env.CDN_BUCKET.put('acme/site/prod/old.css', 'body{}', {
			httpMetadata: { contentType: 'text/css; charset=utf-8', cacheControl: 'public, max-age=0, must-revalidate' },
		});
		await env.CDN_BUCKET.put('_cdn/analytics/acme/site/prod/old.css.json', '{"requestCount":4}');

		const response = await admin('/admin/api/move?from=acme/site/prod/old.css&to=acme/site/prod/css/new.css', { method: 'POST' });
		expect(response.status).toBe(200);
		expect((await response.json()).url).toBe(`${ORIGIN}/acme/site/prod/css/new.css`);

		const moved = await env.CDN_BUCKET.get('acme/site/prod/css/new.css');
		expect(await moved.text()).toBe('body{}');
		expect(moved.httpMetadata.contentType).toBe('text/css; charset=utf-8');
		expect(moved.httpMetadata.cacheControl).toBe('public, max-age=0, must-revalidate');
		expect(await env.CDN_BUCKET.head('acme/site/prod/old.css')).toBeNull();
		expect(await env.CDN_BUCKET.head('_cdn/analytics/acme/site/prod/old.css.json')).toBeNull();
	});

	test('a move never overwrites, and leaves the source in place when it is refused', async () => {
		await env.CDN_BUCKET.put('acme/site/prod/a.txt', 'a');
		await env.CDN_BUCKET.put('acme/site/prod/b.txt', 'b');

		const clash = await admin('/admin/api/move?from=acme/site/prod/a.txt&to=acme/site/prod/b.txt', { method: 'POST' });
		expect(clash.status).toBe(409);
		expect(await (await env.CDN_BUCKET.get('acme/site/prod/a.txt')).text()).toBe('a');
		expect(await (await env.CDN_BUCKET.get('acme/site/prod/b.txt')).text()).toBe('b');

		for (const to of ['../x.txt', '_cdn/x.txt', 'admin/x.txt', 'acme/site/prod/a.txt']) {
			const bad = await admin(`/admin/api/move?from=acme/site/prod/a.txt&to=${encodeURIComponent(to)}`, { method: 'POST' });
			expect(bad.status, to).toBe(400);
		}
		expect((await admin('/admin/api/move?from=acme/site/prod/missing.txt&to=acme/site/prod/c.txt', { method: 'POST' })).status).toBe(404);
		expect(await env.CDN_BUCKET.head('acme/site/prod/a.txt')).not.toBeNull();
	});

	test('a teammate cannot move, and a cross-site move is refused', async () => {
		await env.CDN_BUCKET.put('acme/site/prod/a.txt', 'a');
		const path = '/admin/api/move?from=acme/site/prod/a.txt&to=acme/site/prod/z.txt';

		expect((await admin(path, { method: 'POST', claims: { email: TEAMMATE } })).status).toBe(403);
		expect((await admin(path, { method: 'POST', headers: { Origin: 'https://evil.example' } })).status).toBe(403);
		expect(await env.CDN_BUCKET.head('acme/site/prod/a.txt')).not.toBeNull();
		expect(await env.CDN_BUCKET.head('acme/site/prod/z.txt')).toBeNull();
	});

	test('preview returns stored HTML as inert plain text', async () => {
		await env.CDN_BUCKET.put('acme/site/prod/page.html', '<script>alert(1)</script>', { httpMetadata: { contentType: 'text/html' } });

		const response = await admin('/admin/api/preview?key=acme/site/prod/page.html');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
		expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(response.headers.get('Content-Security-Policy')).toContain('sandbox');
		expect(response.headers.get('X-DXD-Truncated')).toBe('false');
		expect(await response.text()).toBe('<script>alert(1)</script>');

		expect((await admin('/admin/api/preview?key=acme/site/prod/none.html')).status).toBe(404);
		expect((await admin('/admin/api/preview?key=acme/site/prod/page.html', { token: '' })).status).toBe(401);
	});

	test('preview stops at the size cap', async () => {
		await env.CDN_BUCKET.put('acme/site/prod/big.js', 'x'.repeat(70 * 1024));
		const response = await admin('/admin/api/preview?key=acme/site/prod/big.js');
		expect(response.headers.get('X-DXD-Truncated')).toBe('true');
		expect((await response.text()).length).toBe(64 * 1024);
	});
});

const put = (key, body, extra = '') => admin(`/admin/api/objects?key=${encodeURIComponent(key)}${extra}`, { method: 'PUT', body });

describe('admin versions and activity', () => {
	test('replacing a file keeps the old copy, and restoring it brings the bytes back', async () => {
		const key = 'acme/site/prod/app.js';
		expect((await put(key, 'one')).status).toBe(201);
		expect((await put(key, 'two', '&overwrite=true')).status).toBe(201);

		const { versions } = await (await admin(`/admin/api/versions?key=${key}`)).json();
		expect(versions.length).toBe(1);
		expect(versions[0]).toMatchObject({ reason: 'replaced', size: 3, by: `admin:${OWNER}` });

		const restored = await admin(`/admin/api/restore?key=${key}&version=${versions[0].id}`, {
			method: 'POST',
			claims: { email: TEAMMATE },
		});
		expect(restored.status).toBe(200);
		expect(await (await env.CDN_BUCKET.get(key)).text()).toBe('one');

		// The copy the restore pushed out is itself kept, so a restore can be undone.
		const after = (await (await admin(`/admin/api/versions?key=${key}`)).json()).versions;
		expect(after.length).toBe(2);
		expect(await (await env.CDN_BUCKET.get(`_cdn/versions/${key}?${after[0].id}`)).text()).toBe('two');
	});

	test('only the newest five copies of a file are kept', async () => {
		const key = 'acme/site/prod/busy.css';
		for (let round = 0; round < 8; round++) await put(key, `v${round}`, '&overwrite=true');
		const { versions } = await (await admin(`/admin/api/versions?key=${key}`)).json();
		expect(versions.length).toBe(5);
		expect(await (await env.CDN_BUCKET.get(`_cdn/versions/${key}?${versions[0].id}`)).text()).toBe('v6');
	});

	test('a deleted file can be restored', async () => {
		const key = 'acme/site/prod/gone.txt';
		await put(key, 'still here');
		expect((await admin(`/admin/api/objects?key=${key}`, { method: 'DELETE' })).status).toBe(200);
		expect(await env.CDN_BUCKET.head(key)).toBeNull();

		const { versions } = await (await admin(`/admin/api/versions?key=${key}`)).json();
		expect(versions[0].reason).toBe('deleted');
		expect((await admin(`/admin/api/restore?key=${key}&version=${versions[0].id}`, { method: 'POST' })).status).toBe(200);
		expect(await (await env.CDN_BUCKET.get(key)).text()).toBe('still here');
	});

	test('one file never sees the versions of another whose name starts the same', async () => {
		await put('acme/a', 'short');
		await put('acme/a', 'short2', '&overwrite=true');
		await put('acme/a/b', 'long');
		await put('acme/a/b', 'long2', '&overwrite=true');
		expect((await (await admin('/admin/api/versions?key=acme/a')).json()).versions.length).toBe(1);
	});

	test('restore refuses a bad version, a missing one, a never-changing file and a cross-site request', async () => {
		const key = 'acme/site/prod/app.js';
		await put(key, 'one');
		await put(key, 'two', '&overwrite=true');
		const { versions } = await (await admin(`/admin/api/versions?key=${key}`)).json();
		const path = `/admin/api/restore?key=${key}&version=${versions[0].id}`;

		expect((await admin(`/admin/api/restore?key=${key}&version=../../x`, { method: 'POST' })).status).toBe(404);
		expect((await admin(`/admin/api/restore?key=${key}&version=0000000000000-00000000`, { method: 'POST' })).status).toBe(404);
		expect((await admin(path, { method: 'POST', headers: { Origin: 'https://evil.example' } })).status).toBe(403);
		expect((await admin(path, { method: 'POST', token: '' })).status).toBe(401);

		await env.CDN_BUCKET.put(key, 'pinned', { httpMetadata: { cacheControl: 'public, max-age=31536000, immutable' } });
		expect((await admin(path, { method: 'POST' })).status).toBe(409);
		expect(await (await env.CDN_BUCKET.get(key)).text()).toBe('pinned');
	});

	test('the activity log names who did what, newest first, for the panel and for tokens alike', async () => {
		await put('acme/site/prod/a.txt', 'a');
		await put('acme/site/prod/a.txt', 'aa', '&overwrite=true');
		await admin('/admin/api/move?from=acme/site/prod/a.txt&to=acme/site/prod/b.txt', { method: 'POST' });
		await SELF.fetch(`${ORIGIN}/api/objects?key=heard/x.js`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${env.UPLOAD_PASSWORD}` },
			body: 'x',
		});
		await admin('/admin/api/objects?key=acme/site/prod/b.txt', { method: 'DELETE' });

		const { events } = await (await admin('/admin/api/activity', { claims: { email: TEAMMATE } })).json();
		expect(events.map((event) => event.action)).toEqual(['delete', 'upload', 'move', 'replace', 'upload']);
		expect(events[0]).toMatchObject({ actor: `admin:${OWNER}`, key: 'acme/site/prod/b.txt' });
		expect(events[0].version).toMatch(/^\d{13}-[0-9a-f]{8}$/);
		expect(events[1]).toMatchObject({ actor: 'operator', key: 'heard/x.js', size: 1 });
		expect(events[2]).toMatchObject({ key: 'acme/site/prod/a.txt', to: 'acme/site/prod/b.txt' });
		expect(Date.parse(events[0].at)).toBeGreaterThan(Date.now() - 60000);
	});

	test('bookkeeping never shows up as files, in the panel or the Objects API', async () => {
		await put('acme/site/prod/a.txt', 'a');
		await put('acme/site/prod/a.txt', 'aa', '&overwrite=true');
		const files = await (await admin('/admin/api/files')).json();
		expect(files.objects.map((object) => object.key)).toEqual(['acme/site/prod/a.txt']);

		const listed = await SELF.fetch(`${ORIGIN}/api/objects/list`, { headers: { Authorization: `Bearer ${env.UPLOAD_PASSWORD}` } });
		expect((await listed.json()).objects.map((object) => object.key)).toEqual(['acme/site/prod/a.txt']);
		expect((await SELF.fetch(`${ORIGIN}/_cdn/activity/`)).status).not.toBe(200);
	});

	test('the nightly clean-up expires old copies and old history only', async () => {
		const { pruneHistory } = await import('../services/history.js');
		await put('acme/site/prod/a.txt', 'a');
		await put('acme/site/prod/a.txt', 'aa', '&overwrite=true');

		expect(await pruneHistory(env)).toEqual({ versions: 0, events: 0 });
		expect(await pruneHistory(env, Date.now() + 31 * 86400000)).toEqual({ versions: 1, events: 0 });
		expect(await pruneHistory(env, Date.now() + 181 * 86400000)).toEqual({ versions: 0, events: 2 });
		expect(await (await env.CDN_BUCKET.get('acme/site/prod/a.txt')).text()).toBe('aa');
	});
});

describe('admin app tokens', () => {
	const create = (body, options = {}) =>
		admin('/admin/api/tokens', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, ...options });
	const asToken = (token, path, init = {}) =>
		SELF.fetch(`${ORIGIN}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });

	test('an owner makes a token that works for its folder only, then revokes it', async () => {
		const response = await create({ app: 'Heard', prefixes: ['/heard/'], ops: ['put', 'get'] });
		expect(response.status).toBe(201);
		expect(response.headers.get('Cache-Control')).toBe('private, no-store');
		const made = await response.json();
		expect(made.token).toMatch(/^dxd_heard_[A-Za-z0-9_-]{32}$/);
		expect(made).toMatchObject({ app: 'heard', prefixes: ['heard/'], ops: ['put', 'get'] });

		expect((await asToken(made.token, '/api/objects?key=heard/a.js', { method: 'PUT', body: 'a' })).status).toBe(201);
		expect((await asToken(made.token, '/api/objects?key=other/a.js', { method: 'PUT', body: 'a' })).status).toBe(403);
		expect((await asToken(made.token, '/api/objects?key=heard/a.js', { method: 'DELETE' })).status).toBe(403);

		// Stored and listed by hash; the token itself is not kept anywhere.
		const stored = await (await env.CDN_BUCKET.get(`_cdn/tokens/${made.id}.json`)).text();
		expect(stored).not.toContain(made.token);
		const listing = await (await admin('/admin/api/tokens')).text();
		expect(listing).not.toContain(made.token);
		expect(JSON.parse(listing).tokens[0]).toMatchObject({ id: made.id, app: 'heard', source: 'panel', createdBy: OWNER });

		expect((await admin(`/admin/api/tokens?id=${made.id}`, { method: 'DELETE' })).status).toBe(200);
		expect((await asToken(made.token, '/api/objects?key=heard/b.js', { method: 'PUT', body: 'b' })).status).toBe(401);

		const { events } = await (await admin('/admin/api/activity')).json();
		expect(events.map((event) => event.action)).toEqual(['token-revoke', 'upload', 'token-create']);
		expect(events[1].actor).toBe('heard');
	});

	test('a token cannot be made for the whole bucket, a reserved folder or with nothing allowed', async () => {
		for (const body of [
			{ app: 'x', prefixes: ['*'], ops: ['put'] },
			{ app: 'x', prefixes: [''], ops: ['put'] },
			{ app: 'x', prefixes: ['_cdn/'], ops: ['get'] },
			{ app: 'x', prefixes: ['admin/'], ops: ['get'] },
			{ app: 'x', prefixes: ['a/../b'], ops: ['get'] },
			{ app: 'x', prefixes: [], ops: ['get'] },
			{ app: 'x', prefixes: ['a/'], ops: [] },
			{ app: 'x', prefixes: ['a/'], ops: ['admin'] },
			{ app: 'Bad Name!', prefixes: ['a/'], ops: ['get'] },
		]) {
			expect((await create(body)).status, JSON.stringify(body)).toBe(400);
		}
		expect((await admin('/admin/api/tokens', { method: 'POST', body: 'not json' })).status).toBe(400);
		expect((await env.CDN_BUCKET.list({ prefix: '_cdn/tokens/' })).objects.length).toBe(0);
	});

	test('teammates, signed-out requests and other sites cannot see, make or revoke tokens', async () => {
		const made = await (await create({ app: 'heard', prefixes: ['heard/'], ops: ['get'] })).json();
		const body = { app: 'sneaky', prefixes: ['heard/'], ops: ['put'] };

		expect((await admin('/admin/api/tokens', { claims: { email: TEAMMATE } })).status).toBe(403);
		expect((await create(body, { claims: { email: TEAMMATE } })).status).toBe(403);
		expect((await admin(`/admin/api/tokens?id=${made.id}`, { method: 'DELETE', claims: { email: TEAMMATE } })).status).toBe(403);
		expect((await create(body, { token: '' })).status).toBe(401);
		expect((await create(body, { headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' } })).status).toBe(403);
		expect((await admin(`/admin/api/tokens?id=${made.id}`, { method: 'DELETE', headers: { 'X-DXD-Admin': null } })).status).toBe(403);
		expect((await env.CDN_BUCKET.list({ prefix: '_cdn/tokens/' })).objects.length).toBe(1);
	});

	test('a token cannot write its own way into the token store', async () => {
		const made = await (await create({ app: 'heard', prefixes: ['heard/'], ops: ['put', 'get', 'list', 'delete'] })).json();
		const forged = JSON.stringify({ app: 'root', prefixes: ['*'], ops: ['put', 'get', 'list', 'delete'] });
		const key = `_cdn/tokens/${'a'.repeat(64)}.json`;
		for (const token of [made.token, env.UPLOAD_PASSWORD]) {
			const response = await asToken(token, `/api/objects?key=${key}`, { method: 'PUT', body: forged });
			expect(response.status).toBe(400);
		}
		expect(await env.CDN_BUCKET.head(key)).toBeNull();
	});

	test('tokens from the APP_TOKENS secret are listed read-only and cannot be revoked here', async () => {
		const digest = 'b'.repeat(64);
		env.APP_TOKENS = JSON.stringify({ [digest]: { app: 'studio', prefixes: ['studio/'], ops: ['get'] } });
		try {
			const { tokens } = await (await admin('/admin/api/tokens')).json();
			expect(tokens).toEqual([expect.objectContaining({ app: 'studio', source: 'config', id: digest })]);
			expect((await admin(`/admin/api/tokens?id=${digest}`, { method: 'DELETE' })).status).toBe(404);
			expect((await admin('/admin/api/tokens?id=nope', { method: 'DELETE' })).status).toBe(400);
		} finally {
			delete env.APP_TOKENS;
		}
	});
});

describe('admin traffic and clean-up', () => {
	const ZONE = 'c'.repeat(32);

	function mockAnalytics(reply) {
		const calls = [];
		const inner = globalThis.fetch.getMockImplementation();
		vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
			const target = typeof input === 'string' ? input : input.url;
			if (target === 'https://api.cloudflare.com/client/v4/graphql') {
				calls.push({ headers: new Headers(init.headers), query: JSON.parse(init.body).query });
				return Promise.resolve(typeof reply === 'function' ? reply() : Response.json(reply));
			}
			return inner(input, init);
		});
		return calls;
	}

	afterEach(() => {
		delete env.CF_ZONE_ID;
		delete env.CF_ANALYTICS_TOKEN;
	});

	test('without a zone and token, traffic reports itself as not connected', async () => {
		expect(await (await admin('/admin/api/traffic')).json()).toEqual({ connected: false });
		env.CF_ZONE_ID = 'not-a-zone';
		env.CF_ANALYTICS_TOKEN = 'secret-analytics-token';
		expect(await (await admin('/admin/api/traffic')).json()).toEqual({ connected: false });
	});

	test('traffic comes from Cloudflare analytics, and the token stays in the Worker', async () => {
		env.CF_ZONE_ID = ZONE;
		env.CF_ANALYTICS_TOKEN = 'secret-analytics-token';
		const hour = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString();
		const calls = mockAnalytics({
			data: {
				viewer: {
					zones: [
						{
							series: [{ count: 120, sum: { edgeResponseBytes: 5000 }, dimensions: { bucket: hour } }],
							paths: [
								{ count: 90, sum: { edgeResponseBytes: 4000 }, dimensions: { path: '/acme/site/prod/app.js' } },
								{ count: 30, sum: { edgeResponseBytes: 1000 }, dimensions: { path: '/admin/api/files' } },
							],
							cache: [
								{ count: 80, dimensions: { status: 'hit' } },
								{ count: 10, dimensions: { status: 'revalidated' } },
								{ count: 30, dimensions: { status: 'dynamic' } },
							],
							missing: [{ count: 7, dimensions: { path: '/acme/site/prod/typo.js' } }],
						},
					],
				},
			},
			errors: null,
		});

		const response = await admin('/admin/api/traffic?range=24h; drop', { claims: { email: TEAMMATE } });
		const text = await response.text();
		expect(text).not.toContain('secret-analytics-token');
		const traffic = JSON.parse(text);
		expect(traffic).toMatchObject({ connected: true, range: '24h', hourly: true, totals: { requests: 120, bytes: 5000, cached: 90 } });
		expect(traffic.series.length).toBe(24);
		expect(traffic.series.at(-1)).toEqual({ t: hour, requests: 120, bytes: 5000 });
		expect(traffic.top).toEqual([{ path: '/acme/site/prod/app.js', requests: 90, bytes: 4000 }]);
		expect(traffic.missing).toEqual([{ path: '/acme/site/prod/typo.js', requests: 7 }]);

		expect(calls.length).toBe(1);
		expect(calls[0].headers.get('Authorization')).toBe('Bearer secret-analytics-token');
		expect(calls[0].query).toContain(`zoneTag: "${ZONE}"`);
		expect(calls[0].query).toContain('clientRequestHTTPHost: "cdn.designxdevelop.com"');
		expect(calls[0].query).not.toContain('drop');
	});

	test('a refused analytics query is reported, not thrown', async () => {
		env.CF_ZONE_ID = ZONE;
		env.CF_ANALYTICS_TOKEN = 'secret-analytics-token';
		mockAnalytics({ data: null, errors: [{ message: 'not authorized for that account' }] });
		const response = await admin('/admin/api/traffic?range=7d');
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ connected: true, range: '7d', error: 'not authorized for that account' });
	});

	test('clean-up data is last-served times from the counters, plus requested paths when connected', async () => {
		await env.CDN_BUCKET.put('_cdn/analytics/acme/site/prod/app.js.json', '{"requestCount":3}');
		await env.CDN_BUCKET.put('analytics/acme/site/prod/old.js.json', '{"requestCount":1}');

		const plain = await (await admin('/admin/api/unused')).json();
		expect(Object.keys(plain.served).sort()).toEqual(['acme/site/prod/app.js', 'acme/site/prod/old.js']);
		expect(Date.parse(plain.served['acme/site/prod/app.js'])).toBeGreaterThan(Date.now() - 60000);
		expect(plain.edge).toBeNull();

		env.CF_ZONE_ID = ZONE;
		env.CF_ANALYTICS_TOKEN = 'secret-analytics-token';
		mockAnalytics({ data: { viewer: { zones: [{ paths: [{ count: 4, dimensions: { path: '/acme/site/prod/cached.css' } }] }] } } });
		const connected = await (await admin('/admin/api/unused')).json();
		expect(connected.edge).toEqual({ days: 30, paths: ['/acme/site/prod/cached.css'], complete: true });
	});
});
