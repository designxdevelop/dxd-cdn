import { WorkerEntrypoint } from 'cloudflare:workers';
import { loadObjectMeta, objectErrorMessage, storeObject } from './objects.js';

/**
 * Service-binding entrypoint for same-account Workers. See docs/connect-a-worker.md.
 *
 * Binding this grants put/get for every key in the bucket — only bind Workers you trust.
 */
export class CdnObjects extends WorkerEntrypoint {
	/**
	 * @param {{ key: string, body: ArrayBuffer|Uint8Array|string, contentType?: string, cacheControl?: string, overwrite?: boolean }} input
	 * @returns {Promise<{ ok: true, key: string, url: string, cacheControl: string }>}
	 */
	async putObject(input) {
		const result = await storeObject(this.env, input);
		if (!result.ok) {
			throw new Error(objectErrorMessage(result.code));
		}
		return result;
	}

	/**
	 * @param {string} key
	 * @returns {Promise<{ key: string, size: number, etag: string, uploaded: Date, contentType: string|null, cacheControl: string|null, url: string } | null>}
	 */
	async getObjectMeta(key) {
		const result = await loadObjectMeta(this.env, key);
		if (!result.ok) {
			if (result.code === 'NOT_FOUND') return null;
			throw new Error(objectErrorMessage(result.code));
		}
		const { ok: _ok, ...meta } = result;
		return meta;
	}
}
