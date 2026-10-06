import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { IMMUTABLE_CACHE_CONTROL, MUTABLE_CACHE_CONTROL } from './config/constants.js';

async function put(key, body, cacheControl = MUTABLE_CACHE_CONTROL, contentType = 'application/javascript; charset=utf-8') {
	await env.CDN_BUCKET.put(key, body, { httpMetadata: { contentType, cacheControl } });
}

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

beforeEach(emptyBucket);
afterEach(emptyBucket);

describe('version-shaped object keys', () => {
	test('a key whose second segment looks like a version is served from R2 with its stored policy', async () => {
		await put('myapp/v1.2.3/bundle.js', 'first');

		const first = await SELF.fetch('https://cdn.designxdevelop.com/myapp/v1.2.3/bundle.js');
		expect(first.status).toBe(200);
		expect(await first.text()).toBe('first');
		expect(first.headers.get('Cache-Control')).toBe(MUTABLE_CACHE_CONTROL);
		expect(first.headers.get('CDN-Cache-Control')).toBe(MUTABLE_CACHE_CONTROL);
	});

	test('republishing a version-shaped key serves the new bytes immediately', async () => {
		await put('myapp/v1.2.3/bundle.js', 'first');
		await SELF.fetch('https://cdn.designxdevelop.com/myapp/v1.2.3/bundle.js');

		await put('myapp/v1.2.3/bundle.js', 'second');
		const republished = await SELF.fetch('https://cdn.designxdevelop.com/myapp/v1.2.3/bundle.js');

		expect(await republished.text()).toBe('second');
	});

	test('commit-hash and latest shaped segments are object keys too', async () => {
		await put('myapp/a1b2c3d/bundle.js', 'hash');
		await put('myapp/latest/bundle.js', 'latest');

		const hashed = await SELF.fetch('https://cdn.designxdevelop.com/myapp/a1b2c3d/bundle.js');
		const latest = await SELF.fetch('https://cdn.designxdevelop.com/myapp/latest/bundle.js');

		expect(await hashed.text()).toBe('hash');
		expect(await latest.text()).toBe('latest');
		expect(hashed.headers.get('Cache-Control')).toBe(MUTABLE_CACHE_CONTROL);
		expect(latest.headers.get('Cache-Control')).toBe(MUTABLE_CACHE_CONTROL);
	});

	test('an immutable snapshot under a version-shaped prefix keeps its own policy', async () => {
		await put('myapp/v1.2.3/bundle.abc123.js', 'snapshot', IMMUTABLE_CACHE_CONTROL);

		const response = await SELF.fetch('https://cdn.designxdevelop.com/myapp/v1.2.3/bundle.abc123.js');
		expect(response.headers.get('Cache-Control')).toBe(IMMUTABLE_CACHE_CONTROL);
	});
});

describe('public object serving', () => {
	test('serves ETag and answers If-None-Match with 304', async () => {
		await put('acme/site/prod/config.json', '{"a":1}', MUTABLE_CACHE_CONTROL, 'application/json; charset=utf-8');

		const first = await SELF.fetch('https://cdn.designxdevelop.com/acme/site/prod/config.json');
		const etag = first.headers.get('ETag');
		expect(etag).toBeTruthy();

		const second = await SELF.fetch('https://cdn.designxdevelop.com/acme/site/prod/config.json', {
			headers: { 'If-None-Match': etag },
		});
		expect(second.status).toBe(304);
	});

	test('tags the response with the client prefix and the individual key', async () => {
		await put('acme/site/prod/config.json', '{}');
		const response = await SELF.fetch('https://cdn.designxdevelop.com/acme/site/prod/config.json');
		expect(response.headers.get('Cache-Tag')).toBe('dxd-cdn:acme,dxd-cdn-key:acme%2Fsite%2Fprod%2Fconfig.json');
	});

	test('live objects get no edge copy at LIVE_EDGE_MAX_AGE = 0', async () => {
		await put('acme/site/prod/config.json', '{}');
		const response = await SELF.fetch('https://cdn.designxdevelop.com/acme/site/prod/config.json');
		expect(response.headers.get('Cache-Control')).toBe(MUTABLE_CACHE_CONTROL);
		expect(response.headers.get('CDN-Cache-Control')).toBe(MUTABLE_CACHE_CONTROL);
	});

	test('raising LIVE_EDGE_MAX_AGE gives Cloudflare a copy but never the browser', async () => {
		await put('acme/site/prod/config.json', '{}');
		env.LIVE_EDGE_MAX_AGE = 3600;
		try {
			const response = await SELF.fetch('https://cdn.designxdevelop.com/acme/site/prod/config.json');
			expect(response.headers.get('Cache-Control')).toBe(MUTABLE_CACHE_CONTROL);
			expect(response.headers.get('CDN-Cache-Control')).toBe('public, max-age=3600');
			expect(response.headers.get('Cloudflare-CDN-Cache-Control')).toBe('public, max-age=3600');
		} finally {
			delete env.LIVE_EDGE_MAX_AGE;
		}
	});

	test('an immutable snapshot is unaffected by LIVE_EDGE_MAX_AGE', async () => {
		await put('acme/site/prod/app.abc123.js', 'snap', IMMUTABLE_CACHE_CONTROL);
		env.LIVE_EDGE_MAX_AGE = 3600;
		try {
			const response = await SELF.fetch('https://cdn.designxdevelop.com/acme/site/prod/app.abc123.js');
			expect(response.headers.get('Cache-Control')).toBe(IMMUTABLE_CACHE_CONTROL);
			expect(response.headers.get('CDN-Cache-Control')).toBe(IMMUTABLE_CACHE_CONTROL);
		} finally {
			delete env.LIVE_EDGE_MAX_AGE;
		}
	});

	test('a missing object is a 404 that cannot be cached over a later upload', async () => {
		const response = await SELF.fetch('https://cdn.designxdevelop.com/acme/site/prod/nope.json');
		expect(response.status).toBe(404);
		expect(response.headers.get('Cache-Control')).toBe('no-store');
	});

	test('HEAD is allowed', async () => {
		await put('acme/site/prod/config.json', '{}');
		const response = await SELF.fetch('https://cdn.designxdevelop.com/acme/site/prod/config.json', { method: 'HEAD' });
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('');
	});

	test('write methods on a public object path are rejected, not answered with the body', async () => {
		await put('acme/site/prod/config.json', '{}');

		for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
			const response = await SELF.fetch('https://cdn.designxdevelop.com/acme/site/prod/config.json', { method });
			expect(response.status, method).toBe(405);
			expect(response.headers.get('Allow'), method).toBe('GET, HEAD');
			expect(response.headers.get('Cache-Control'), method).toBe('no-store');
		}

		expect(await env.CDN_BUCKET.head('acme/site/prod/config.json')).not.toBeNull();
	});
});

