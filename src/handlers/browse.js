/**
 * Browse route handlers for DXD CDN
 */

import { getBrowsePasswordHTML, getBrowseHTML } from '../templates/browse.js';
import { uncachedHtmlHeaders } from '../utils/cache.js';

/**
 * Handle GET request for browse page
 * @param {URL} url - Parsed URL
 * @param {Object} env - Environment bindings
 * @returns {Response} Browse page HTML
 */
export function handleBrowseGet(url, env) {
	// Check for password in query params
	const password = url.searchParams.get('password');

	// Validate password
	if (!env.UPLOAD_PASSWORD || password !== env.UPLOAD_PASSWORD) {
		// Serve password form
		return new Response(getBrowsePasswordHTML(), {
			headers: uncachedHtmlHeaders(),
		});
	}

	// Password valid, serve the file browser
	return new Response(getBrowseHTML(url.origin, password), {
		headers: uncachedHtmlHeaders(),
	});
}

/**
 * Handle POST request for browse authentication
 * @param {Request} request - Incoming request
 * @param {Object} env - Environment bindings
 * @param {URL} url - Parsed URL
 * @returns {Promise<Response>} Redirect or error
 */
export async function handleBrowsePost(request, env, url) {
	try {
		// Parse form data
		const formData = await request.formData();
		const password = formData.get('password');

		// Validate password
		if (!env.UPLOAD_PASSWORD || password !== env.UPLOAD_PASSWORD) {
			return new Response(getBrowsePasswordHTML('Invalid password. Please try again.'), {
				status: 401,
				headers: uncachedHtmlHeaders(),
			});
		}

		// Password valid, redirect to browse with password
		return Response.redirect(`${url.origin}/browse?password=${encodeURIComponent(password)}`, 302);
	} catch (error) {
		console.error('Browse auth error:', error);
		return new Response(getBrowsePasswordHTML('An error occurred. Please try again.'), {
			status: 500,
			headers: uncachedHtmlHeaders(),
		});
	}
}
