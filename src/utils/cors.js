/**
 * CORS utilities for DXD CDN
 * Handles cross-origin request validation and headers
 */

/**
 * Check if origin is a Webflow domain (.webflow.io)
 * @param {string} origin - Origin to check
 * @returns {boolean} True if valid Webflow domain
 */
export function isWebflowDomain(origin) {
	if (!origin || typeof origin !== 'string') return false;

	try {
		const url = new URL(origin);
		return url.hostname.endsWith('.webflow.io');
	} catch {
		return false;
	}
}

/**
 * Get CORS headers for a request
 * Since we allow all origins (*), this returns permissive headers
 * @param {string} origin - Request origin (optional, for Vary header)
 * @returns {Object} Headers object with CORS headers
 */
export function getCorsHeaders(origin = null) {
	const headers = {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
		'Access-Control-Allow-Headers':
			'Content-Type, Authorization, X-DXD-Object-Key, X-DXD-Cache-Control, X-DXD-Overwrite, X-DXD-Json-Envelope',
	};

	// Add Vary header if origin is present for proper caching
	if (origin) {
		headers['Vary'] = 'Origin';
	}

	return headers;
}

/**
 * Handle CORS preflight requests (OPTIONS)
 * @returns {Response} Preflight response with CORS headers
 */
export function handleCorsPreflightRequest() {
	return new Response(null, {
		status: 204,
		headers: {
			...getCorsHeaders(),
			'Access-Control-Max-Age': '86400', // Cache preflight for 24 hours
		},
	});
}
