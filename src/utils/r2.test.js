import { describe, expect, test } from 'vitest';
import { getR2Object, hasR2Body, r2GetOptions, r2KeyCandidates } from './r2.js';

describe('r2KeyCandidates', () => {
	test('includes the decoded path and the percent-encoded URL path', () => {
		const request = new Request('https://cdn.designxdevelop.com/heard/My%20File.js');
		expect(r2KeyCandidates(request, 'heard/My File.js')).toEqual(['heard/My File.js', 'heard/My%20File.js']);
	});

	test('does not duplicate when the path is already encoded', () => {
		const request = new Request('https://cdn.designxdevelop.com/heard/file.js');
		expect(r2KeyCandidates(request, 'heard/file.js')).toEqual(['heard/file.js']);
	});
});

describe('r2GetOptions', () => {
	test('passes If-None-Match through as onlyIf', () => {
		const request = new Request('https://cdn.designxdevelop.com/a.js', {
			headers: { 'If-None-Match': '"abc"' },
		});
		const options = r2GetOptions(request);
		expect(options.onlyIf?.get('If-None-Match')).toBe('"abc"');
	});

	test('omits onlyIf when there are no preconditions', () => {
		const request = new Request('https://cdn.designxdevelop.com/a.js');
		expect(r2GetOptions(request)).toEqual({});
	});
});

describe('getR2Object', () => {
	test('returns metadata without a body when If-None-Match matches', async () => {
		const bucket = {
			get: async (_key, options) => {
				if (options?.onlyIf?.get('If-None-Match') === '"abc"') {
					return { httpEtag: '"abc"', httpMetadata: {} };
				}
				return { httpEtag: '"abc"', body: new ReadableStream(), httpMetadata: {} };
			},
		};
		const request = new Request('https://cdn.designxdevelop.com/a.js', {
			headers: { 'If-None-Match': '"abc"' },
		});
		const found = await getR2Object(bucket, request, 'a.js');
		expect(hasR2Body(found.object)).toBe(false);
		expect(found.object?.httpEtag).toBe('"abc"');
	});
});
