/**
 * File utilities for DXD CDN
 * Handles file operations, fuzzy search, analytics tracking, and file listing
 */

import { ANALYTICS_KEY_PREFIX, LEGACY_ANALYTICS_KEY_PREFIX, RESERVED_KEY_PREFIXES } from '../config/constants.js';

/**
 * Generate unique filename by adding -1, -2, etc. if file exists
 * @param {R2Bucket} bucket - R2 bucket instance
 * @param {string} originalName - Original filename
 * @returns {Promise<string>} Unique filename
 */
export async function getUniqueFilename(bucket, originalName) {
	const extension = originalName.includes('.') ? originalName.split('.').pop() : '';
	const baseName = originalName.includes('.') ? originalName.split('.').slice(0, -1).join('.') : originalName;

	let filename = originalName;
	let counter = 1;

	// `head` rather than `get`: existence only, no body download.
	while (await bucket.head(filename)) {
		if (extension) {
			filename = `${baseName}-${counter}.${extension}`;
		} else {
			filename = `${baseName}-${counter}`;
		}
		counter++;
	}

	return filename;
}

/**
 * Simple fuzzy search scoring function
 * @param {string} filename - Filename to score
 * @param {string} query - Search query
 * @returns {number} Score between 0 and 1
 */
export function fuzzyScore(filename, query) {
	if (!query) return 1; // Perfect score if no query

	const filenameLower = filename.toLowerCase();
	const queryLower = query.toLowerCase();

	// Exact substring match gets highest score
	if (filenameLower.includes(queryLower)) {
		return 1;
	}

	// Split filename into searchable parts (by common delimiters)
	const filenameParts = filenameLower.split(/[-_.\/]/);
	const queryParts = queryLower.split(/[\s-_]/);

	// Check if all query parts are found in any filename parts
	let totalScore = 0;
	let matchedParts = 0;

	for (const queryPart of queryParts) {
		if (queryPart.length === 0) continue;

		let bestPartScore = 0;

		for (const filenamePart of filenameParts) {
			const score = fuzzyMatchPart(filenamePart, queryPart);
			bestPartScore = Math.max(bestPartScore, score);
		}

		if (bestPartScore > 0.3) {
			// Minimum threshold for a part match
			totalScore += bestPartScore;
			matchedParts++;
		}
	}

	// Return average score across matched parts, or 0 if no parts matched
	return matchedParts > 0 ? totalScore / queryParts.length : 0;
}

/**
 * Helper function to score matching between individual parts
 * @param {string} filenamePart - Part of filename
 * @param {string} queryPart - Part of query
 * @returns {number} Score between 0 and 1
 */
function fuzzyMatchPart(filenamePart, queryPart) {
	if (filenamePart.includes(queryPart)) return 1;

	let score = 0;
	let queryIndex = 0;
	let consecutiveMatches = 0;

	for (let i = 0; i < filenamePart.length && queryIndex < queryPart.length; i++) {
		if (filenamePart[i] === queryPart[queryIndex]) {
			score += 0.1; // Base points for each character match
			score += (filenamePart.length - i) * 0.01; // Bonus for earlier matches
			consecutiveMatches++;
			score += consecutiveMatches * 0.05; // Bonus for consecutive matches
			queryIndex++;
		} else {
			consecutiveMatches = 0;
		}
	}

	// Normalize score by query length and add completion bonus
	const completionRatio = queryIndex / queryPart.length;
	score = score * completionRatio;

	// Bonus for completing the entire query
	if (queryIndex === queryPart.length) {
		score += 0.3;
	}

	return Math.min(score, 1); // Cap at 1.0
}

/**
 * Parse file path into client/project/env structure
 * @param {string} filepath - Full file path
 * @returns {Object|null} Parsed path info or null if invalid
 */
export function parseFilePath(filepath) {
	const parts = filepath.split('/');
	if (parts.length < 4) {
		return null;
	}
	return {
		client: parts[0],
		project: parts[1],
		env: parts[2], // staging or prod
		file: parts.slice(3).join('/'),
	};
}

/**
 * Counter object for one served key.
 * @param {string} filepath
 * @returns {string}
 */
export function analyticsKeyFor(filepath) {
	return `${ANALYTICS_KEY_PREFIX}${filepath}.json`;
}

/**
 * Record one request against a key.
 *
 * Callers must hand the returned promise to `ctx.waitUntil`. Without that the
 * write is cancelled the moment the response finishes, which is why counters
 * used to stay at zero no matter how many times a file was served.
 *
 * Counts are approximate by design: this is a read-modify-write on an R2 object,
 * so simultaneous requests can lose an increment, and a Workers Caching hit does
 * not run the Worker at all.
 * @param {R2Bucket} bucket - R2 bucket instance
 * @param {string} filepath - File path being accessed
 * @returns {Promise<void>}
 */
export async function trackFileRequest(bucket, filepath) {
	try {
		const analyticsKey = analyticsKeyFor(filepath);
		const existingData = await readAnalyticsObject(bucket, filepath);
		let stats = { requestCount: 0, firstServed: null, lastServed: null };

		if (existingData) {
			try {
				stats = JSON.parse(await existingData.text());
			} catch {
				// If parsing fails, use defaults
			}
		}

		const now = new Date().toISOString();
		stats.requestCount = (stats.requestCount || 0) + 1;
		stats.lastServed = now;
		if (!stats.firstServed) {
			stats.firstServed = now;
		}

		await bucket.put(analyticsKey, JSON.stringify(stats), {
			httpMetadata: { contentType: 'application/json' },
		});
	} catch (error) {
		// Silently fail - analytics should not break file serving
		console.error('Error tracking file request:', error);
	}
}

