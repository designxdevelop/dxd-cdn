/**
 * Service-binding entrypoint so client Workers (Heard, Studio, future apps)
 * can put/pull objects without sending UPLOAD_PASSWORD over HTTP.
 *
 * Consumer wrangler.toml:
 *
 *   [[services]]
 *   binding = "DXD_CDN"
 *   service = "dxd-cdn"
 *   entrypoint = "CdnObjects"
 *
 *   await env.DXD_CDN.putObject({ key: 'heard/hp/prod/config.json', body, contentType: 'application/json' })
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { loadObjectMeta, storeObject } from '../handlers/objects-api.js';

export class CdnObjects extends WorkerEntrypoint {
	/**
	 * Put an object. Same-account Workers skip HTTP Bearer auth.
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
