/**
 * DXD CDN - Cloudflare Worker
 *
 * A hybrid CDN that supports:
 * 1. File upload and browsing (marketing-cdn features)
 * 2. GitHub proxy with versioning and minification, under /gh/
 * 3. Direct R2 file serving for uploaded assets
 */

import { CONTENT_TYPES, IMMUTABLE_CACHE_CONTROL, MUTABLE_CACHE_CONTROL, PREVIEW_TYPES } from './config/constants.js';
import { handleFilesApi, handleFileStatsApi, handleFileContentApi, handleDeleteFileApi } from './handlers/api.js';
import { handleBrowseGet, handleBrowsePost } from './handlers/browse.js';
import { handlePutObjectApi, handleGetObjectApi } from './handlers/objects-api.js';
import { handleR2Response, handleGitHubResponse } from './handlers/responses.js';
import { handleMp4Stream } from './handlers/streaming.js';
import { handleUploadGet, handleUploadPost } from './handlers/upload.js';
import { PUBLIC_READ_METHODS, isGitHubProxyPath, legacyGitHubProxyPathname, parseGitHubProxyPath } from './routing.js';
import { CdnObjects } from './services/cdn-objects.js';
import { getLatestRelease } from './services/github.js';
import { handleSpecialPages } from './templates/pages.js';
import { applyPublicCacheHeaders, cacheHeadersForObject, notModifiedResponse } from './utils/cache.js';
import { handleCorsPreflightRequest, getCorsHeaders, jsonApiHeaders } from './utils/cors.js';
import { trackFileRequest } from './utils/files.js';
import { failedOnlyIfStatus, getR2Object, hasR2Body, headR2Object } from './utils/r2.js';

export { CdnObjects };

export default {
	async fetch(request, env, ctx) {
		try {
			const url = new URL(request.url);
			const path = url.pathname.slice(1); // Remove leading slash

			// Handle CORS preflight requests
			if (request.method === 'OPTIONS') {
				return handleCorsPreflightRequest();
			}

			// Handle favicon requests
			if (path === 'favicon.ico') {
				return new Response(null, { status: 204 });
			}

			// ========== NEW ROUTES (Marketing CDN Features) ==========

			// Handle upload route
			if (url.pathname === '/upload') {
				if (request.method === 'GET') {
					return handleUploadGet();
				}
				if (request.method === 'POST') {
					return handleUploadPost(request, env, url);
				}
				return new Response('Method Not Allowed', { status: 405 });
			}

			// Handle browse route
			if (url.pathname === '/browse') {
				if (request.method === 'GET') {
					return handleBrowseGet(url, env);
				}
				if (request.method === 'POST') {
					return handleBrowsePost(request, env, url);
				}
				return new Response('Method Not Allowed', { status: 405 });
			}

			// Handle API routes
			if (url.pathname === '/api/files' && request.method === 'GET') {
				return handleFilesApi(url, env);
			}

			if (url.pathname === '/api/file-stats' && request.method === 'GET') {
				return handleFileStatsApi(url, env);
			}

			if (url.pathname === '/api/file-content' && request.method === 'GET') {
				return handleFileContentApi(url, env);
			}

			if (url.pathname === '/api/delete-file' && request.method === 'DELETE') {
				return handleDeleteFileApi(url, env);
			}

			if (url.pathname === '/api/objects' && request.method === 'PUT') {
				return handlePutObjectApi(request, env, url);
			}

			if (url.pathname === '/api/objects' && request.method === 'GET') {
				return handleGetObjectApi(request, env, url);
			}

			// ========== EXISTING ROUTES ==========

			// Handle special pages (speed-test, convert)
			if (path === 'speed-test' || path === 'convert') {
				return handleSpecialPages(path);
			}

			// Handle root URL
			if (!path) {
				return new Response('DXD CDN is running', {
					status: 200,
					headers: {
						'Content-Type': 'text/plain',
						'Cache-Control': 'public, max-age=3600',
						...getCorsHeaders(),
					},
				});
			}

			// ========== FILE SERVING LOGIC ==========
			// /gh/:repo/:version/:file is the GitHub proxy. Everything else is an R2
			// object key, so stored Cache-Control always wins on the public path.

			if (!PUBLIC_READ_METHODS.includes(request.method)) {
				return methodNotAllowed();
			}

			if (isGitHubProxyPath(path)) {
				const proxy = parseGitHubProxyPath(path);
				if (!proxy) {
					return new Response('Invalid path format. Use: /gh/repo/version/file-path', { status: 400 });
				}
				return handleGitHubProxyRequest(request, env, ctx, proxy);
			}

			return handleDirectR2Request(request, env, ctx, url, path);
		} catch (error) {
			console.error('CDN Error:', {
				error: error.message,
				stack: error.stack,
				url: request.url,
				method: request.method,
				path: new URL(request.url).pathname,
			});

			return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
				status: 500,
				headers: jsonApiHeaders(),
			});
		}
	},
};

