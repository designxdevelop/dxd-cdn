import { describe, expect, test } from 'vitest';
import { EDGE_MUTABLE_CACHE_CONTROL, IMMUTABLE_CACHE_CONTROL, MUTABLE_CACHE_CONTROL } from '../config/constants.js';
import {
	applyPublicCacheHeaders,
	cacheHeadersForObject,
	cacheTagForKey,
	encodedPathFallback,
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

	test('defaults live URLs to browser revalidation with a short edge TTL', () => {
		expect(cacheHeadersForObject(undefined)).toEqual({
			'Cache-Control': MUTABLE_CACHE_CONTROL,
			'Cloudflare-CDN-Cache-Control': EDGE_MUTABLE_CACHE_CONTROL,
			'CDN-Cache-Control': EDGE_MUTABLE_CACHE_CONTROL,
		});
		expect(MUTABLE_CACHE_CONTROL).toBe('public, max-age=0, must-revalidate');
	});

	test('honors an explicit mutable Cache-Control on the object', () => {
		const stored = 'public, max-age=60, must-revalidate';
		expect(cacheHeadersForObject(stored)['Cache-Control']).toBe(stored);
		expect(cacheHeadersForObject(stored)['Cloudflare-CDN-Cache-Control']).toBe(EDGE_MUTABLE_CACHE_CONTROL);
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

	test('returns null when the ETag does not match', () => {
		const request = new Request('https://cdn.designxdevelop.com/file.js', {
			headers: { 'If-None-Match': '"old"' },
		});
		expect(notModifiedResponse(request, '"new"', new Headers())).toBeNull();
	});
});

describe('encodedPathFallback', () => {
	test('returns the raw path when it differs from the decoded path', () => {
		const request = new Request('https://cdn.designxdevelop.com/heard/My%20File.js');
		expect(encodedPathFallback(request, 'heard/My File.js')).toBe('heard/My%20File.js');
		expect(encodedPathFallback(request, 'heard/My%20File.js')).toBeNull();
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
		expect(headers.get('Last-Modified')).toBe('Thu, 01 Jan 2026 00:00:00 GMT');
	});
});
