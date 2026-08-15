export const CONTENT_TYPES = {
	js: 'application/javascript; charset=utf-8',
	css: 'text/css; charset=utf-8',
	html: 'text/html; charset=utf-8',
	htm: 'text/html; charset=utf-8',
	json: 'application/json; charset=utf-8',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	svg: 'image/svg+xml',
	webp: 'image/webp',
	woff: 'font/woff',
	woff2: 'font/woff2',
	ttf: 'font/ttf',
	eot: 'application/vnd.ms-fontobject',
	pdf: 'application/pdf',
	txt: 'text/plain; charset=utf-8',
	md: 'text/markdown; charset=utf-8',
	xml: 'text/xml; charset=utf-8',
	yaml: 'text/yaml; charset=utf-8',
	yml: 'text/yaml; charset=utf-8',
	mp4: 'video/mp4',
	zip: 'application/zip',
};

export const PREVIEW_TYPES = new Set([
	'pdf',
	'html',
	'htm',
	'jpg',
	'jpeg',
	'png',
	'gif',
	'svg',
	'webp',
	'mp4',
	'js',
	'css',
	'json',
	'txt',
	'md',
	'xml',
	'yaml',
	'yml',
]);

// File types that should be compressed
export const COMPRESSIBLE_TYPES = new Set([
	'js',
	'css',
	'html',
	'htm',
	'json',
	'svg',
	'xml',
	'txt',
	'md',
	'yaml',
	'yml',
]);

export const DEFAULT_GITHUB_OWNER = 'austin-thesing';
export const GITHUB_CACHE_TTL = 300000; // 5 minutes in milliseconds

/** Public origin used in RPC/service-binding responses (HTTP handlers use the request origin). */
export const DEFAULT_CDN_ORIGIN = 'https://cdn.designxdevelop.com';

/**
 * Mutable live URLs (config.json, personalization.js, web uploads).
 * Browsers revalidate on every navigation so a republish is visible without a hard refresh.
 */
export const MUTABLE_CACHE_CONTROL = 'public, max-age=0, must-revalidate';

/** Hashed / versioned snapshots that never change at that key. */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * Edge-only TTL for mutable objects. Short enough that a republish is visible
 * within a minute without a cache-purge API; long enough to absorb repeat hits.
 */
export const EDGE_MUTABLE_CACHE_CONTROL = 'public, max-age=60';
