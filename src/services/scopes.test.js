import { describe, expect, test } from 'vitest';
import {
	ALL_PREFIXES,
	OPERATOR_SCOPE,
	keyInPrefix,
	presentedToken,
	resolveScope,
	scopeAllows,
	scopeForToken,
	sha256Hex,
} from './scopes.js';

const HEARD_TOKEN = 'heard-app-token';
const STUDIO_TOKEN = 'studio-app-token';

async function envWithTokens(extra = {}) {
	return {
		UPLOAD_PASSWORD: 'operator-secret',
		APP_TOKENS: JSON.stringify({
			[await sha256Hex(HEARD_TOKEN)]: { app: 'heard', prefixes: ['heard/'], ops: ['put', 'get'] },
			[await sha256Hex(STUDIO_TOKEN)]: { app: 'studio', prefixes: ['dxd-studio/'], ops: ['put', 'get', 'list', 'delete'] },
		}),
		...extra,
	};
}

function requestWith(headers = {}, search = '') {
	const url = new URL(`https://cdn.designxdevelop.com/api/objects${search}`);
	return { request: new Request(url, { headers }), url };
}

describe('presentedToken', () => {
	test('reads Bearer and ?password=', () => {
		const bearer = requestWith({ Authorization: 'Bearer abc' });
		expect(presentedToken(bearer.request, bearer.url)).toBe('abc');

		const query = requestWith({}, '?password=xyz');
		expect(presentedToken(query.request, query.url)).toBe('xyz');

		const neither = requestWith();
		expect(presentedToken(neither.request, neither.url)).toBe('');
	});
});

describe('scopeForToken', () => {
	test('UPLOAD_PASSWORD is the operator token', async () => {
		expect(await scopeForToken(await envWithTokens(), 'operator-secret')).toEqual(OPERATOR_SCOPE);
	});

	test('an app token resolves to its own prefixes and ops', async () => {
		expect(await scopeForToken(await envWithTokens(), HEARD_TOKEN)).toEqual({
			app: 'heard',
			prefixes: ['heard/'],
			ops: ['put', 'get'],
		});
	});

	test('unknown, empty, and hash-shaped tokens resolve to nothing', async () => {
		const env = await envWithTokens();
		expect(await scopeForToken(env, 'nope')).toBeNull();
		expect(await scopeForToken(env, '')).toBeNull();
		expect(await scopeForToken(env, await sha256Hex(HEARD_TOKEN))).toBeNull();
	});

	test('a malformed APP_TOKENS secret disables app tokens without disabling the operator token', async () => {
		const env = { UPLOAD_PASSWORD: 'operator-secret', APP_TOKENS: 'not json' };
		expect(await scopeForToken(env, HEARD_TOKEN)).toBeNull();
		expect(await scopeForToken(env, 'operator-secret')).toEqual(OPERATOR_SCOPE);
	});

	test('entries missing an app, prefixes, or ops are ignored', async () => {
		const env = {
			APP_TOKENS: JSON.stringify({
				[await sha256Hex('a')]: { prefixes: ['a/'], ops: ['put'] },
				[await sha256Hex('b')]: { app: 'b', prefixes: [], ops: ['put'] },
				[await sha256Hex('c')]: { app: 'c', prefixes: ['c/'], ops: ['teleport'] },
			}),
		};
		expect(await scopeForToken(env, 'a')).toBeNull();
		expect(await scopeForToken(env, 'b')).toBeNull();
		expect(await scopeForToken(env, 'c')).toBeNull();
	});

	test('with no UPLOAD_PASSWORD set, app tokens still work', async () => {
		const env = {
			APP_TOKENS: JSON.stringify({ [await sha256Hex(HEARD_TOKEN)]: { app: 'heard', prefixes: ['heard/'], ops: ['put'] } }),
		};
		expect(await scopeForToken(env, HEARD_TOKEN)).toMatchObject({ app: 'heard' });
		expect(await scopeForToken(env, '')).toBeNull();
	});
});

describe('resolveScope', () => {
	test('accepts the token from either transport', async () => {
		const env = await envWithTokens();
		const bearer = requestWith({ Authorization: `Bearer ${HEARD_TOKEN}` });
		const query = requestWith({}, `?password=${HEARD_TOKEN}`);

		expect(await resolveScope(bearer.request, bearer.url, env)).toMatchObject({ app: 'heard' });
		expect(await resolveScope(query.request, query.url, env)).toMatchObject({ app: 'heard' });
	});
});

describe('keyInPrefix', () => {
	test('treats prefixes as path-segment boundaries', () => {
		expect(keyInPrefix('heard/hp/prod/a.js', 'heard/')).toBe(true);
		expect(keyInPrefix('heard/hp/prod/a.js', 'heard')).toBe(true);
		expect(keyInPrefix('heard-staging/hp/a.js', 'heard')).toBe(false);
		expect(keyInPrefix('heardsomething/a.js', 'heard/')).toBe(false);
	});

	test('an exact key is a valid single-object prefix', () => {
		expect(keyInPrefix('dxd-studio/platform.js', 'dxd-studio/platform.js')).toBe(true);
		expect(keyInPrefix('dxd-studio/other.js', 'dxd-studio/platform.js')).toBe(false);
	});

	test(`${ALL_PREFIXES} covers the bucket`, () => {
		expect(keyInPrefix('anything/at/all.js', ALL_PREFIXES)).toBe(true);
	});
});

describe('scopeAllows', () => {
	const heard = { app: 'heard', prefixes: ['heard/'], ops: ['put', 'get'] };

	test('requires both the op and the prefix', () => {
		expect(scopeAllows(heard, 'put', 'heard/hp/prod/a.js')).toBe(true);
		expect(scopeAllows(heard, 'delete', 'heard/hp/prod/a.js')).toBe(false);
		expect(scopeAllows(heard, 'put', 'acme/site/prod/a.js')).toBe(false);
	});

	test('the operator scope allows everything', () => {
		for (const op of OPERATOR_SCOPE.ops) {
			expect(scopeAllows(OPERATOR_SCOPE, op, 'any/key.js')).toBe(true);
		}
	});

	test('a missing or malformed scope allows nothing', () => {
		expect(scopeAllows(null, 'get', 'heard/a.js')).toBe(false);
		expect(scopeAllows(undefined, 'get', 'heard/a.js')).toBe(false);
		expect(scopeAllows({ app: 'x' }, 'get', 'heard/a.js')).toBe(false);
		expect(scopeAllows({ app: 'x', prefixes: '*', ops: ['get'] }, 'get', 'heard/a.js')).toBe(false);
	});

	test('a multi-prefix scope matches any of its prefixes', () => {
		const shared = { app: 'shared', prefixes: ['a/', 'b/'], ops: ['get'] };
		expect(scopeAllows(shared, 'get', 'a/one.js')).toBe(true);
		expect(scopeAllows(shared, 'get', 'b/two.js')).toBe(true);
		expect(scopeAllows(shared, 'get', 'c/three.js')).toBe(false);
	});
});
