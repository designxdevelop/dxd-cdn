import { describe, expect, test } from 'vitest';
import { handleMp4Stream } from './streaming.js';

const object = {
	size: 100,
	httpEtag: '"abc"',
	uploaded: new Date('2026-01-01T00:00:00Z'),
	httpMetadata: { cacheControl: 'public, max-age=0, must-revalidate' },
};

function envThatMustNotGet() {
	return {
		CDN_BUCKET: {
			get: async () => {
				throw new Error('R2 get should not run when preconditions fail');
			},
		},
	};
}

describe('handleMp4Stream preconditions', () => {
	test('matching If-None-Match returns 304 even with Range', async () => {
		const request = new Request('https://cdn.designxdevelop.com/a.mp4', {
			headers: { Range: 'bytes=0-10', 'If-None-Match': '"abc"' },
		});
		const response = await handleMp4Stream(request, object, envThatMustNotGet(), 'a.mp4');
		expect(response.status).toBe(304);
	});

	test('If-Modified-Since not modified returns 304', async () => {
		const request = new Request('https://cdn.designxdevelop.com/a.mp4', {
			headers: { 'If-Modified-Since': 'Fri, 02 Jan 2026 00:00:00 GMT' },
		});
		const response = await handleMp4Stream(request, object, envThatMustNotGet(), 'a.mp4');
		expect(response.status).toBe(304);
	});

	test('If-Match mismatch returns 412 before Range', async () => {
		const request = new Request('https://cdn.designxdevelop.com/a.mp4', {
			headers: { Range: 'bytes=0-10', 'If-Match': '"other"' },
		});
		const response = await handleMp4Stream(request, object, envThatMustNotGet(), 'a.mp4');
		expect(response.status).toBe(412);
	});
});