/**
 * Reads the reserved location, falling back to the pre-`_cdn/` one so counters
 * recorded before the move still show up.
 * @param {R2Bucket} bucket
 * @param {string} filepath
 * @returns {Promise<R2ObjectBody|null>}
 */
async function readAnalyticsObject(bucket, filepath) {
	const current = await bucket.get(analyticsKeyFor(filepath));
	if (current) return current;
	return bucket.get(`${LEGACY_ANALYTICS_KEY_PREFIX}${filepath}.json`);
}

/**
 * Get file statistics
 * @param {R2Bucket} bucket - R2 bucket instance
 * @param {string} filepath - File path to get stats for
 * @returns {Promise<Object>} File statistics
 */
export async function getFileStats(bucket, filepath) {
	try {
		const analyticsData = await readAnalyticsObject(bucket, filepath);

		if (!analyticsData) {
			return { requestCount: 0, firstServed: null, lastServed: null };
		}

		return JSON.parse(await analyticsData.text());
	} catch (error) {
		console.error('Error getting file stats:', error);
		return { requestCount: 0, firstServed: null, lastServed: null };
	}
}

/**
 * Both analytics locations for a key, so a delete removes either.
 * @param {string} filepath
 * @returns {string[]}
 */
export function analyticsKeysFor(filepath) {
	return [analyticsKeyFor(filepath), `${LEGACY_ANALYTICS_KEY_PREFIX}${filepath}.json`];
}

/** R2 returns at most 1000 keys per `list` call. */
const R2_LIST_PAGE_SIZE = 1000;

/** Pages the operator listing will walk before reporting itself truncated. */
export const MAX_LIST_PAGES = 20;

/**
 * Every key under `prefix`, following R2's cursor instead of stopping at the
 * first page. A single `list()` returns at most 1000 keys and reports
 * `truncated` — ignoring that silently dropped files from the browse UI and
 * from the client/project/env facets computed off the same page.
 * @param {R2Bucket} bucket
 * @param {string} [prefix]
 * @param {number} [maxPages]
 * @returns {Promise<{ keys: string[], truncated: boolean }>}
 */
export async function listAllKeys(bucket, prefix = '', maxPages = MAX_LIST_PAGES) {
	const keys = [];
	let cursor;

	for (let page = 0; page < maxPages; page++) {
		const result = await bucket.list({
			prefix: prefix || undefined,
			cursor,
			limit: R2_LIST_PAGE_SIZE,
		});
		for (const object of result.objects) {
			keys.push(object.key);
		}
		if (!result.truncated) {
			return { keys, truncated: false };
		}
		cursor = result.cursor;
	}

	console.warn('Listing stopped at the page cap', { prefix, maxPages, keys: keys.length });
	return { keys, truncated: true };
}

/**
 * Get list of files from R2 bucket with optional search, client, project, environment, and folder filters
 * @param {R2Bucket} bucket - R2 bucket instance
 * @param {Object} options - Filter options
 * @param {string} [options.search] - Search query
 * @param {string} [options.client] - Client name filter
 * @param {string} [options.project] - Project name filter
 * @param {string} [options.env] - Environment filter (staging/prod/all)
 * @param {string} [options.prefix] - Key prefix to list under
 * @returns {Promise<Object>} Object containing files array, filter options, and whether the scan hit its cap
 */
export async function getFilesList(bucket, options = {}) {
	const { search = '', client = 'all', project = 'all', env = 'all', prefix = '' } = options;

	try {
		const listed = await listAllKeys(bucket, prefix);
		let files = listed.keys
			// Platform bookkeeping is not a file anybody uploaded
			.filter((filename) => !RESERVED_KEY_PREFIXES.some((reserved) => filename.startsWith(reserved)));

		// Extract unique clients, projects, and environments from file paths
		const clientsSet = new Set();
		const projectsSet = new Set();
		const envsSet = new Set();

		files.forEach((filename) => {
			const parsed = parseFilePath(filename);
			if (parsed) {
				clientsSet.add(parsed.client);
				projectsSet.add(`${parsed.client}/${parsed.project}`);
				if (parsed.env === 'staging' || parsed.env === 'prod') {
					envsSet.add(parsed.env);
				}
			}
		});

		// Filter by client
		if (client !== 'all') {
			files = files.filter((filename) => {
				const parsed = parseFilePath(filename);
				return parsed && parsed.client === client;
			});
		}

		// Filter by project (expects format: client/project)
		if (project !== 'all') {
			files = files.filter((filename) => {
				const parsed = parseFilePath(filename);
				return parsed && `${parsed.client}/${parsed.project}` === project;
			});
		}

		// Filter by environment
		if (env !== 'all') {
			files = files.filter((filename) => {
				const parsed = parseFilePath(filename);
				return parsed && parsed.env === env;
			});
		}

		// Filter by search term if provided (fuzzy search)
		if (search) {
			files = files.filter((filename) => {
				const score = fuzzyScore(filename, search);
				return score > 0.2; // Minimum threshold for fuzzy matches
			});
		}

		// Sort alphabetically
		files.sort();

		return {
			files,
			clients: Array.from(clientsSet).sort(),
			projects: Array.from(projectsSet).sort(),
			envs: Array.from(envsSet).sort(),
			scanned: listed.keys.length,
			truncated: listed.truncated,
		};
	} catch (error) {
		console.error('Error listing files:', error);
		return { files: [], clients: [], projects: [], envs: [], scanned: 0, truncated: false };
	}
}
