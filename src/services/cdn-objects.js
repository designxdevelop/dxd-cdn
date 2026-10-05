import { RpcTarget, WorkerEntrypoint } from 'cloudflare:workers';
import { listObjects, loadObjectMeta, objectErrorMessage, removeObject, storeObject } from './objects.js';
import { OPERATOR_SCOPE, scopeForToken } from './scopes.js';

/**
 * The object operations, bound to one scope. Shared by the operator entrypoint
 * and the scoped handle so both get the same behavior; the prefix and op checks
 * themselves live in objects.js.
 * @param {Object} env
 * @param {import('./scopes.js').Scope} scope
 */
function objectMethods(env, scope) {
	return {
		/**
		 * @param {{ key: string, body: ArrayBuffer|Uint8Array|string, contentType?: string, cacheControl?: string, overwrite?: boolean }} input
		 * @returns {Promise<{ ok: true, key: string, url: string, cacheControl: string, purged: boolean }>}
		 */
		async putObject(input) {
			const result = await storeObject(env, scope, input);
			if (!result.ok) throw new Error(objectErrorMessage(result.code));
			return result;
		},

		/**
		 * @param {string} key
		 * @returns {Promise<{ key: string, size: number, etag: string, uploaded: Date, contentType: string|null, cacheControl: string|null, url: string }|null>} null when the object does not exist.
		 */
		async getObjectMeta(key) {
			const result = await loadObjectMeta(env, scope, key);
			if (!result.ok) {
				if (result.code === 'NOT_FOUND') return null;
				throw new Error(objectErrorMessage(result.code));
			}
			const { ok: _ok, ...meta } = result;
			return meta;
		},

		/**
		 * @param {string} key
		 * @returns {Promise<boolean>} false when there was nothing to delete.
		 */
		async deleteObject(key) {
			const result = await removeObject(env, scope, key);
			if (!result.ok) {
				if (result.code === 'NOT_FOUND') return false;
				throw new Error(objectErrorMessage(result.code));
			}
			return true;
		},

		/**
		 * @param {{ prefix?: string, cursor?: string, limit?: number, delimiter?: string }} [options]
		 * @returns {Promise<{ prefix: string, objects: Object[], prefixes: string[], truncated: boolean, cursor: string|null }>}
		 */
		async listObjects(options) {
			const result = await listObjects(env, scope, options || {});
			if (!result.ok) throw new Error(objectErrorMessage(result.code));
			const { ok: _ok, ...page } = result;
			return page;
		},
	};
}

/**
 * Prefix- and op-limited view of the bucket, resolved from an app token.
 * Returned by `CdnObjects.scope()`.
 */
class ScopedCdnObjects extends RpcTarget {
	/**
	 * @param {Object} env
	 * @param {import('./scopes.js').Scope} scope
	 */
	constructor(env, scope) {
		super();
		this.#scope = scope;
		const methods = objectMethods(env, scope);
		this.putObject = methods.putObject;
		this.getObjectMeta = methods.getObjectMeta;
		this.deleteObject = methods.deleteObject;
		this.listObjects = methods.listObjects;
	}

	#scope;

	/** The app name and limits this handle carries. */
	get scope() {
		return { app: this.#scope.app, prefixes: [...this.#scope.prefixes], ops: [...this.#scope.ops] };
	}
}

/**
 * Service-binding entrypoint for same-account Workers. See docs/connect-a-worker.md.
 *
 * Calling the object methods directly uses the operator scope and can reach
 * **every** key in the bucket — only bind Workers you trust that much. A Worker
 * that holds its own `APP_TOKENS` token should call `scope(token)` first and work
 * through the returned handle, which is limited to that token's prefixes and ops.
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
	 * @returns {Promise<{ ok: true, key: string, url: string, cacheControl: string, purged: boolean }>}
	 */
	async putObject(input) {
		return objectMethods(this.env, OPERATOR_SCOPE).putObject(input);
	}

	/**
	 * @param {string} key
	 * @returns {Promise<{ key: string, size: number, etag: string, uploaded: Date, contentType: string|null, cacheControl: string|null, url: string }|null>}
	 */
	async getObjectMeta(key) {
		return objectMethods(this.env, OPERATOR_SCOPE).getObjectMeta(key);
	}

	/**
	 * @param {string} key
	 * @returns {Promise<boolean>} false when there was nothing to delete.
	 */
	async deleteObject(key) {
		return objectMethods(this.env, OPERATOR_SCOPE).deleteObject(key);
	}

	/**
	 * @param {{ prefix?: string, cursor?: string, limit?: number, delimiter?: string }} [options]
	 * @returns {Promise<{ prefix: string, objects: Object[], prefixes: string[], truncated: boolean, cursor: string|null }>}
	 */
	async listObjects(options) {
		return objectMethods(this.env, OPERATOR_SCOPE).listObjects(options);
	}
}