/**
 * Handle GitHub proxy requests (legacy functionality)
 * URL format: /gh/:repo/:version/:file
 */
async function handleGitHubProxyRequest(request, env, ctx, proxy) {
	const { repo, version } = proxy;
	let filePath = proxy.filePath;
	let response = null;

	// Check if .min version is requested
	const shouldMinify = filePath.endsWith('.min.js') || filePath.endsWith('.min.css');
	if (shouldMinify) {
		filePath = filePath.replace('.min', '');
	}

	const extension = filePath.split('.').pop().toLowerCase();

	try {
		// First try R2 bucket with exact path
		const r2Path = `${repo}/${version}/${filePath}${shouldMinify ? '.min' : ''}`;
		let r2Object = await env.CDN_BUCKET.get(r2Path);

		// If version is 'latest', also check R2 for the actual version
		if (!r2Object && version === 'latest') {
			const release = await getLatestRelease(repo, env);
			const latestVersion = release.tag_name;
			const latestPath = `${repo}/${latestVersion}/${filePath}${shouldMinify ? '.min' : ''}`;
			r2Object = await env.CDN_BUCKET.get(latestPath);
		}

		if (r2Object) {
			response = await handleR2Response(r2Object, extension, request);
		} else {
			response = await handleGitHubResponse(repo, version, filePath, env, ctx, shouldMinify, request);
		}

		const headers = new Headers(response.headers);
		const cacheControl = version === 'latest' ? MUTABLE_CACHE_CONTROL : IMMUTABLE_CACHE_CONTROL;
		for (const [name, value] of Object.entries(cacheHeadersForObject(cacheControl))) {
			headers.set(name, value);
		}
		headers.set('Access-Control-Allow-Origin', '*');
		headers.set('CF-Cache-Status', r2Object ? 'R2_HIT' : 'R2_MISS');

		// Prefer object ETag; fall back to synthetic
		if (!headers.get('ETag')) {
			headers.set('ETag', `"${repo}-${version}-${filePath}"`);
		}

		// Create final response
		response = new Response(response.body, {
			headers,
			status: response.status,
			statusText: response.statusText,
		});

		return response;
	} catch (error) {
		console.error('File fetch error:', {
			error: error.message,
			stack: error.stack,
			repo,
			version,
			filePath,
			extension,
			shouldMinify,
		});
		return new Response(`File not found: ${error.message}`, { status: 404 });
	}
}

/**
 * Handle direct R2 file requests (uploaded files)
 * URL format: /:client/:project/:env/:file or any direct path
 */
async function handleDirectR2Request(request, env, ctx, url, path) {
	const forceDownload = url.searchParams.get('download') === 'true';
	const extensionHint = path.split('.').pop().toLowerCase();

	if (extensionHint === 'mp4') {
		const found = await headR2Object(env.CDN_BUCKET, request, path);
		if (!found.object) {
			return objectNotFound(url, path);
		}
		return handleMp4Stream(request, found.object, env, found.key);
	}

	const found = await getR2Object(env.CDN_BUCKET, request, path);
	if (!found.object) {
		return objectNotFound(url, path);
	}

	const { object, key } = found;
	const extension = key.split('.').pop().toLowerCase();
	const contentType = CONTENT_TYPES[extension] || object.httpMetadata?.contentType || 'application/octet-stream';

	const headers = new Headers({
		'Content-Type': contentType,
		'Access-Control-Allow-Origin': '*',
	});
	applyPublicCacheHeaders(headers, object, key);

	if (forceDownload) {
		headers.set('Content-Disposition', `attachment; filename="${key.split('/').pop()}"`);
	} else if (PREVIEW_TYPES.has(extension)) {
		headers.set('Content-Disposition', 'inline');
	}

	if (!hasR2Body(object)) {
		return new Response(null, { status: failedOnlyIfStatus(request), headers });
	}

	const notModified = notModifiedResponse(request, object.httpEtag, headers);
	if (notModified) return notModified;

	trackFileRequest(env.CDN_BUCKET, key).catch((err) => {
		console.error('Error tracking file request:', err);
	});

	return new Response(object.body, { headers });
}

/**
 * No object at this key. Pre-`/gh/` GitHub URLs are redirected rather than
 * proxied so an object at the same key always wins.
 * @param {URL} url
 * @param {string} path
 * @returns {Response}
 */
function objectNotFound(url, path) {
	const legacyPathname = legacyGitHubProxyPathname(path);
	if (legacyPathname) {
		const target = new URL(url);
		target.pathname = legacyPathname;
		return new Response(null, {
			status: 301,
			headers: {
				Location: target.toString(),
				// Not cached, so storing an object at this key takes effect immediately.
				'Cache-Control': 'no-store',
				...getCorsHeaders(),
			},
		});
	}
	return new Response('File not found', { status: 404 });
}

/**
 * @returns {Response}
 */
function methodNotAllowed() {
	return new Response('Method Not Allowed', {
		status: 405,
		headers: { Allow: PUBLIC_READ_METHODS.join(', ') },
	});
}
