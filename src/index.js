/**
 * DXD CDN - Cloudflare Worker
 *
 * A hybrid CDN that supports:
 * 1. File upload and browsing (marketing-cdn features)
 * 2. GitHub proxy with versioning and minification
 * 3. Direct R2 file serving for uploaded assets
 */

import { handleR2Response, handleGitHubResponse } from './handlers/responses.js';
import { getLatestRelease } from './services/github.js';
import { handleSpecialPages } from './templates/pages.js';
import { CONTENT_TYPES, PREVIEW_TYPES } from './config/constants.js';
import { handleUploadGet, handleUploadPost } from './handlers/upload.js';
import { handleBrowseGet, handleBrowsePost } from './handlers/browse.js';
import { handleFilesApi, handleFileStatsApi, handleFileContentApi, handleDeleteFileApi } from './handlers/api.js';
import { handlePutObjectApi, handleGetObjectApi } from './handlers/objects-api.js';
import { handleMp4Stream } from './handlers/streaming.js';
import { handleCorsPreflightRequest, getCorsHeaders } from './utils/cors.js';
import { trackFileRequest } from './utils/files.js';

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
			// Determine if this is a direct R2 file or a GitHub proxy request
			// GitHub proxy format: /:repo/:version/:file (where version looks like v1.0.0, latest, or a commit hash)
			// Direct R2 format: /:client/:project/:env/:file or any other path

			const pathParts = path.split('/');

			// Check if this looks like a GitHub proxy request
			// GitHub version patterns: 'latest', 'v1.2.3', commit hashes (7+ hex chars)
			const isGitHubVersionPattern = (str) => {
				if (str === 'latest') return true;
				if (/^v?\d+\.\d+(\.\d+)?(-[a-zA-Z0-9.]+)?$/.test(str)) return true; // semver
				if (/^[a-f0-9]{7,40}$/.test(str)) return true; // commit hash
				return false;
			};

			// Determine routing: if pathParts[1] looks like a version, use GitHub proxy
			// Otherwise, serve directly from R2
			const useGitHubProxy = pathParts.length >= 3 && isGitHubVersionPattern(pathParts[1]);

			if (useGitHubProxy) {
				// ========== GITHUB PROXY ROUTE ==========
				return handleGitHubProxyRequest(request, env, ctx, url, path, pathParts);
			} else {
				// ========== DIRECT R2 SERVING ==========
				return handleDirectR2Request(request, env, ctx, url, path);
			}
		} catch (error) {
			console.error('CDN Error:', {
				error: error.message,
				stack: error.stack,
				url: request.url,
				method: request.method,
				path: new URL(request.url).pathname,
			});

			return new Response(`Error: ${error.message}`, { status: 500 });
		}
	},
};

/**
 * Handle GitHub proxy requests (existing functionality)
 * URL format: /:repo/:version/:file
 */
async function handleGitHubProxyRequest(request, env, ctx, url, path, pathParts) {
	// Try to get from cache first with ETag support
	const cache = caches.default;
	const cacheKey = new Request(url.toString(), request);
	let response = await cache.match(cacheKey);

	// Check if we have a fresh cache hit
	if (response) {
		const etag = request.headers.get('If-None-Match');
		if (etag && response.headers.get('ETag') === etag) {
			return new Response(null, { status: 304 });
		}
		response = new Response(response.body, response);
		response.headers.set('CF-Cache-Status', 'HIT');
		return response;
	}

	const repo = pathParts[0];
	const version = pathParts[1];
	let filePath = pathParts.slice(2).join('/');

	// Check if .min version is requested
	const shouldMinify = filePath.endsWith('.min.js') || filePath.endsWith('.min.css');
	if (shouldMinify) {
		filePath = filePath.replace('.min', '');
	}

	if (!repo || !version || !filePath) {
		return new Response('Invalid path format. Use: /repo/version/file-path', { status: 400 });
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

		// Preserve per-object Cache-Control from R2 when present; otherwise immutable default
		const headers = new Headers(response.headers);
		if (!headers.get('Cache-Control')) {
			headers.set('Cache-Control', 'public, max-age=31536000, immutable');
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

		// Cache in Cloudflare's edge with ETag
		ctx.waitUntil(cache.put(cacheKey, response.clone()));

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
	// Check for force download parameter
	const forceDownload = url.searchParams.get('download') === 'true';

	// Get the file from R2
	const object = await env.CDN_BUCKET.get(path);

	if (!object) {
		return new Response('File not found', { status: 404 });
	}

	// Determine content type based on file extension
	const extension = path.split('.').pop().toLowerCase();
	const contentType = CONTENT_TYPES[extension] || 'application/octet-stream';

	// Handle MP4 files with streaming support
	if (extension === 'mp4') {
		return handleMp4Stream(request, object, env, path);
	}

	// Prepare headers — honor per-object Cache-Control from R2 metadata when set
	const headers = new Headers({
		'Content-Type': contentType,
		'Cache-Control': object.httpMetadata?.cacheControl || 'public, max-age=31536000',
		ETag: object.httpEtag,
		'Last-Modified': object.uploaded.toUTCString(),
		'Access-Control-Allow-Origin': '*',
	});

	// Set Content-Disposition based on file type and download parameter
	if (forceDownload) {
		headers.set('Content-Disposition', `attachment; filename="${path.split('/').pop()}"`);
	} else if (PREVIEW_TYPES.has(extension)) {
		headers.set('Content-Disposition', 'inline');
	}

	// Track file request (non-blocking)
	trackFileRequest(env.CDN_BUCKET, path).catch((err) => {
		console.error('Error tracking file request:', err);
	});

	return new Response(object.body, { headers });
}
