/**
 * Purge-on-write for Workers Caching.
 *
 * This is the precondition docs/connect-a-worker.md names for giving live URLs
 * an edge copy at all: overwriting a live key has to drop the cached response
 * for that key, or a publish would stay invisible until the TTL expired.
 *
 * `cache` comes from `cloudflare:workers` rather than the handler's `ctx` so the
 * storage core can purge without every call site threading an execution context.
 * The local workerd runtime does not implement it, so this is a logged no-op
 * under `wrangler dev` and in tests.
 */

import { cache } from 'cloudflare:workers';
import { objectCacheTag, cacheTagForKey } from './cache.js';

/**
 * @typedef {{ purged: boolean, reason?: string }} PurgeOutcome
 */

/**
 * Drop the cached response for one object key.
 * @param {string} key
 * @returns {Promise<PurgeOutcome>}
 */
export async function purgeObjectKey(key) {
	if (typeof cache?.purge !== 'function') {
		return { purged: false, reason: 'unavailable' };
	}

	// Falls back to the client-wide tag only when the key is too long to tag
	// individually; coarser than wanted, but never stale.
	const tag = objectCacheTag(key) || cacheTagForKey(key);

	try {
		const result = await cache.purge({ tags: [tag] });
		if (result?.success === false) {
			console.error('Cache purge rejected', { key, tag, errors: result.errors });
			return { purged: false, reason: 'rejected' };
		}
		return { purged: true };
	} catch (error) {
		console.error('Cache purge failed', { key, tag, error: error.message });
		return { purged: false, reason: 'error' };
	}
}
