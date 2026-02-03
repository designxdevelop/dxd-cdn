/**
 * Minification service for DXD CDN
 *
 * Note: Full minification with terser/clean-css requires Node.js runtime.
 * In Cloudflare Workers environment, we use basic minification techniques.
 */

/**
 * Basic JS minification (removes comments and extra whitespace)
 * @param {string} content - JavaScript content
 * @returns {string} Minified content
 */
function basicJsMinify(content) {
	return (
		content
			// Remove single-line comments (but not URLs with //)
			.replace(/(?<!:)\/\/.*$/gm, '')
			// Remove multi-line comments
			.replace(/\/\*[\s\S]*?\*\//g, '')
			// Remove leading/trailing whitespace from lines
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.join('\n')
			// Reduce multiple newlines to single
			.replace(/\n{2,}/g, '\n')
	);
}

/**
 * Basic CSS minification (removes comments and extra whitespace)
 * @param {string} content - CSS content
 * @returns {string} Minified content
 */
function basicCssMinify(content) {
	return (
		content
			// Remove comments
			.replace(/\/\*[\s\S]*?\*\//g, '')
			// Remove whitespace around selectors and properties
			.replace(/\s*{\s*/g, '{')
			.replace(/\s*}\s*/g, '}')
			.replace(/\s*:\s*/g, ':')
			.replace(/\s*;\s*/g, ';')
			.replace(/\s*,\s*/g, ',')
			// Remove newlines and extra spaces
			.replace(/\s+/g, ' ')
			.trim()
	);
}

/**
 * Minify content based on file extension
 * @param {string} content - File content
 * @param {string} extension - File extension (js, css)
 * @returns {Promise<string>} Minified content
 */
export async function minifyContent(content, extension) {
	switch (extension) {
		case 'js':
			try {
				return basicJsMinify(content);
			} catch (error) {
				console.error('JS minification failed:', error);
				return content;
			}
		case 'css':
			try {
				return basicCssMinify(content);
			} catch (error) {
				console.error('CSS minification failed:', error);
				return content;
			}
		default:
			return content;
	}
}
