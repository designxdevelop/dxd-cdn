import { RpcTarget, WorkerEntrypoint } from 'cloudflare:workers';
import { loadObjectMeta, objectErrorMessage, storeObject } from './objects.js';
import { OPERATOR_SCOPE, scopeForToken } from './scopes.js';

/**
 * Prefix- and op-limited view of the bucket, resolved from an app token.
 * Returned by `CdnObjects.scope()`; the checks themselves are in objects.js.
 */
class ScopedCdnObjects extends RpcTarget {
	/**
	 * @param {Object} env
	 * @param {import('./scopes.js').Scope} scope
	 */
	constructor(env, scope) {
		super();
		this.#env = env;
		this.#scope = scope;
	}

	#env;
	#scope;

	/** The app name and limits this handle carries. */
	get scope() {
		return { app: this.#scope.app, prefixes: [...this.#scope.prefixes], ops: [...this.#scope.ops] };
	}

	/**
	 * @param {{ key: string, body: ArrayBuffer|Uint8Array|string, contentType?: string, cacheControl?: string, overwrite?: boolean }} input
	 * @returns {Promise<{ ok: true, key: string, url: string, cacheControl: string }>}
	 */
	async putObject(input) {
		const result = await storeObject(this.#env, this.#scope, input);
		if (!result.ok) throw new Error(objectErrorMessage(result.code));
		return result;
	}

	/**
	 * @param {string} key
	 * @returns {Promise<{ key: string, size: number, etag: string, uploaded: Date, contentType: string|null, cacheControl: string|null, url: string } | null>}
	 */
	async getObjectMeta(key) {
		const result = await loadObjectMeta(this.#env, this.#scope, key);
		if (!result.ok) {
			if (result.code === 'NOT_FOUND') return null;
			throw new Error(objectErrorMessage(result.code));
		}
		const { ok: _ok, ...meta } = result;
		return meta;
	}
}

/**
 * Service-binding entrypoint for same-account Workers. See docs/connect-a-worker.md.
 *
 * Calling `putObject` / `getObjectMeta` directly uses the operator scope and can
 * reach **every** key in the bucket — only bind Workers you trust that much.
 * A Worker that holds its own `APP_TOKENS` token should call `scope(token)`
 * first and work through the returned handle, which is limited to that token's
 * prefixes and ops.
 */
export class CdnObjects extends WorkerEntrypoint {
	/**
	 * Narrow this binding to one app token's prefixes and ops.
	 * @param {string} token
	 * @returns {Promise<ScopedCdnObjects>}
	 */
	async scope(token) {
		const scope = await scopeForToken(this.env, token);
		if (!scope) throw new Error('Unknown app token');
		return new ScopedCdnObjects(this.env, scope);
	}

	/**
	 * @param {{ key: string, body: ArrayBuffer|Uint8Array|string, contentType?: string, cacheControl?: string, overwrite?: boolean }} input
	 * @returns {Promise<{ ok: true, key: string, url: string, cacheControl: string }>}
	 */
	async putObject(input) {
		const result = await storeObject(this.env, OPERATOR_SCOPE, input);
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
		const result = await loadObjectMeta(this.env, OPERATOR_SCOPE, key);
		if (!result.ok) {
			if (result.code === 'NOT_FOUND') return null;
			throw new Error(objectErrorMessage(result.code));
		}
		const { ok: _ok, ...meta } = result;
		return meta;
	}
}