describe('request analytics', () => {
	// The counter write runs in ctx.waitUntil, so it lands shortly after the
	// response rather than before it. Exact arithmetic is covered in
	// utils/files.test.js; here the question is only whether it lands at all.
	async function settledCount(key) {
		for (let attempt = 0; attempt < 50; attempt++) {
			const stats = await env.CDN_BUCKET.get(`_cdn/analytics/${key}.json`);
			if (stats) return JSON.parse(await stats.text());
			await scheduler.wait(10);
		}
		return null;
	}

	test('a public GET is recorded, where before the write was cancelled and the count stayed zero', async () => {
		await put('acme/site/prod/counted.js', 'x');
		await SELF.fetch('https://cdn.designxdevelop.com/acme/site/prod/counted.js');

		const stats = await settledCount('acme/site/prod/counted.js');
		expect(stats).not.toBeNull();
		expect(stats.requestCount).toBeGreaterThanOrEqual(1);
		expect(stats.firstServed).toBeTruthy();
		expect(stats.lastServed).toBeTruthy();
	});

	test('/api/file-stats reports what was counted', async () => {
		await put('acme/site/prod/counted.js', 'x');
		await SELF.fetch('https://cdn.designxdevelop.com/acme/site/prod/counted.js');
		await settledCount('acme/site/prod/counted.js');

		const response = await SELF.fetch(
			`https://cdn.designxdevelop.com/api/file-stats?password=${env.UPLOAD_PASSWORD}&file=acme/site/prod/counted.js`,
		);
		expect((await response.json()).requestCount).toBeGreaterThanOrEqual(1);
	});

	test('counters recorded at the old analytics location are carried forward', async () => {
		await put('acme/site/prod/legacy.js', 'x');
		await env.CDN_BUCKET.put(
			'analytics/acme/site/prod/legacy.js.json',
			JSON.stringify({ requestCount: 41, firstServed: '2026-01-01T00:00:00.000Z', lastServed: '2026-01-01T00:00:00.000Z' }),
		);

		await SELF.fetch('https://cdn.designxdevelop.com/acme/site/prod/legacy.js');

		const stats = await settledCount('acme/site/prod/legacy.js');
		expect(stats.requestCount).toBe(42);
		expect(stats.firstServed).toBe('2026-01-01T00:00:00.000Z');
	});

	test('a 304 revalidation is not counted as a fresh serve', async () => {
		await put('acme/site/prod/counted.js', 'x');
		const first = await SELF.fetch('https://cdn.designxdevelop.com/acme/site/prod/counted.js');
		await settledCount('acme/site/prod/counted.js');

		const revalidated = await SELF.fetch('https://cdn.designxdevelop.com/acme/site/prod/counted.js', {
			headers: { 'If-None-Match': first.headers.get('ETag') },
		});
		expect(revalidated.status).toBe(304);

		expect((await settledCount('acme/site/prod/counted.js')).requestCount).toBe(1);
	});
});

