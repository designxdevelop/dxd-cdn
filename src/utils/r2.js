/**
 * R2 key lookup and conditional GET helpers.
 */

/**
 * Keys to try for a public GET. Pathname is decoded; some objects were stored percent-encoded.
 * @param {Request} request
 * @param {string} decodedPath
 * @returns {string[]}
 */
export function r2KeyCandidates(request, decodedPath) {
	const keys = [];
	const add = (key) => {
		if (key && !keys.includes(key)) keys.push(key);
	};

	add(decodedPath);
	try {
		add(decodeURIComponent(decodedPath));
	} catch {
		// malformed percent-encoding
	}

	const rawPath = request.url
		.replace(/^https?:\/\/[^/]+/i, '')
		.split('?')[0]
		.split('#')[0]
		.replace(/^\/+/, '');
	add(rawPath);

	return keys;
}

/**
 * Conditional headers for R2 `onlyIf` (If-None-Match / If-Match / If-Modified-Since).
 * @param {Request} request
 * @returns {{ onlyIf?: Headers }}
 */
export function r2GetOptions(request) {
	const onlyIf = new Headers();
	for (const name of ['If-Match', 'If-None-Match', 'If-Modified-Since', 'If-Unmodified-Since']) {
		const value = request.headers.get(name);
		if (value) onlyIf.set(name, value);
	}
	return [...onlyIf.keys()].length ? { onlyIf } : {};
}

/**
 * R2 returns an object without `body` when `onlyIf` preconditions fail.
 * @param {R2Object|R2ObjectBody|null|undefined} object
 * @returns {boolean}
 */
export function hasR2Body(object) {
	return Boolean(object && 'body' in object);
}

/**
 * Map a failed R2 `onlyIf` GET to an HTTP status.
 * R2 omits the body for any failed condition; Cloudflare’s sample uses 412 for all of them.
 * RFC 9110: If-None-Match / If-Modified-Since → 304; If-Match / If-Unmodified-Since → 412.
 * @param {Request} request
 * @returns {304|412}
 */
export function failedOnlyIfStatus(request) {
	if (request.headers.has('If-Match') || request.headers.has('If-Unmodified-Since')) {
		return 412;
	}
	return 304;
}

/**
 * @param {R2Bucket} bucket
 * @param {Request} request
 * @param {string} decodedPath
 * @returns {Promise<{ object: R2Object|R2ObjectBody|null, key: string }>}
 */
export async function getR2Object(bucket, request, decodedPath) {
	const options = r2GetOptions(request);
	for (const key of r2KeyCandidates(request, decodedPath)) {
		const object = await bucket.get(key, options);
		if (object) return { object, key };
	}
	return { object: null, key: decodedPath };
}

/**
 * @param {R2Bucket} bucket
 * @param {Request} request
 * @param {string} decodedPath
 * @returns {Promise<{ object: R2Object|null, key: string }>}
 */
export async function headR2Object(bucket, request, decodedPath) {
	for (const key of r2KeyCandidates(request, decodedPath)) {
		const object = await bucket.head(key);
		if (object) return { object, key };
	}
	return { object: null, key: decodedPath };
}
