import { describe, expect, it } from 'vitest';
import { IMMUTABLE_CACHE_CONTROL, MUTABLE_CACHE_CONTROL } from '../config/constants.js';
import { loadObjectMeta, normalizeObjectKey, objectErrorStatus, resolveCacheControl, storeObject } from '../services/objects.js';

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

	it('stores an explicit immutable policy', async () => {
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
			key: 'heard/hp/prod/personalization.abc123.js',
			body: 'console.log(1)',
			cacheControl: IMMUTABLE_CACHE_CONTROL,
		});

		expect(result.ok).toBe(true);
		expect(result.cacheControl).toBe(IMMUTABLE_CACHE_CONTROL);
		expect(puts[0].opts.httpMetadata.cacheControl).toBe(IMMUTABLE_CACHE_CONTROL);
	});

	it('rejects Cache-Control values outside the allowlist', async () => {
		const env = {
			CDN_BUCKET: {
				put: async () => {
					throw new Error('put should not be called');
				},
			},
		};
		const rejected = await storeObject(env, {
			key: 'heard/hp/prod/personalization.js',
			body: 'console.log(1)',
			cacheControl: 'public, max-age=60',
		});
		expect(rejected).toEqual({
			ok: false,
			code: 'INVALID_CACHE_CONTROL',
			key: 'heard/hp/prod/personalization.js',
		});
		expect(objectErrorStatus('INVALID_CACHE_CONTROL')).toBe(400);
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

describe('resolveCacheControl', () => {
	it('defaults empty values to mutable revalidation', () => {
		expect(resolveCacheControl(undefined)).toEqual({ ok: true, cacheControl: MUTABLE_CACHE_CONTROL });
		expect(resolveCacheControl('')).toEqual({ ok: true, cacheControl: MUTABLE_CACHE_CONTROL });
		expect(resolveCacheControl('  ')).toEqual({ ok: true, cacheControl: MUTABLE_CACHE_CONTROL });
	});

	it('accepts only the two known policies', () => {
		expect(resolveCacheControl(MUTABLE_CACHE_CONTROL)).toEqual({ ok: true, cacheControl: MUTABLE_CACHE_CONTROL });
		expect(resolveCacheControl(IMMUTABLE_CACHE_CONTROL)).toEqual({
			ok: true,
			cacheControl: IMMUTABLE_CACHE_CONTROL,
		});
		expect(resolveCacheControl('no-store')).toEqual({ ok: false, code: 'INVALID_CACHE_CONTROL' });
		expect(resolveCacheControl(` ${IMMUTABLE_CACHE_CONTROL} `)).toEqual({
			ok: true,
			cacheControl: IMMUTABLE_CACHE_CONTROL,
		});
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
