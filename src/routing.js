/**
 * Public path routing. Every path is an R2 object key except the explicit
 * GitHub-proxy prefix, so a key like `myapp/v1.2.3/bundle.js` is never guessed
 * to be a GitHub request and never loses its stored Cache-Control.
 */

export const GITHUB_PROXY_PREFIX = 'gh';

/** Methods the public object and GitHub-proxy paths answer. */
export const PUBLIC_READ_METHODS = ['GET', 'HEAD'];

/**
 * Release tag, semver, or commit hash — the shape legacy GitHub-proxy URLs use.
 * @param {string} segment
 * @returns {boolean}
 */
export function isGitHubVersionSegment(segment) {
	if (!segment) return false;
	if (segment === 'latest') return true;
	if (/^v?\d+\.\d+(\.\d+)?(-[a-zA-Z0-9.]+)?$/.test(segment)) return true;
	return /^[a-f0-9]{7,40}$/.test(segment);
}

/**
 * @param {string} path Pathname without its leading slash.
 * @returns {boolean}
 */
export function isGitHubProxyPath(path) {
	return path === GITHUB_PROXY_PREFIX || path.startsWith(`${GITHUB_PROXY_PREFIX}/`);
}

/**
 * @param {string} path Pathname without its leading slash, including the `gh/` prefix.
 * @returns {{ repo: string, version: string, filePath: string } | null}
 */
export function parseGitHubProxyPath(path) {
	if (!isGitHubProxyPath(path)) return null;
	const [, repo, version, ...rest] = path.split('/');
	const filePath = rest.join('/');
	if (!repo || !version || !filePath) return null;
	return { repo, version, filePath };
}

/**
 * Pre-`/gh/` URL shape (`/:repo/:version/:file`). Only consulted when R2 has no
 * object at the key, so an object always wins over the legacy guess.
 * @param {string} path Pathname without its leading slash.
 * @returns {string|null} The `/gh/`-prefixed pathname, or null if the shape does not match.
 */
export function legacyGitHubProxyPathname(path) {
	if (isGitHubProxyPath(path)) return null;
	const segments = path.split('/');
	if (segments.length < 3) return null;
	if (!isGitHubVersionSegment(segments[1])) return null;
	return `/${GITHUB_PROXY_PREFIX}/${path}`;
}
