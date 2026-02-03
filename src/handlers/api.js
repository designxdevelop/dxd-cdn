/**
 * API route handlers for DXD CDN
 */

import { getFilesList, getFileStats } from '../utils/files.js';

/**
 * Validate API password
 * @param {URL} url - Request URL
 * @param {Object} env - Environment bindings
 * @returns {Response|null} Error response if invalid, null if valid
 */
function validatePassword(url, env) {
	const password = url.searchParams.get('password');
	if (!env.UPLOAD_PASSWORD || password !== env.UPLOAD_PASSWORD) {
		return new Response(JSON.stringify({ error: 'Unauthorized' }), {
			status: 401,
			headers: { 'Content-Type': 'application/json' },
		});
	}
	return null;
}

/**
 * Handle GET /api/files - List files with search/filter
 * @param {URL} url - Parsed URL
 * @param {Object} env - Environment bindings
 * @returns {Promise<Response>} Files list JSON
 */
export async function handleFilesApi(url, env) {
	try {
		const authError = validatePassword(url, env);
		if (authError) return authError;

		const search = url.searchParams.get('search') || '';
		const client = url.searchParams.get('client') || 'all';
		const project = url.searchParams.get('project') || 'all';
		const envFilter = url.searchParams.get('env') || 'all';

		const result = await getFilesList(env.CDN_BUCKET, {
			search,
			client,
			project,
			env: envFilter,
		});

		return new Response(JSON.stringify(result), {
			headers: {
				'Content-Type': 'application/json',
				'Cache-Control': 'no-cache',
			},
		});
	} catch (error) {
		console.error('Files API error:', error);
		return new Response(JSON.stringify({ error: 'Failed to fetch files' }), {
			status: 500,
			headers: { 'Content-Type': 'application/json' },
		});
	}
}

/**
 * Handle GET /api/file-stats - Get file analytics
 * @param {URL} url - Parsed URL
 * @param {Object} env - Environment bindings
 * @returns {Promise<Response>} File stats JSON
 */
export async function handleFileStatsApi(url, env) {
	try {
		const authError = validatePassword(url, env);
		if (authError) return authError;

		const filepath = url.searchParams.get('file');
		if (!filepath) {
			return new Response(JSON.stringify({ error: 'File parameter required' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		const stats = await getFileStats(env.CDN_BUCKET, filepath);

		return new Response(JSON.stringify(stats), {
			headers: {
				'Content-Type': 'application/json',
				'Cache-Control': 'no-cache',
			},
		});
	} catch (error) {
		console.error('File stats API error:', error);
		return new Response(JSON.stringify({ error: 'Failed to fetch file stats' }), {
			status: 500,
			headers: { 'Content-Type': 'application/json' },
		});
	}
}

/**
 * Handle GET /api/file-content - Get file content (HTML files only)
 * @param {URL} url - Parsed URL
 * @param {Object} env - Environment bindings
 * @returns {Promise<Response>} File content JSON
 */
export async function handleFileContentApi(url, env) {
	try {
		const authError = validatePassword(url, env);
		if (authError) return authError;

		const filename = url.searchParams.get('file');
		if (!filename) {
			return new Response(JSON.stringify({ error: 'File parameter required' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		// Only allow HTML files for content fetching
		const extension = filename.split('.').pop().toLowerCase();
		if (extension !== 'html' && extension !== 'htm') {
			return new Response(JSON.stringify({ error: 'Only HTML files are supported' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		// Get the file from R2
		const object = await env.CDN_BUCKET.get(filename);
		if (!object) {
			return new Response(JSON.stringify({ error: 'File not found' }), {
				status: 404,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		// Read the content as text
		const content = await object.text();

		return new Response(JSON.stringify({ content }), {
			headers: {
				'Content-Type': 'application/json',
				'Cache-Control': 'no-cache',
			},
		});
	} catch (error) {
		console.error('File content API error:', error);
		return new Response(JSON.stringify({ error: 'Failed to fetch file content' }), {
			status: 500,
			headers: { 'Content-Type': 'application/json' },
		});
	}
}

/**
 * Handle DELETE /api/delete-file - Delete a file
 * @param {URL} url - Parsed URL
 * @param {Object} env - Environment bindings
 * @returns {Promise<Response>} Delete result JSON
 */
export async function handleDeleteFileApi(url, env) {
	try {
		const authError = validatePassword(url, env);
		if (authError) return authError;

		const filename = url.searchParams.get('file');
		if (!filename) {
			return new Response(JSON.stringify({ error: 'File parameter required' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		// Check if file exists
		const object = await env.CDN_BUCKET.get(filename);
		if (!object) {
			return new Response(JSON.stringify({ error: 'File not found' }), {
				status: 404,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		// Delete the file from R2
		await env.CDN_BUCKET.delete(filename);

		// Also try to delete analytics for this file (don't fail if it doesn't exist)
		try {
			await env.CDN_BUCKET.delete(`analytics/${filename}.json`);
		} catch {
			// Ignore errors deleting analytics
		}

		return new Response(JSON.stringify({ success: true, message: 'File deleted successfully' }), {
			headers: {
				'Content-Type': 'application/json',
				'Cache-Control': 'no-cache',
			},
		});
	} catch (error) {
		console.error('Delete file API error:', error);
		return new Response(JSON.stringify({ error: 'Failed to delete file' }), {
			status: 500,
			headers: { 'Content-Type': 'application/json' },
		});
	}
}
