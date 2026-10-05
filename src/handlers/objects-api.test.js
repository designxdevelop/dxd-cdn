import { SELF, createExecutionContext, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { CdnObjects } from '../services/cdn-objects.js';
import { sha256Hex } from '../services/scopes.js';

const OPERATOR = 'test-upload-password';
const HEARD_TOKEN = 'heard-token-for-tests';
const READONLY_TOKEN = 'readonly-token-for-tests';

let scopedEnv;

beforeEach(async () => {
	scopedEnv = {
		...env,
		APP_TOKENS: JSON.stringify({
			[await sha256Hex(HEARD_TOKEN)]: { app: 'heard', prefixes: ['heard/'], ops: ['put', 'get'] },
			[await sha256Hex(READONLY_TOKEN)]: { app: 'reader', prefixes: ['heard/'], ops: ['get'] },
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
});
