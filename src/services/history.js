/**
 * What happened to the bucket, and the copies needed to undo it.
 *
 * Two kinds of bookkeeping, both under the reserved `_cdn/` prefix so no app
 * token can write or forge them and the public path never serves them:
 *
 *   _cdn/activity/<id>         one empty object per change; the event itself is
 *                              the object's custom metadata, so a single `list`
 *                              returns a page of history with no further reads
 *   _cdn/versions/<key>?<id>   the copy a replace or delete pushed out. `?`
 *                              cannot appear in an object key, so one key's
 *                              versions never mix with another's
 *
 * Ids start with a reversed millisecond timestamp, so R2's alphabetical listing
 * is newest first.
 *
 * All of this is bookkeeping: a failure here is logged and never fails the
 * write it describes.
 */

import { ACTIVITY_KEY_PREFIX, VERSIONS_KEY_PREFIX } from '../config/constants.js';

const MAX_STAMP = 9999999999999;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Copies kept per key. Older ones are removed as new ones arrive. */
export const VERSIONS_KEPT = 5;
/** How long a kept copy stays restorable. */
export const VERSION_RETENTION_DAYS = 30;
/** How far back the activity log goes. */
export const ACTIVITY_RETENTION_DAYS = 180;
/** Above this a replace or delete does not keep the outgoing copy. */
export const VERSION_MAX_BYTES = 100 * 1024 * 1024;

export const VERSION_ID = /^\d{13}-[0-9a-f]{8}$/;
const ACTIVITY_PAGE_SIZE = 100;

function stamp(time) {
	return String(MAX_STAMP - time).padStart(13, '0');
}

