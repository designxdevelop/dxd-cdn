import { SELF, createExecutionContext, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { CdnObjects } from '../services/cdn-objects.js';
import { sha256Hex } from '../services/scopes.js';

const OPERATOR = 'test-upload-password';
const HEARD_TOKEN = 'heard-token-for-tests';
const READONLY_TOKEN = 'readonly-token-for-tests';
const MANAGER_TOKEN = 'manager-token-for-tests';
const MULTI_TOKEN = 'multi-prefix-token-for-tests';

let scopedEnv;

beforeEach(async () => {
	scopedEnv = {
		...env,
		APP_TOKENS: JSON.stringify({
			[await sha256Hex(HEARD_TOKEN)]: { app: 'heard', prefixes: ['heard/'], ops: ['put', 'get'] },
			[await sha256Hex(READONLY_TOKEN)]: { app: 'reader', prefixes: ['heard/'], ops: ['get'] },
			[await sha256Hex(MANAGER_TOKEN)]: { app: 'manager', prefixes: ['heard/'], ops: ['put', 'get', 'list', 'delete'] },
			[await sha256Hex(MULTI_TOKEN)]: { app: 'multi', prefixes: ['heard/', 'acme/'], ops: ['list'] },
		}),
	};
	env.APP_TOKENS = scopedEnv.APP_TOKENS;
	await emptyBucket();
});

afterEach(async () => {
	delete env.APP_TOKENS;
	await emptyBucket();
});

async function emptyBucket() {
	let cursor;
	do {
		const page = await env.CDN_BUCKET.list({ cursor });
		for (const object of page.objects) {
			await env.CDN_BUCKET.delete(object.key);
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
}

function putObject(token, key, body = 'x') {
	return SELF.fetch('https://cdn.designxdevelop.com/api/objects', {
		method: 'PUT',
		headers: {
			Authorization: `Bearer ${token}`,
			'X-DXD-Object-Key': key,
			'Content-Type': 'application/javascript',
		},
		body,
	});
}

function getMeta(token, key) {
	return SELF.fetch(`https://cdn.designxdevelop.com/api/objects?key=${encodeURIComponent(key)}&as=meta`, {
		headers: { Authorization: `Bearer ${token}` },
	});
}

describe('PUT /api/objects token scopes', () => {
	test('the operator token writes anywhere', async () => {
		expect((await putObject(OPERATOR, 'heard/hp/prod/a.js')).status).toBe(201);
		expect((await putObject(OPERATOR, 'acme/site/prod/b.js')).status).toBe(201);
	});

	test('an app token writes inside its prefix', async () => {
		const response = await putObject(HEARD_TOKEN, 'heard/hp/prod/personalization.js');
		expect(response.status).toBe(201);
		expect(await env.CDN_BUCKET.head('heard/hp/prod/personalization.js')).not.toBeNull();
	});

	test('an app token cannot write outside its prefix', async () => {
		const response = await putObject(HEARD_TOKEN, 'acme/site/prod/notes.txt');
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ error: 'Key is outside this token scope' });
		expect(await env.CDN_BUCKET.head('acme/site/prod/notes.txt')).toBeNull();
	});

	test('a sibling prefix is not a substring loophole', async () => {
		const response = await putObject(HEARD_TOKEN, 'heard-staging/hp/prod/a.js');
		expect(response.status).toBe(403);
	});

	test('a token without the put op cannot write inside its own prefix', async () => {
		const response = await putObject(READONLY_TOKEN, 'heard/hp/prod/a.js');
		expect(response.status).toBe(403);
	});

	test('an unknown token is unauthorized, not forbidden', async () => {
		const response = await putObject('not-a-real-token', 'heard/hp/prod/a.js');
		expect(response.status).toBe(401);
	});

	test('the JSON envelope is scoped the same way', async () => {
		const response = await SELF.fetch('https://cdn.designxdevelop.com/api/objects', {
			method: 'PUT',
			headers: { Authorization: `Bearer ${HEARD_TOKEN}`, 'X-DXD-Json-Envelope': 'true' },
			body: JSON.stringify({ key: 'acme/site/prod/a.json', body: '{}' }),
		});
		expect(response.status).toBe(403);
	});

	test('?password= carries an app token too', async () => {
		const response = await SELF.fetch(`https://cdn.designxdevelop.com/api/objects?password=${HEARD_TOKEN}`, {
			method: 'PUT',
			headers: { 'X-DXD-Object-Key': 'heard/hp/prod/via-query.js' },
			body: 'x',
		});
		expect(response.status).toBe(201);
	});
});

describe('GET /api/objects token scopes', () => {
	test('an app token reads inside its prefix and not outside', async () => {
		await putObject(OPERATOR, 'heard/hp/prod/a.js', 'inside');
		await putObject(OPERATOR, 'acme/site/prod/b.js', 'outside');

		expect((await getMeta(HEARD_TOKEN, 'heard/hp/prod/a.js')).status).toBe(200);
		expect((await getMeta(HEARD_TOKEN, 'acme/site/prod/b.js')).status).toBe(403);
	});

	test('an out-of-scope key returns 403 whether or not the object exists', async () => {
		expect((await getMeta(HEARD_TOKEN, 'acme/site/prod/missing.js')).status).toBe(403);
	});

	test('as=body is scoped too', async () => {
		await putObject(OPERATOR, 'acme/site/prod/b.js', 'outside');
		const response = await SELF.fetch('https://cdn.designxdevelop.com/api/objects?key=acme/site/prod/b.js&as=body', {
			headers: { Authorization: `Bearer ${HEARD_TOKEN}` },
		});
		expect(response.status).toBe(403);
	});

	test('a scoped token cannot reach the operator-only routes', async () => {
		const response = await SELF.fetch(`https://cdn.designxdevelop.com/api/files?password=${HEARD_TOKEN}`);
		expect(response.status).toBe(401);
	});
});

describe('HEAD /api/objects', () => {
	test('reports metadata in headers with no body', async () => {
		await putObject(OPERATOR, 'heard/hp/prod/a.js', 'console.log(1)');

		const response = await SELF.fetch('https://cdn.designxdevelop.com/api/objects?key=heard/hp/prod/a.js', {
			method: 'HEAD',
			headers: { Authorization: `Bearer ${HEARD_TOKEN}` },
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('');
		expect(response.headers.get('ETag')).toBeTruthy();
		expect(response.headers.get('Last-Modified')).toBeTruthy();
		expect(response.headers.get('X-DXD-Object-Key')).toBe('heard/hp/prod/a.js');
		expect(response.headers.get('X-DXD-Object-Size')).toBe('14');
		expect(response.headers.get('X-DXD-Cache-Control')).toBe('public, max-age=0, must-revalidate');
	});

	test('404 for a missing key, 403 out of scope, 401 unknown token', async () => {
		const head = (token, key) =>
			SELF.fetch(`https://cdn.designxdevelop.com/api/objects?key=${key}`, {
				method: 'HEAD',
				headers: { Authorization: `Bearer ${token}` },
			});

		expect((await head(HEARD_TOKEN, 'heard/hp/prod/absent.js')).status).toBe(404);
		expect((await head(HEARD_TOKEN, 'acme/site/prod/a.js')).status).toBe(403);
		expect((await head('nope', 'heard/hp/prod/a.js')).status).toBe(401);
	});
});

describe('DELETE /api/objects', () => {
	const del = (token, key) =>
		SELF.fetch(`https://cdn.designxdevelop.com/api/objects?key=${key}`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${token}` },
		});

	test('a token with the delete op removes its own object', async () => {
		await putObject(OPERATOR, 'heard/hp/prod/a.js');

		const response = await del(MANAGER_TOKEN, 'heard/hp/prod/a.js');
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ok: true, key: 'heard/hp/prod/a.js' });
		expect(await env.CDN_BUCKET.head('heard/hp/prod/a.js')).toBeNull();
	});

	test('a token without the delete op cannot delete inside its own prefix', async () => {
		await putObject(OPERATOR, 'heard/hp/prod/a.js');

		expect((await del(HEARD_TOKEN, 'heard/hp/prod/a.js')).status).toBe(403);
		expect(await env.CDN_BUCKET.head('heard/hp/prod/a.js')).not.toBeNull();
	});

	test('a token cannot delete outside its prefix', async () => {
		await putObject(OPERATOR, 'acme/site/prod/a.js');

		expect((await del(MANAGER_TOKEN, 'acme/site/prod/a.js')).status).toBe(403);
		expect(await env.CDN_BUCKET.head('acme/site/prod/a.js')).not.toBeNull();
	});

	test('deleting a missing key is 404', async () => {
		expect((await del(MANAGER_TOKEN, 'heard/hp/prod/absent.js')).status).toBe(404);
	});

	test('an unsupported method on /api/objects is 405 with Allow', async () => {
		const response = await SELF.fetch('https://cdn.designxdevelop.com/api/objects', {
			method: 'PATCH',
			headers: { Authorization: `Bearer ${OPERATOR}` },
		});
		expect(response.status).toBe(405);
		expect(response.headers.get('Allow')).toBe('GET, HEAD, PUT, DELETE');
	});
});

describe('GET /api/objects/list', () => {
	const list = (token, query = '') =>
		SELF.fetch(`https://cdn.designxdevelop.com/api/objects/list${query}`, {
			headers: { Authorization: `Bearer ${token}` },
		});

	beforeEach(async () => {
		for (const key of ['heard/hp/prod/a.js', 'heard/hp/prod/b.js', 'heard/other/c.js', 'acme/site/prod/d.js']) {
			await putObject(OPERATOR, key);
		}
	});

	test('a single-prefix token lists its own prefix without naming it', async () => {
		const page = await (await list(MANAGER_TOKEN)).json();
		expect(page.prefix).toBe('heard/');
		expect(page.objects.map((object) => object.key).sort()).toEqual(['heard/hp/prod/a.js', 'heard/hp/prod/b.js', 'heard/other/c.js']);
		expect(page.truncated).toBe(false);
		expect(page.cursor).toBeNull();
	});

	test('a narrower prefix inside scope is allowed, a prefix outside it is not', async () => {
		const inside = await (await list(MANAGER_TOKEN, '?prefix=heard/hp/')).json();
		expect(inside.objects).toHaveLength(2);

		expect((await list(MANAGER_TOKEN, '?prefix=acme/')).status).toBe(403);
	});

	test('a multi-prefix token must name which prefix it means', async () => {
		expect((await list(MULTI_TOKEN)).status).toBe(403);
		expect((await list(MULTI_TOKEN, '?prefix=acme/')).status).toBe(200);
	});

	test('a token without the list op cannot list', async () => {
		expect((await list(HEARD_TOKEN, '?prefix=heard/')).status).toBe(403);
	});

	test('the operator token lists the whole bucket', async () => {
		const page = await (await list(OPERATOR)).json();
		expect(page.prefix).toBe('');
		expect(page.objects.length).toBe(4);
	});

	test('limit and cursor page through results without losing keys', async () => {
		const seen = [];
		let query = '?prefix=heard/&limit=1';
		let pages = 0;

		while (pages < 10) {
			const page = await (await list(OPERATOR, query)).json();
			expect(page.objects.length).toBeLessThanOrEqual(1);
			seen.push(...page.objects.map((object) => object.key));
			pages++;
			if (!page.truncated) break;
			expect(page.cursor).toBeTruthy();
			query = `?prefix=heard/&limit=1&cursor=${encodeURIComponent(page.cursor)}`;
		}

		expect(pages).toBe(3);
		expect(seen.sort()).toEqual(['heard/hp/prod/a.js', 'heard/hp/prod/b.js', 'heard/other/c.js']);
	});

	test('a delimiter returns folder prefixes instead of every key', async () => {
		const page = await (await list(OPERATOR, '?prefix=heard/&delimiter=/')).json();
		expect(page.prefixes).toEqual(['heard/hp/', 'heard/other/']);
		expect(page.objects).toHaveLength(0);
	});

	test('objects carry the metadata an app needs to decide on a republish', async () => {
		const page = await (await list(MANAGER_TOKEN, '?prefix=heard/hp/prod/a.js')).json();
		expect(page.objects[0]).toMatchObject({
			key: 'heard/hp/prod/a.js',
			cacheControl: 'public, max-age=0, must-revalidate',
			contentType: 'application/javascript',
		});
		expect(page.objects[0].etag).toBeTruthy();
		expect(typeof page.objects[0].size).toBe('number');
		expect(Date.parse(page.objects[0].uploaded)).toBeGreaterThan(0);
	});

	test('an unknown token is 401', async () => {
		expect((await list('nope')).status).toBe(401);
	});
});

describe('public GET is unaffected by token scopes', () => {
	test('anyone can read any object over the public path', async () => {
		await putObject(HEARD_TOKEN, 'heard/hp/prod/personalization.js', 'embed');
		const response = await SELF.fetch('https://cdn.designxdevelop.com/heard/hp/prod/personalization.js');
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('embed');
	});
});

describe('CdnObjects RPC shares the scope rules', () => {
	test('the default entrypoint keeps full operator access', async () => {
		const cdn = new CdnObjects(createExecutionContext(), scopedEnv);
		const stored = await cdn.putObject({ key: 'acme/site/prod/rpc.json', body: '{}' });
		expect(stored.ok).toBe(true);
		expect(await cdn.getObjectMeta('acme/site/prod/rpc.json')).toMatchObject({ key: 'acme/site/prod/rpc.json' });
	});

	test('scope(token) narrows writes to that token prefix', async () => {
		const cdn = new CdnObjects(createExecutionContext(), scopedEnv);
		const heard = await cdn.scope(HEARD_TOKEN);

		expect(heard.scope).toEqual({ app: 'heard', prefixes: ['heard/'], ops: ['put', 'get'] });
		await expect(heard.putObject({ key: 'heard/hp/prod/rpc.json', body: '{}' })).resolves.toMatchObject({ ok: true });
		await expect(heard.putObject({ key: 'acme/site/prod/rpc.json', body: '{}' })).rejects.toThrow(/outside this token scope/);
	});

	test('scope(token) narrows reads the same way', async () => {
		const cdn = new CdnObjects(createExecutionContext(), scopedEnv);
		await cdn.putObject({ key: 'acme/site/prod/rpc.json', body: '{}' });

		const heard = await cdn.scope(HEARD_TOKEN);
		await expect(heard.getObjectMeta('acme/site/prod/rpc.json')).rejects.toThrow(/outside this token scope/);
		expect(await heard.getObjectMeta('heard/hp/prod/absent.json')).toBeNull();
	});

	test('an unknown token cannot be scoped', async () => {
		const cdn = new CdnObjects(createExecutionContext(), scopedEnv);
		await expect(cdn.scope('nope')).rejects.toThrow(/Unknown app token/);
	});

	test('delete and list are scoped the same way as put and get', async () => {
		const cdn = new CdnObjects(createExecutionContext(), scopedEnv);
		await cdn.putObject({ key: 'heard/hp/prod/rpc.json', body: '{}' });
		await cdn.putObject({ key: 'acme/site/prod/rpc.json', body: '{}' });

		const manager = await cdn.scope(MANAGER_TOKEN);
		const page = await manager.listObjects();
		expect(page.objects.map((object) => object.key)).toEqual(['heard/hp/prod/rpc.json']);

		expect(await manager.deleteObject('heard/hp/prod/rpc.json')).toBe(true);
		expect(await manager.deleteObject('heard/hp/prod/rpc.json')).toBe(false);
		await expect(manager.deleteObject('acme/site/prod/rpc.json')).rejects.toThrow(/outside this token scope/);
	});

	test('the operator entrypoint can delete and list anywhere', async () => {
		const cdn = new CdnObjects(createExecutionContext(), scopedEnv);
		await cdn.putObject({ key: 'acme/site/prod/rpc.json', body: '{}' });

		expect((await cdn.listObjects({ prefix: 'acme/' })).objects).toHaveLength(1);
		expect(await cdn.deleteObject('acme/site/prod/rpc.json')).toBe(true);
	});
});
