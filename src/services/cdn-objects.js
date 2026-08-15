import { WorkerEntrypoint } from 'cloudflare:workers';
import { loadObjectMeta, storeObject } from '../handlers/objects-api.js';

/**
 * Service-binding entrypoint for same-account Workers. See docs/connect-a-worker.md.
 */
export class CdnObjects extends WorkerEntrypoint {
	/**
	 * @param {{ key: string, body: ArrayBuffer|Uint8Array|string, contentType?: string, cacheControl?: string, overwrite?: boolean }} input
	 * @returns {Promise<{ ok: true, key: string, url: string, cacheControl: string }>}
	 */
	async putObject(input) {
		const result = await storeObject(this.env, input);
		if (result.error) {
			throw new Error(result.error);
		}
		return result;
	}

	/**
	 * @param {string} key
	 * @returns {Promise<{ key: string, size: number, etag: string, uploaded: Date, contentType: string|null, cacheControl: string|null, url: string } | null>}
	 */
	async getObjectMeta(key) {
		const result = await loadObjectMeta(this.env, key);
		if (result.error) {
			if (result.status === 404) return null;
			throw new Error(result.error);
		}
		return result;
	}
}
