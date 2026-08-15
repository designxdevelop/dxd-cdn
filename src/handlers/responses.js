import { CONTENT_TYPES, IMMUTABLE_CACHE_CONTROL } from '../config/constants.js';
import { getFileFromGitHub } from '../services/github.js';
import { applyPublicCacheHeaders } from '../utils/cache.js';
import { compress } from '../utils/compression.js';

export async function handleR2Response(r2Object, extension, request) {
	try {
		const acceptHeader = request.headers.get('Accept') || '';
		const isScriptRequest =
			acceptHeader.includes('application/javascript') || acceptHeader.includes('text/javascript') || acceptHeader.includes('text/css');

		// Determine if it's a text file
		const isTextFile =
			extension in CONTENT_TYPES &&
			(CONTENT_TYPES[extension].includes('text') ||
				CONTENT_TYPES[extension].includes('javascript') ||
				CONTENT_TYPES[extension].includes('json'));

		// Check if file is already minified
		const isMinified = r2Object.key.includes('.min.');

		// Always get text content for text files
		let responseBody;
		if (isTextFile) {
			// Force text content for browser viewing
			responseBody = await r2Object.text();
		} else {
			responseBody = r2Object.body;
		}

		let headers = new Headers({
			'Content-Type': CONTENT_TYPES[extension] || 'text/plain; charset=utf-8',
			Vary: 'Accept-Encoding, Accept',
			'X-Content-Type-Options': 'nosniff',
			'Content-Disposition': 'inline',
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Expose-Headers': 'Content-Length, Content-Type, ETag',
		});
		applyPublicCacheHeaders(headers, r2Object, r2Object.key, IMMUTABLE_CACHE_CONTROL);

		// Only compress for script/link tags that accept gzip and aren't already minified
		if (isScriptRequest && !isMinified && request.headers.get('Accept-Encoding')?.includes('gzip')) {
			try {
				const compressedContent = await compress(responseBody, 'gzip');
				if (compressedContent) {
					responseBody = compressedContent;
					headers.set('Content-Encoding', 'gzip');
				}
			} catch (error) {
				// Continue without compression on error
			}
		}

		return new Response(responseBody, { headers });
	} catch (error) {
		throw error; // Re-throw to maintain original error handling
	}
}

export async function handleGitHubResponse(repo, version, filePath, env, ctx, shouldMinify, request) {
	try {
		const content = await getFileFromGitHub(repo, version, filePath, env, ctx, shouldMinify);
		const extension = filePath.split('.').pop().toLowerCase();
		const isMinified = filePath.includes('.min.');

		// Determine if it's a text file
		const isTextFile =
			extension in CONTENT_TYPES &&
			(CONTENT_TYPES[extension].includes('text') ||
				CONTENT_TYPES[extension].includes('javascript') ||
				CONTENT_TYPES[extension].includes('json'));

		const headers = new Headers({
			'Content-Type': CONTENT_TYPES[extension] || 'text/plain; charset=utf-8',
			'X-Served-From': 'GitHub',
			'Cache-Control': IMMUTABLE_CACHE_CONTROL,
			'CDN-Cache-Control': IMMUTABLE_CACHE_CONTROL,
			'Cloudflare-CDN-Cache-Control': IMMUTABLE_CACHE_CONTROL,
			'Access-Control-Allow-Origin': '*',
		});

		// Only compress for script/link tags that accept gzip and aren't already minified
		const acceptHeader = request.headers.get('Accept') || '';
		const isScriptRequest =
			acceptHeader.includes('application/javascript') || acceptHeader.includes('text/javascript') || acceptHeader.includes('text/css');

		let responseBody = content;
		if (isScriptRequest && !isMinified && request.headers.get('Accept-Encoding')?.includes('gzip')) {
			try {
				const compressedContent = await compress(content, 'gzip');
				if (compressedContent) {
					responseBody = compressedContent;
					headers.set('Content-Encoding', 'gzip');
				}
			} catch (error) {
				// Continue without compression on error
			}
		}

		return new Response(responseBody, { headers });
	} catch (error) {
		throw error; // Re-throw to maintain original error handling
	}
}
