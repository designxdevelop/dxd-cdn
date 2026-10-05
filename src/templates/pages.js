import { DEFAULT_GITHUB_OWNER } from '../config/constants.js';
import { uncachedHtmlHeaders } from '../utils/cache.js';
import portalHtml from './html/portal.html';
import speedTestHtml from './html/speed-test.html';

export function handleSpecialPages(path) {
	const html = path === 'speed-test' ? speedTestHtml : portalHtml;

	// Replace template variables
	const processedHtml = html.replace(/{{DEFAULT_GITHUB_OWNER}}/g, DEFAULT_GITHUB_OWNER);

	return new Response(processedHtml, { headers: uncachedHtmlHeaders() });
}
