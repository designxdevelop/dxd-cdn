/**
 * Media streaming handlers for DXD CDN
 * Handles range requests for MP4 video streaming
 */

import { CONTENT_TYPES } from '../config/constants.js';
import { trackFileRequest } from '../utils/files.js';

/**
 * Handle MP4 streaming with range request support
 * @param {Request} request - Incoming request
 * @param {R2Object} object - R2 object
 * @param {Object} env - Environment bindings
 * @param {string} path - File path
 * @returns {Promise<Response>} Streaming response
 */
export async function handleMp4Stream(request, object, env, path) {
	const headers = new Headers({
		'Content-Type': CONTENT_TYPES.mp4,
		'Accept-Ranges': 'bytes',
		'Cache-Control': 'public, max-age=31536000',
		ETag: object.httpEtag,
		'Last-Modified': object.uploaded.toUTCString(),
		'Access-Control-Allow-Origin': '*',
	});

	// Handle range requests
	if (request.headers.has('range')) {
		try {
			const range = request.headers.get('range');
			const size = object.size;
			const match = /bytes=(\d*)-(\d*)/.exec(range);

			if (!match) {
				return new Response('Invalid Range Header', {
					status: 400,
					headers: {
						'Accept-Ranges': 'bytes',
						'Content-Range': `bytes */${size}`,
					},
				});
			}

			let start = match[1] ? parseInt(match[1], 10) : 0;
			let end = match[2] ? parseInt(match[2], 10) : size - 1;

			// Handle open-ended ranges (e.g., bytes=0-)
			// Limit to 1MB chunks for efficient streaming
			if (match[1] && !match[2]) {
				end = Math.min(start + 1024 * 1024 - 1, size - 1);
			}

			// Validate ranges
			if (start < 0 || start >= size || end >= size || start > end) {
				return new Response('Requested Range Not Satisfiable', {
					status: 416,
					headers: {
						'Content-Range': `bytes */${size}`,
						'Accept-Ranges': 'bytes',
					},
				});
			}

			const length = end - start + 1;
			const ranged = await env.CDN_BUCKET.get(path, { range: { offset: start, length } });

			if (!ranged || !ranged.body) {
				return new Response('Requested Range Not Satisfiable', {
					status: 416,
					headers: {
						'Accept-Ranges': 'bytes',
						'Content-Range': `bytes */${size}`,
					},
				});
			}

			headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
			headers.set('Content-Length', String(length));

			// Track file request (non-blocking)
			trackFileRequest(env.CDN_BUCKET, path).catch((err) => {
				console.error('Error tracking file request:', err);
			});

			return new Response(ranged.body, {
				status: 206,
				headers,
			});
		} catch (error) {
			console.error('Range request error:', error);
			// Fall back to sending the full file
			headers.set('Content-Length', object.size.toString());

			// Track file request for fallback (non-blocking)
			trackFileRequest(env.CDN_BUCKET, path).catch((err) => {
				console.error('Error tracking file request:', err);
			});

			return new Response(object.body, {
				headers,
			});
		}
	}

	// No range request - return full file
	headers.set('Content-Length', object.size.toString());

	// Track file request (non-blocking)
	trackFileRequest(env.CDN_BUCKET, path).catch((err) => {
		console.error('Error tracking file request:', err);
	});

	return new Response(object.body, {
		headers,
	});
}
