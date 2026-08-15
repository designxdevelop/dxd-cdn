import { DEFAULT_GITHUB_OWNER, GITHUB_CACHE_TTL } from '../config/constants.js';
import { minifyContent } from './minification.js';

const GITHUB_CACHE = new Map();
const MAX_GITHUB_REDIRECTS = 5;

/**
 * @param {string} hostname
 * @returns {boolean}
 */
export function isAllowedGithubHost(hostname) {
	if (!hostname) return false;
	const host = hostname.toLowerCase();
	return host === 'github.com' || host.endsWith('.github.com') || host === 'githubusercontent.com' || host.endsWith('.githubusercontent.com');
}

/**
 * Follow GitHub redirects without dropping Authorization on cross-origin hops.
 * @param {string} url
 * @param {Object} env
 * @returns {Promise<Response>}
 */
export async function fetchGithub(url, env) {
	const headers = {
		'User-Agent': 'DXD-CDN',
		Authorization: `token ${env.GITHUB_TOKEN}`,
	};

	let current = url;
	for (let hop = 0; hop <= MAX_GITHUB_REDIRECTS; hop++) {
		const response = await fetch(current, { headers, redirect: 'manual' });
		if (response.status < 300 || response.status >= 400) {
			return response;
		}

		const location = response.headers.get('Location');
		if (!location) return response;

		const next = new URL(location, current);
		if (!isAllowedGithubHost(next.hostname)) {
			throw new Error(`Blocked GitHub redirect to ${next.hostname}`);
		}
		current = next.toString();
	}

	throw new Error('Too many GitHub redirects');
}

export async function getCommit(repo, commit, env) {
	const response = await fetchGithub(`https://api.github.com/repos/${DEFAULT_GITHUB_OWNER}/${repo}/commits/${commit}`, env);

	if (!response.ok) {
		throw new Error('Invalid commit hash');
	}

	const data = await response.json();
	return {
		fullHash: data.sha,
		shortHash: commit,
	};
}

export async function getLatestRelease(repo, env) {
	const cacheKey = `${DEFAULT_GITHUB_OWNER}/${repo}`;
	const now = Date.now();

	if (GITHUB_CACHE.has(cacheKey)) {
		const cached = GITHUB_CACHE.get(cacheKey);
		if (now - cached.timestamp < GITHUB_CACHE_TTL) {
			return cached.data;
		}
	}

	const response = await fetchGithub(`https://api.github.com/repos/${DEFAULT_GITHUB_OWNER}/${repo}/releases/latest`, env);

	if (!response.ok) {
		throw new Error('Failed to fetch release data from GitHub');
	}

	const data = await response.json();

	GITHUB_CACHE.set(cacheKey, {
		timestamp: now,
		data: data,
	});

	return data;
}

export async function getFileFromGitHub(repo, version, filePath, env, ctx, shouldMinify = false) {
	let targetVersion = version;
	let actualVersion = version;
	let isCommit = false;

	if (version === 'latest') {
		const release = await getLatestRelease(repo, env);
		targetVersion = release.tag_name;
		actualVersion = targetVersion;
	} else if (version.length >= 7) {
		try {
			const commit = await getCommit(repo, version, env);
			targetVersion = commit.fullHash;
			actualVersion = version.substring(0, 7);
			isCommit = true;
		} catch (error) {
			targetVersion = version;
			actualVersion = version;
		}
	}

	if (!isCommit) {
		targetVersion = targetVersion.replace(/^v/, '');
	}

	const rawUrl = isCommit
		? `https://raw.githubusercontent.com/${DEFAULT_GITHUB_OWNER}/${repo}/${targetVersion}/${filePath}`
		: `https://raw.githubusercontent.com/${DEFAULT_GITHUB_OWNER}/${repo}/v${targetVersion}/${filePath}`;

	const response = await fetchGithub(rawUrl, env);

	if (!response.ok) {
		throw new Error('Failed to fetch file from GitHub');
	}

	const content = await response.text();
	const extension = filePath.split('.').pop().toLowerCase();

	return shouldMinify ? await minifyContent(content, extension) : content;
}