function newId() {
	const random = [...crypto.getRandomValues(new Uint8Array(4))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
	return `${stamp(Date.now())}-${random}`;
}

/** @param {string} id @returns {string} ISO time the id was made. */
function idTime(id) {
	return new Date(MAX_STAMP - Number(id.slice(0, 13))).toISOString();
}

/** Custom metadata travels in headers, so keep values ASCII and short. */
function pack(value) {
	return encodeURI(String(value)).slice(0, 1500);
}

function unpack(value) {
	if (typeof value !== 'string') return '';
	try {
		return decodeURI(value);
	} catch {
		return value;
	}
}

/**
 * @param {string} key
 * @param {string} id
 * @returns {string}
 */
export function versionKey(key, id) {
	return `${VERSIONS_KEY_PREFIX}${key}?${id}`;
}

/**
 * @param {Object} env
 * @param {{ actor: string, action: string, key: string, to?: string, size?: number, version?: string|null }} event
 * @returns {Promise<void>}
 */
export async function recordActivity(env, event) {
	try {
		const customMetadata = { actor: pack(event.actor), action: pack(event.action), key: pack(event.key) };
		if (event.to) customMetadata.to = pack(event.to);
		if (Number.isFinite(event.size)) customMetadata.size = String(event.size);
		if (event.version) customMetadata.version = event.version;
		await env.CDN_BUCKET.put(`${ACTIVITY_KEY_PREFIX}${newId()}`, '', { customMetadata });
	} catch (error) {
		console.error('Activity not recorded', { action: event.action, key: event.key, error: error.message });
	}
}

/**
 * One page of history, newest first.
 * @param {Object} env
 * @param {string} [cursor]
 * @returns {Promise<{ events: Array<{ at: string, actor: string, action: string, key: string, to: string|null, size: number|null, version: string|null }>, cursor: string|null }>}
 */
export async function listActivity(env, cursor) {
	const page = await env.CDN_BUCKET.list({
		prefix: ACTIVITY_KEY_PREFIX,
		cursor: cursor || undefined,
		limit: ACTIVITY_PAGE_SIZE,
		include: ['customMetadata'],
	});
	const events = page.objects.map((object) => {
		const meta = object.customMetadata || {};
		return {
			at: idTime(object.key.slice(ACTIVITY_KEY_PREFIX.length)),
			actor: unpack(meta.actor),
			action: unpack(meta.action),
			key: unpack(meta.key),
			to: meta.to ? unpack(meta.to) : null,
			size: meta.size ? Number(meta.size) : null,
			version: meta.version || null,
		};
	});
	return { events, cursor: page.truncated ? page.cursor : null };
}

/**
 * Keep the copy currently at `key` before it is replaced or deleted.
 * @param {Object} env
 * @param {string} key
 * @param {string} actor
 * @param {'replaced'|'deleted'} reason
 * @param {{ prune?: boolean }} [options]
 * @returns {Promise<{ id: string|null, size: number } | null>} null when nothing was there. `id` is null when the copy was not kept.
 */
export async function snapshotVersion(env, key, actor, reason, options = {}) {
	let current;
	try {
		current = await env.CDN_BUCKET.get(key);
	} catch (error) {
		console.error('Version not kept', { key, error: error.message });
		return null;
	}
	if (!current) return null;

	try {
		if (current.size > VERSION_MAX_BYTES) {
			await current.body.cancel();
			return { id: null, size: current.size };
		}
		const id = newId();
		await env.CDN_BUCKET.put(versionKey(key, id), current.body, {
			httpMetadata: current.httpMetadata,
			customMetadata: { by: pack(actor), reason },
		});
		if (options.prune !== false) await pruneVersions(env, key);
		return { id, size: current.size };
	} catch (error) {
		console.error('Version not kept', { key, error: error.message });
		return { id: null, size: current.size };
	}
}

/**
 * Drop all but the newest copies of one key.
 * @param {Object} env
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function pruneVersions(env, key) {
	try {
		const page = await env.CDN_BUCKET.list({ prefix: versionKey(key, ''), limit: 100 });
		const extra = page.objects.slice(VERSIONS_KEPT).map((object) => object.key);
		if (extra.length) await env.CDN_BUCKET.delete(extra);
	} catch (error) {
		console.error('Old versions not pruned', { key, error: error.message });
	}
}

/**
 * @param {Object} env
 * @param {string} key
 * @returns {Promise<Array<{ id: string, at: string, by: string, reason: string, size: number, type: string|null }>>} Newest first.
 */
export async function listVersions(env, key) {
	const prefix = versionKey(key, '');
	const page = await env.CDN_BUCKET.list({ prefix, limit: 100, include: ['customMetadata', 'httpMetadata'] });
	return page.objects
		.map((object) => ({ object, id: object.key.slice(prefix.length) }))
		.filter(({ id }) => VERSION_ID.test(id))
		.map(({ object, id }) => ({
			id,
			at: idTime(id),
			by: unpack(object.customMetadata?.by),
			reason: object.customMetadata?.reason === 'deleted' ? 'deleted' : 'replaced',
			size: object.size,
			type: object.httpMetadata?.contentType || null,
		}));
}

/**
 * Nightly clean-up (the cron trigger in wrangler.toml): expire kept copies and
 * old history so neither grows without bound.
 * @param {Object} env
 * @param {number} [now]
 * @returns {Promise<{ versions: number, events: number }>}
 */
export async function pruneHistory(env, now = Date.now()) {
	const removed = { versions: 0, events: 0 };

	// Versions sort by object key first, so every one has to be looked at.
	const versionCutoff = stamp(now - VERSION_RETENTION_DAYS * DAY_MS);
	let cursor;
	for (let page = 0; page < 20; page++) {
		const listed = await env.CDN_BUCKET.list({ prefix: VERSIONS_KEY_PREFIX, cursor, limit: 1000 });
		const expired = listed.objects
			.map((object) => object.key)
			.filter((key) => {
				const id = key.slice(key.lastIndexOf('?') + 1);
				return VERSION_ID.test(id) && id.slice(0, 13) > versionCutoff;
			});
		if (expired.length) await env.CDN_BUCKET.delete(expired);
		removed.versions += expired.length;
		if (!listed.truncated) break;
		cursor = listed.cursor;
	}

	// Activity ids are the whole name, so everything past the cut-off is expired.
	const startAfter = `${ACTIVITY_KEY_PREFIX}${stamp(now - ACTIVITY_RETENTION_DAYS * DAY_MS)}`;
	for (let page = 0; page < 20; page++) {
		const listed = await env.CDN_BUCKET.list({ prefix: ACTIVITY_KEY_PREFIX, startAfter, limit: 1000 });
		if (!listed.objects.length) break;
		await env.CDN_BUCKET.delete(listed.objects.map((object) => object.key));
		removed.events += listed.objects.length;
		if (!listed.truncated) break;
	}

	console.log('history pruned', removed);
	return removed;
}