describe('the platform key space is not tenant territory', () => {
	test('the public path will not serve a reserved key', async () => {
		await env.CDN_BUCKET.put('_cdn/analytics/acme/a.js.json', '{"requestCount":999999}');
		await env.CDN_BUCKET.put('analytics/acme/a.js.json', '{"requestCount":999999}');

		expect((await SELF.fetch('https://cdn.designxdevelop.com/_cdn/analytics/acme/a.js.json')).status).toBe(404);
		expect((await SELF.fetch('https://cdn.designxdevelop.com/analytics/acme/a.js.json')).status).toBe(404);
	});

	test('a reserved key cannot be written through the Objects API', async () => {
		for (const key of ['_cdn/analytics/acme/a.js.json', 'analytics/acme/a.js.json', 'api/objects']) {
			const response = await SELF.fetch('https://cdn.designxdevelop.com/api/objects', {
				method: 'PUT',
				headers: { Authorization: `Bearer ${env.UPLOAD_PASSWORD}`, 'X-DXD-Object-Key': key },
				body: '{"requestCount":999999}',
			});
			expect(response.status, key).toBe(400);
			expect(await env.CDN_BUCKET.head(key), key).toBeNull();
		}
	});

	test('reserved keys are hidden from the operator listing', async () => {
		await put('acme/site/prod/a.js', 'x');
		await env.CDN_BUCKET.put('_cdn/analytics/acme/site/prod/a.js.json', '{}');

		const response = await SELF.fetch(`https://cdn.designxdevelop.com/api/files?password=${env.UPLOAD_PASSWORD}`);
		const body = await response.json();
		expect(body.files).toEqual(['acme/site/prod/a.js']);
	});
});

describe('POST /upload key handling', () => {
	async function upload(path, filename, body = 'hello') {
		const form = new FormData();
		form.set('password', env.UPLOAD_PASSWORD);
		form.set('path', path);
		form.set('file', new File([body], filename, { type: 'text/plain' }));
		return SELF.fetch('https://cdn.designxdevelop.com/upload', { method: 'POST', body: form });
	}

	test('a normal path stores the object where it says', async () => {
		const response = await upload('acme/site/prod', 'notes.txt');
		expect(response.status).toBe(200);
		expect(await env.CDN_BUCKET.head('acme/site/prod/notes.txt')).not.toBeNull();
	});

	test('traversal in the path is rejected instead of becoming a literal key', async () => {
		const response = await upload('../../escaped', 'u.txt');

		expect(response.status).toBe(400);
		expect(await response.text()).toContain('not a valid path');

		const listed = await env.CDN_BUCKET.list();
		expect(listed.objects.map((object) => object.key)).toEqual([]);
	});

	test('uploading into the reserved key space is rejected', async () => {
		expect((await upload('_cdn/analytics/acme', 'forged.json')).status).toBe(400);
		expect((await upload('analytics/acme', 'forged.json')).status).toBe(400);
	});
});

describe('operator and tool pages are never cached', () => {
	test.each([
		['/browse', 'GET'],
		['/upload', 'GET'],
		['/convert', 'GET'],
		['/speed-test', 'GET'],
	])('%s says no-store', async (path, method) => {
		const response = await SELF.fetch(`https://cdn.designxdevelop.com${path}`, { method });
		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('private, no-store');
	});

	test('the browse page with a valid password is still no-store', async () => {
		const response = await SELF.fetch(`https://cdn.designxdevelop.com/browse?password=${env.UPLOAD_PASSWORD}`);
		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('private, no-store');
		expect(await response.text()).toContain(env.UPLOAD_PASSWORD);
	});
});

describe('GitHub proxy prefix', () => {
	test('/gh/ serves a matching R2 mirror as an immutable version snapshot', async () => {
		await put('my-project/v1.0.0/dist/script.js', 'mirrored');

		const response = await SELF.fetch('https://cdn.designxdevelop.com/gh/my-project/v1.0.0/dist/script.js');
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('mirrored');
		expect(response.headers.get('Cache-Control')).toBe(IMMUTABLE_CACHE_CONTROL);
	});

	test('/gh/ without repo/version/file is a 400', async () => {
		const response = await SELF.fetch('https://cdn.designxdevelop.com/gh/my-project/v1.0.0');
		expect(response.status).toBe(400);
	});

	test('a legacy version-shaped path redirects to /gh/ only when R2 has no such object', async () => {
		const response = await SELF.fetch('https://cdn.designxdevelop.com/my-project/v1.0.0/dist/script.js', {
			redirect: 'manual',
		});
		expect(response.status).toBe(301);
		expect(response.headers.get('Location')).toBe('https://cdn.designxdevelop.com/gh/my-project/v1.0.0/dist/script.js');
		expect(response.headers.get('Cache-Control')).toBe('no-store');
	});

	test('a legacy redirect keeps the query string', async () => {
		const response = await SELF.fetch('https://cdn.designxdevelop.com/my-project/latest/dist/script.min.js?precache=1', {
			redirect: 'manual',
		});
		expect(response.headers.get('Location')).toBe('https://cdn.designxdevelop.com/gh/my-project/latest/dist/script.min.js?precache=1');
	});

	test('a miss that is not version-shaped stays a 404', async () => {
		const response = await SELF.fetch('https://cdn.designxdevelop.com/acme/site/prod/missing.js', { redirect: 'manual' });
		expect(response.status).toBe(404);
	});
});
