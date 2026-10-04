import { describe, expect, test } from 'vitest';
import { MAX_LIST_PAGES, getFilesList, listAllKeys } from './files.js';

/**
 * R2 semantics that matter here: `list` returns at most `limit` keys (1000 max)
 * and sets `truncated` with a `cursor` when there are more.
 * @param {string[]} keys
 */
function bucketWith(keys) {
	const sorted = [...keys].sort();
	return {
		calls: [],
		async list(options = {}) {
			this.calls.push(options);
			const prefix = options.prefix || '';
			const matching = sorted.filter((key) => key.startsWith(prefix));
			const limit = options.limit || 1000;
			const start = options.cursor ? Number(options.cursor) : 0;
			const page = matching.slice(start, start + limit);
			const next = start + page.length;
			return {
				objects: page.map((key) => ({ key })),
				truncated: next < matching.length,
				cursor: String(next),
			};
		},
	};
}

function bulkKeys(count, prefix = 'bulk/app/prod') {
	return Array.from({ length: count }, (_, index) => `${prefix}/file-${String(index).padStart(5, '0')}.txt`);
}

describe('listAllKeys', () => {
	test('follows the cursor past R2 one-page limit', async () => {
		const bucket = bucketWith(bulkKeys(1110));
		const result = await listAllKeys(bucket, '');

		expect(result.keys).toHaveLength(1110);
		expect(result.truncated).toBe(false);
		expect(bucket.calls.length).toBe(2);
	});

	test('a single page needs a single call', async () => {
		const bucket = bucketWith(bulkKeys(10));
		const result = await listAllKeys(bucket, '');

		expect(result.keys).toHaveLength(10);
		expect(bucket.calls.length).toBe(1);
	});

	test('reports truncation instead of looping forever', async () => {
		const bucket = bucketWith(bulkKeys(5000));
		const result = await listAllKeys(bucket, '', 2);

		expect(result.keys).toHaveLength(2000);
		expect(result.truncated).toBe(true);
		expect(bucket.calls.length).toBe(2);
	});

	test('passes the prefix through to R2 rather than filtering afterwards', async () => {
		const bucket = bucketWith(['heard/a.js', 'heard/b.js', 'acme/c.js']);
		const result = await listAllKeys(bucket, 'heard/');

		expect(result.keys).toEqual(['heard/a.js', 'heard/b.js']);
		expect(bucket.calls[0].prefix).toBe('heard/');
	});

	test('defaults to a bounded number of pages', () => {
		expect(MAX_LIST_PAGES).toBeGreaterThan(1);
	});
});

describe('getFilesList', () => {
	test('returns every file past the first page, and the facets that go with them', async () => {
		const bucket = bucketWith([...bulkKeys(1110), 'acme/site/prod/hero.webp', 'heard/hp/staging/a.js']);
		const result = await getFilesList(bucket);

		expect(result.files).toHaveLength(1112);
		expect(result.files).toContain('bulk/app/prod/file-01099.txt');
		expect(result.truncated).toBe(false);
		expect(result.clients).toEqual(['acme', 'bulk', 'heard']);
		expect(result.projects).toEqual(['acme/site', 'bulk/app', 'heard/hp']);
		expect(result.envs).toEqual(['prod', 'staging']);
	});

	test('still hides analytics keys', async () => {
		const bucket = bucketWith(['acme/site/prod/a.js', 'analytics/acme/site/prod/a.js.json']);
		const result = await getFilesList(bucket);

		expect(result.files).toEqual(['acme/site/prod/a.js']);
	});

	test('reports truncation so a short listing cannot look complete', async () => {
		const bucket = {
			async list() {
				return { objects: bulkKeys(1000).map((key) => ({ key })), truncated: true, cursor: 'more' };
			},
		};
		const result = await getFilesList(bucket);

		expect(result.truncated).toBe(true);
		expect(result.scanned).toBe(1000 * MAX_LIST_PAGES);
	});

	test('a list failure is an empty answer, not a thrown error', async () => {
		const bucket = {
			async list() {
				throw new Error('R2 unavailable');
			},
		};
		expect(await getFilesList(bucket)).toEqual({ files: [], clients: [], projects: [], envs: [], scanned: 0, truncated: false });
	});
});
