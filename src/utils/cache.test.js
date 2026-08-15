import { describe, expect, test } from 'vitest';
import { IMMUTABLE_CACHE_CONTROL, MUTABLE_CACHE_CONTROL } from '../config/constants.js';
import {
	applyPublicCacheHeaders,
	cacheHeadersForObject,
	cacheTagForKey,
	etagMatches,
	getPreconditionStatus,
	isImmutableCacheControl,
	notModifiedResponse,
} from './cache.js';

describe('isImmutableCacheControl', () => {
	test('detects the immutable directive', () => {
		expect(isImmutableCacheControl(IMMUTABLE_CACHE_CONTROL)).toBe(true);
		expect(isImmutableCacheControl(MUTABLE_CACHE_CONTROL)).toBe(false);
		expect(isImmutableCacheControl(undefined)).toBe(false);
	});
});

describe('cacheTagForKey', () => {
	test('uses the client prefix', () => {
		expect(cacheTagForKey('heard/hp/prod/personalization.js')).toBe('dxd-cdn:heard');
		expect(cacheTagForKey('/dxd-studio/platform.js')).toBe('dxd-cdn:dxd-studio');
		expect(cacheTagForKey('')).toBe('dxd-cdn');
	});
});

describe('cacheHeadersForObject', () => {
	test('keeps hashed assets immutable in the browser and at the edge', () => {
		expect(cacheHeadersForObject(IMMUTABLE_CACHE_CONTROL)).toEqual({
			'Cache-Control': IMMUTABLE_CACHE_CONTROL,
			'Cloudflare-CDN-Cache-Control': IMMUTABLE_CACHE_CONTROL,
			'CDN-Cache-Control': IMMUTABLE_CACHE_CONTROL,
		});
	});

	test('uses the same revalidate policy for browsers and the edge', () => {
		expect(cacheHeadersForObject(undefined)).toEqual({
			'Cache-Control': MUTABLE_CACHE_CONTROL,
			'Cloudflare-CDN-Cache-Control': MUTABLE_CACHE_CONTROL,
			'CDN-Cache-Control': MUTABLE_CACHE_CONTROL,
		});
		expect(MUTABLE_CACHE_CONTROL).toBe('public, max-age=0, must-revalidate');
	});

	test('honors an explicit Cache-Control on the object for all cache headers', () => {
		const stored = 'public, max-age=60, must-revalidate';
		expect(cacheHeadersForObject(stored)).toEqual({
			'Cache-Control': stored,
			'Cloudflare-CDN-Cache-Control': stored,
			'CDN-Cache-Control': stored,
		});
	});
});

describe('etagMatches', () => {
	test('matches weak and strong tags', () => {
		expect(etagMatches('"abc"', '"abc"')).toBe(true);
		expect(etagMatches('W/"abc"', '"abc"')).toBe(true);
		expect(etagMatches('"abc"', 'W/"abc"')).toBe(true);
		expect(etagMatches('"old"', '"new"')).toBe(false);
		expect(etagMatches('*', '"abc"')).toBe(true);
	});
});

describe('getPreconditionStatus', () => {
	const object = { httpEtag: '"abc"', uploaded: new Date('2026-01-01T00:00:00Z') };

	test('If-Modified-Since not modified is 304', () => {
		const request = new Request('https://cdn.designxdevelop.com/a.js', {
			headers: { 'If-Modified-Since': 'Fri, 02 Jan 2026 00:00:00 GMT' },
		});
		expect(getPreconditionStatus(request, object)).toBe(304);
	});

	test('If-Match mismatch is 412', () => {
		const request = new Request('https://cdn.designxdevelop.com/a.js', {
			headers: { 'If-Match': '"other"' },
		});
		expect(getPreconditionStatus(request, object)).toBe(412);
	});

	test('If-None-Match takes precedence over If-Modified-Since', () => {
		const request = new Request('https://cdn.designxdevelop.com/a.js', {
			headers: {
				'If-None-Match': '"old"',
				'If-Modified-Since': 'Fri, 02 Jan 2026 00:00:00 GMT',
			},
		});
		expect(getPreconditionStatus(request, object)).toBeNull();
	});
});

describe('notModifiedResponse', () => {
	test('returns 304 when If-None-Match matches', () => {
		const headers = new Headers({ ETag: '"abc"' });
		const request = new Request('https://cdn.designxdevelop.com/file.js', {
			headers: { 'If-None-Match': '"abc"' },
		});
		const response = notModifiedResponse(request, '"abc"', headers);
		expect(response?.status).toBe(304);
	});

	test('returns 304 for a weak If-None-Match', () => {
		const request = new Request('https://cdn.designxdevelop.com/file.js', {
			headers: { 'If-None-Match': 'W/"abc"' },
		});
		expect(notModifiedResponse(request, '"abc"', new Headers())?.status).toBe(304);
	});

	test('returns null when the ETag does not match', () => {
		const request = new Request('https://cdn.designxdevelop.com/file.js', {
			headers: { 'If-None-Match': '"old"' },
		});
		expect(notModifiedResponse(request, '"new"', new Headers())).toBeNull();
	});
});

describe('applyPublicCacheHeaders', () => {
	test('sets ETag, Last-Modified, and Cache-Tag', () => {
		const headers = new Headers();
		applyPublicCacheHeaders(
			headers,
			{
				httpEtag: '"etag"',
				httpMetadata: { cacheControl: MUTABLE_CACHE_CONTROL },
				uploaded: new Date('2026-01-01T00:00:00Z'),
			},
			'heard/hp/prod/personalization.js',
		);
		expect(headers.get('ETag')).toBe('"etag"');
		expect(headers.get('Cache-Tag')).toBe('dxd-cdn:heard');
		expect(headers.get('Cache-Control')).toBe(MUTABLE_CACHE_CONTROL);
		expect(headers.get('Cloudflare-CDN-Cache-Control')).toBe(MUTABLE_CACHE_CONTROL);
		expect(headers.get('Last-Modified')).toBe('Thu, 01 Jan 2026 00:00:00 GMT');
	});
});
