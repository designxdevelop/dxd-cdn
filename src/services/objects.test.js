import { describe, expect, it } from 'vitest';
import { MUTABLE_CACHE_CONTROL } from '../config/constants.js';
import { loadObjectMeta, normalizeObjectKey, storeObject } from '../services/objects.js';

describe('normalizeObjectKey', () => {
	it('rejects traversal and api/ prefixes', () => {
		expect(normalizeObjectKey('../secret')).toBeNull();
		expect(normalizeObjectKey('api/objects')).toBeNull();
		expect(normalizeObjectKey('/heard/hp/prod/a.js')).toBe('heard/hp/prod/a.js');
	});
});

describe('storeObject', () => {
	it('defaults Cache-Control to mutable revalidation', async () => {
		const puts = [];
		const env = {
			PUBLIC_ORIGIN: 'https://cdn.designxdevelop.com',
			CDN_BUCKET: {
				put: async (key, _body, opts) => {
					puts.push({ key, opts });
				},
			},
		};

		const result = await storeObject(env, {
			key: 'heard/hp/prod/personalization.js',
			body: 'console.log(1)',
			contentType: 'application/javascript',
		});

		expect(result).toMatchObject({
			ok: true,
			key: 'heard/hp/prod/personalization.js',
			url: 'https://cdn.designxdevelop.com/heard/hp/prod/personalization.js',
			cacheControl: MUTABLE_CACHE_CONTROL,
		});
		expect(puts[0].opts.httpMetadata.cacheControl).toBe(MUTABLE_CACHE_CONTROL);
	});

	it('returns EXISTS when overwrite is false and the key exists', async () => {
		const env = {
			CDN_BUCKET: {
				head: async () => ({ key: 'x' }),
			},
		};
		const result = await storeObject(env, { key: 'x', body: 'y', overwrite: false });
		expect(result).toEqual({ ok: false, code: 'EXISTS', key: 'x' });
	});
});

describe('loadObjectMeta', () => {
	it('uses head instead of downloading the body', async () => {
		const env = {
			PUBLIC_ORIGIN: 'https://cdn.designxdevelop.com',
			CDN_BUCKET: {
				head: async () => ({
					size: 12,
					httpEtag: '"etag"',
					uploaded: new Date('2026-01-01T00:00:00Z'),
					httpMetadata: { contentType: 'text/plain', cacheControl: MUTABLE_CACHE_CONTROL },
				}),
				get: async () => {
					throw new Error('get should not be called');
				},
			},
		};

		const result = await loadObjectMeta(env, 'heard/a.txt');
		expect(result).toMatchObject({
			ok: true,
			key: 'heard/a.txt',
			size: 12,
			etag: '"etag"',
			cacheControl: MUTABLE_CACHE_CONTROL,
		});
	});
});
