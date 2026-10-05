/**
 * Upload route handlers for DXD CDN
 */

import { MUTABLE_CACHE_CONTROL } from '../config/constants.js';
import { normalizeObjectKey } from '../services/objects.js';
import { UPLOAD_FORM_HTML, getSuccessHTML, getUploadErrorHTML } from '../templates/upload.js';
import { uncachedHtmlHeaders } from '../utils/cache.js';
import { getUniqueFilename } from '../utils/files.js';

/**
 * Handle GET request for upload form
 * @returns {Response} Upload form HTML
 */
export function handleUploadGet() {
	return new Response(UPLOAD_FORM_HTML, {
		headers: uncachedHtmlHeaders(),
	});
}

/**
 * Handle POST request for file upload
 * @param {Request} request - Incoming request
 * @param {Object} env - Environment bindings
 * @param {URL} url - Parsed URL
 * @returns {Promise<Response>} Upload result
 */
export async function handleUploadPost(request, env, url) {
	try {
		// Parse form data
		const formData = await request.formData();
		const password = formData.get('password');
		const file = formData.get('file');
		const uploadPath = formData.get('path') || '';

		// Validate password
		if (!env.UPLOAD_PASSWORD || password !== env.UPLOAD_PASSWORD) {
			return new Response(getUploadErrorHTML('Invalid password. Please try again.'), {
				status: 401,
				headers: uncachedHtmlHeaders(),
			});
		}

		// Validate file
		if (!file || file.size === 0) {
			return new Response(getUploadErrorHTML('Please select a file to upload.'), {
				status: 400,
				headers: uncachedHtmlHeaders(),
			});
		}

		// Construct the full path
		let fullPath = file.name;
		if (uploadPath) {
			// Clean the path - remove leading/trailing slashes
			const cleanPath = uploadPath.replace(/^\/+|\/+$/g, '');
			if (cleanPath) {
				fullPath = `${cleanPath}/${file.name}`;
			}
		}

		// Same key rules as the Objects API. Without this, `path=../../escaped`
		// stored a literal `../../escaped/` key that polluted the browse facets
		// and could not be addressed through the Objects API at all.
		const normalizedPath = normalizeObjectKey(fullPath);
		if (!normalizedPath) {
			return new Response(getUploadErrorHTML(`"${fullPath}" is not a valid path. Use letters, numbers, dashes, and single slashes.`), {
				status: 400,
				headers: uncachedHtmlHeaders(),
			});
		}

		// Get unique filename (adds -1, -2, etc. if file exists)
		const filename = await getUniqueFilename(env.CDN_BUCKET, normalizedPath);

		// Upload to R2
		await env.CDN_BUCKET.put(filename, file.stream(), {
			httpMetadata: {
				contentType: file.type || 'application/octet-stream',
				cacheControl: MUTABLE_CACHE_CONTROL,
			},
		});

		// Generate CDN URL
		const cdnUrl = `${url.origin}/${filename}`;

		// Return success page
		return new Response(getSuccessHTML(file.name, cdnUrl), {
			headers: uncachedHtmlHeaders(),
		});
	} catch (error) {
		console.error('Upload error:', error);
		return new Response(getUploadErrorHTML('There was an error uploading your file. Please try again.'), {
			status: 500,
			headers: uncachedHtmlHeaders(),
		});
	}
}
