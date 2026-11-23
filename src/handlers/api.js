/**
 * API route handlers for DXD CDN
 */

import { jsonApiHeaders } from '../utils/cors.js';
import { objectErrorMessage, objectErrorStatus, removeObject } from '../services/objects.js';
import { OPERATOR_SCOPE, resolveScope } from '../services/scopes.js';
import { getFilesList, getFileStats } from '../utils/files.js';

/**
 * Operator routes take `Authorization: Bearer <UPLOAD_PASSWORD>` and nothing
 * else. A scoped app token is refused here, and the token is never read from
 * the URL, where it would end up in history and logs.
 * @param {Request} request
 * @param {URL} url
 * @param {Object} env
 * @returns {Promise<Response|null>} Error response if invalid, null if valid
 */
async function requireOperator(request, url, env) {
	const scope = await resolveScope(request, url, env);
	if (scope === OPERATOR_SCOPE) return null;
	return new Response(JSON.stringify({ error: 'Unauthorized' }), {
		status: 401,
		headers: jsonApiHeaders(),
	});
}

/**
 * Handle GET /api/files - List files with search/filter
 *
 * Operator view of the whole bucket (or one `prefix`). Walks R2's cursor up to a
 * page cap and reports `truncated` when it stops, so a listing is never quietly
 * short. Apps should use the paginated `GET /api/objects/list` instead.
 * @param {Request} request - Incoming request
 * @param {URL} url - Parsed URL
 * @param {Object} env - Environment bindings
 * @returns {Promise<Response>} Files list JSON
 */
export async function handleFilesApi(request, url, env) {
	try {
		const authError = await requireOperator(request, url, env);
		if (authError) return authError;

		const search = url.searchParams.get('search') || '';
		const client = url.searchParams.get('client') || 'all';
		const project = url.searchParams.get('project') || 'all';
		const envFilter = url.searchParams.get('env') || 'all';
		const prefix = url.searchParams.get('prefix') || '';

		const result = await getFilesList(env.CDN_BUCKET, {
			search,
			client,
			project,
			env: envFilter,
			prefix,
		});

		return new Response(JSON.stringify(result), {
			headers: jsonApiHeaders(),
		});
	} catch (error) {
		console.error('Files API error:', error);
		return new Response(JSON.stringify({ error: 'Failed to fetch files' }), {
			status: 500,
			headers: jsonApiHeaders(),
		});
	}
}

/**
 * Handle GET /api/file-stats - Get file analytics
 * @param {Request} request - Incoming request
 * @param {URL} url - Parsed URL
 * @param {Object} env - Environment bindings
 * @returns {Promise<Response>} File stats JSON
 */
export async function handleFileStatsApi(request, url, env) {
	try {
		const authError = await requireOperator(request, url, env);
		if (authError) return authError;

		const filepath = url.searchParams.get('file');
		if (!filepath) {
			return new Response(JSON.stringify({ error: 'File parameter required' }), {
				status: 400,
				headers: jsonApiHeaders(),
			});
		}

		const stats = await getFileStats(env.CDN_BUCKET, filepath);

		return new Response(JSON.stringify(stats), {
			headers: jsonApiHeaders(),
		});
	} catch (error) {
		console.error('File stats API error:', error);
		return new Response(JSON.stringify({ error: 'Failed to fetch file stats' }), {
			status: 500,
			headers: jsonApiHeaders(),
		});
	}
}

/**
 * Handle GET /api/file-content - Get file content (HTML files only)
 * @param {Request} request - Incoming request
 * @param {URL} url - Parsed URL
 * @param {Object} env - Environment bindings
 * @returns {Promise<Response>} File content JSON
 */
export async function handleFileContentApi(request, url, env) {
	try {
		const authError = await requireOperator(request, url, env);
		if (authError) return authError;

		const filename = url.searchParams.get('file');
		if (!filename) {
			return new Response(JSON.stringify({ error: 'File parameter required' }), {
				status: 400,
				headers: jsonApiHeaders(),
			});
		}

		// Only allow HTML files for content fetching
		const extension = filename.split('.').pop().toLowerCase();
		if (extension !== 'html' && extension !== 'htm') {
			return new Response(JSON.stringify({ error: 'Only HTML files are supported' }), {
				status: 400,
				headers: jsonApiHeaders(),
			});
		}

		// Get the file from R2
		const object = await env.CDN_BUCKET.get(filename);
		if (!object) {
			return new Response(JSON.stringify({ error: 'File not found' }), {
				status: 404,
				headers: jsonApiHeaders(),
			});
		}

		// Read the content as text
		const content = await object.text();

		return new Response(JSON.stringify({ content }), {
			headers: jsonApiHeaders(),
		});
	} catch (error) {
		console.error('File content API error:', error);
		return new Response(JSON.stringify({ error: 'Failed to fetch file content' }), {
			status: 500,
			headers: jsonApiHeaders(),
		});
	}
}

/**
 * Handle DELETE /api/delete-file - Delete a file
 * @param {Request} request - Incoming request
 * @param {URL} url - Parsed URL
 * @param {Object} env - Environment bindings
 * @returns {Promise<Response>} Delete result JSON
 */
export async function handleDeleteFileApi(request, url, env) {
	try {
		const authError = await requireOperator(request, url, env);
		if (authError) return authError;

		const filename = url.searchParams.get('file');
		if (!filename) {
			return new Response(JSON.stringify({ error: 'File parameter required' }), {
				status: 400,
				headers: jsonApiHeaders(),
			});
		}

		// Same path as DELETE /api/objects, so the edge copy is purged too.
		const result = await removeObject(env, OPERATOR_SCOPE, filename);
		if (!result.ok) {
			const notFound = result.code === 'NOT_FOUND';
			return new Response(JSON.stringify({ error: notFound ? 'File not found' : objectErrorMessage(result.code) }), {
				status: objectErrorStatus(result.code),
				headers: jsonApiHeaders(),
			});
		}

		return new Response(JSON.stringify({ success: true, message: 'File deleted successfully' }), {
			headers: jsonApiHeaders(),
		});
	} catch (error) {
		console.error('Delete file API error:', error);
		return new Response(JSON.stringify({ error: 'Failed to delete file' }), {
			status: 500,
			headers: jsonApiHeaders(),
		});
	}
}
