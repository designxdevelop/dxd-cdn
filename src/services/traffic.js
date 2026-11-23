/**
 * Real traffic, from Cloudflare's own analytics.
 *
 * The Worker's request counters only see requests that reach the Worker, so
 * anything answered from the edge cache is invisible to them. Cloudflare's
 * GraphQL Analytics API counts every request to the hostname, cached or not.
 *
 * Config:
 *   CF_ZONE_ID          wrangler.toml var, the zone's id (not a secret)
 *   CF_ANALYTICS_TOKEN  secret, an API token with Zone > Analytics > Read on
 *                       that zone and nothing else
 *
 * With either missing the panel says traffic is not connected and everything
 * else keeps working. The token never leaves the Worker.
 */

import { publicOrigin } from './objects.js';

const ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Ranges the panel offers. Hourly bars for a day, daily bars beyond that. */
const RANGES = {
	'24h': { buckets: 24, step: HOUR_MS, dimension: 'datetimeHour' },
	'7d': { buckets: 7, step: DAY_MS, dimension: 'date' },
	'30d': { buckets: 30, step: DAY_MS, dimension: 'date' },
};

/** Cloudflare's own endpoints on the hostname, and the panel itself, are not CDN traffic. */
const NOT_FILES = /^\/(admin|api|cdn-cgi)(\/|$)/;

/** Cache statuses that mean the edge answered without the Worker. */
const SERVED_FROM_CACHE = new Set(['hit', 'stale', 'revalidated', 'updating']);

/**
 * @param {Object} env
 * @returns {{ zone: string, token: string, host: string } | null}
 */
export function trafficConfig(env) {
	const zone = String(env.CF_ZONE_ID || '')
		.trim()
		.toLowerCase();
	const token = String(env.CF_ANALYTICS_TOKEN || '').trim();
	if (!/^[0-9a-f]{32}$/.test(zone) || !token) return null;
	return { zone, token, host: new URL(publicOrigin(env)).hostname };
}

/**
 * Values are written into the query as JSON literals. Every one of them is
 * made here (ids from config, times from the clock), never taken from a request.
 */
function filter(config, since, until, extra = '') {
	return `{ clientRequestHTTPHost: ${JSON.stringify(config.host)}, requestSource: "eyeball", datetime_geq: ${JSON.stringify(since)}, datetime_lt: ${JSON.stringify(until)}${extra} }`;
}

async function run(config, body) {
	const response = await fetch(ENDPOINT, {
		method: 'POST',
		headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ query: `{ viewer { zones(filter: { zoneTag: ${JSON.stringify(config.zone)} }) { ${body} } } }` }),
	});
	let payload = null;
	try {
		payload = await response.json();
	} catch {
		payload = null;
	}
	const message = payload?.errors?.[0]?.message;
	if (message) throw new Error(message);
	if (!response.ok) throw new Error(`Cloudflare analytics answered ${response.status}`);
	const zone = payload?.data?.viewer?.zones?.[0];
	if (!zone) throw new Error('Cloudflare analytics returned nothing for this zone. Check CF_ZONE_ID and the token.');
	return zone;
}

/**
 * @param {Object} env
 * @param {string} rangeName
 * @param {number} [now]
 * @returns {Promise<Object>}
 */
export async function loadTraffic(env, rangeName, now = Date.now()) {
	const config = trafficConfig(env);
	if (!config) return { connected: false };

	const name = RANGES[rangeName] ? rangeName : '24h';
	const range = RANGES[name];
	const end = Math.floor(now / range.step) * range.step + range.step;
	const start = end - range.buckets * range.step;
	const where = (extra) => filter(config, new Date(start).toISOString(), new Date(end).toISOString(), extra);

	let zone;
	try {
		zone = await run(
			config,
			`
			series: httpRequestsAdaptiveGroups(limit: 1000, filter: ${where()}, orderBy: [${range.dimension}_ASC]) { count sum { edgeResponseBytes } dimensions { bucket: ${range.dimension} } }
			paths: httpRequestsAdaptiveGroups(limit: 40, filter: ${where()}, orderBy: [count_DESC]) { count sum { edgeResponseBytes } dimensions { path: clientRequestPath } }
			cache: httpRequestsAdaptiveGroups(limit: 30, filter: ${where()}, orderBy: [count_DESC]) { count dimensions { status: cacheStatus } }
			missing: httpRequestsAdaptiveGroups(limit: 30, filter: ${where(', edgeResponseStatus: 404')}, orderBy: [count_DESC]) { count dimensions { path: clientRequestPath } }
			`,
		);
	} catch (error) {
		console.error('Traffic query failed', { error: error.message });
		return { connected: true, range: name, error: error.message };
	}

	const byBucket = new Map();
	for (const row of zone.series || []) {
		const time = Date.parse(row.dimensions.bucket);
		byBucket.set(time, { requests: row.count, bytes: row.sum?.edgeResponseBytes || 0 });
	}
	const series = [];
	for (let time = start; time < end; time += range.step) {
		const found = byBucket.get(time) || { requests: 0, bytes: 0 };
		series.push({ t: new Date(time).toISOString(), ...found });
	}

	const requests = series.reduce((sum, point) => sum + point.requests, 0);
	const bytes = series.reduce((sum, point) => sum + point.bytes, 0);
	const cached = (zone.cache || [])
		.filter((row) => SERVED_FROM_CACHE.has(String(row.dimensions.status).toLowerCase()))
		.reduce((sum, row) => sum + row.count, 0);
	const files = (rows) => (rows || []).filter((row) => !NOT_FILES.test(row.dimensions.path));

	return {
		connected: true,
		range: name,
		hourly: range.step === HOUR_MS,
		series,
		totals: { requests, bytes, cached },
		top: files(zone.paths)
			.slice(0, 20)
			.map((row) => ({ path: row.dimensions.path, requests: row.count, bytes: row.sum?.edgeResponseBytes || 0 })),
		missing: files(zone.missing)
			.slice(0, 15)
			.map((row) => ({ path: row.dimensions.path, requests: row.count })),
	};
}

/** How far back the clean-up view asks Cloudflare which paths were requested. */
export const REQUESTED_PATHS_DAYS = 30;
const REQUESTED_PATHS_LIMIT = 10000;

/**
 * Every path requested on the hostname in the last 30 days, for the clean-up
 * view. Null when traffic is not connected.
 * @param {Object} env
 * @param {number} [now]
 * @returns {Promise<{ days: number, paths: string[], complete: boolean } | { error: string } | null>}
 */
export async function requestedPaths(env, now = Date.now()) {
	const config = trafficConfig(env);
	if (!config) return null;
	const since = new Date(now - REQUESTED_PATHS_DAYS * DAY_MS).toISOString();
	const until = new Date(now + HOUR_MS).toISOString();
	try {
		const zone = await run(
			config,
			`paths: httpRequestsAdaptiveGroups(limit: ${REQUESTED_PATHS_LIMIT}, filter: ${filter(config, since, until)}, orderBy: [count_DESC]) { count dimensions { path: clientRequestPath } }`,
		);
		const paths = (zone.paths || []).map((row) => row.dimensions.path);
		return { days: REQUESTED_PATHS_DAYS, paths, complete: paths.length < REQUESTED_PATHS_LIMIT };
	} catch (error) {
		console.error('Requested-paths query failed', { error: error.message });
		return { error: error.message };
	}
}
