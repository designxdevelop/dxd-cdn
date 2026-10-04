import { describe, expect, test } from 'vitest';
import { isGitHubProxyPath, isGitHubVersionSegment, legacyGitHubProxyPathname, parseGitHubProxyPath } from './routing.js';

describe('isGitHubVersionSegment', () => {
	test('matches release tags, semver, and commit hashes', () => {
		expect(isGitHubVersionSegment('latest')).toBe(true);
		expect(isGitHubVersionSegment('v1.0.0')).toBe(true);
		expect(isGitHubVersionSegment('1.2')).toBe(true);
		expect(isGitHubVersionSegment('v2.0.0-beta.1')).toBe(true);
		expect(isGitHubVersionSegment('a1b2c3d')).toBe(true);
	});

	test('does not match ordinary path segments', () => {
		expect(isGitHubVersionSegment('prod')).toBe(false);
		expect(isGitHubVersionSegment('site')).toBe(false);
		expect(isGitHubVersionSegment('')).toBe(false);
		expect(isGitHubVersionSegment('abc123')).toBe(false);
	});
});

describe('parseGitHubProxyPath', () => {
	test('splits repo, version, and file path', () => {
		expect(parseGitHubProxyPath('gh/my-project/v1.0.0/dist/script.js')).toEqual({
			repo: 'my-project',
			version: 'v1.0.0',
			filePath: 'dist/script.js',
		});
	});

	test('requires all three parts', () => {
		expect(parseGitHubProxyPath('gh')).toBeNull();
		expect(parseGitHubProxyPath('gh/my-project')).toBeNull();
		expect(parseGitHubProxyPath('gh/my-project/v1.0.0')).toBeNull();
		expect(parseGitHubProxyPath('gh/my-project/v1.0.0/')).toBeNull();
	});

	test('ignores paths outside the prefix', () => {
		expect(parseGitHubProxyPath('my-project/v1.0.0/dist/script.js')).toBeNull();
		expect(parseGitHubProxyPath('ghost/v1.0.0/dist/script.js')).toBeNull();
		expect(isGitHubProxyPath('ghost/v1.0.0/a.js')).toBe(false);
	});
});

describe('legacyGitHubProxyPathname', () => {
	test('maps the pre-/gh/ shape onto the prefix', () => {
		expect(legacyGitHubProxyPathname('my-project/v1.0.0/dist/script.js')).toBe('/gh/my-project/v1.0.0/dist/script.js');
		expect(legacyGitHubProxyPathname('my-project/latest/dist/script.min.js')).toBe('/gh/my-project/latest/dist/script.min.js');
	});

	test('leaves ordinary object keys alone', () => {
		expect(legacyGitHubProxyPathname('acme/site/prod/hero.webp')).toBeNull();
		expect(legacyGitHubProxyPathname('dxd-studio/platform.js')).toBeNull();
		expect(legacyGitHubProxyPathname('my-project/v1.0.0')).toBeNull();
	});

	test('does not redirect a path that is already prefixed', () => {
		expect(legacyGitHubProxyPathname('gh/my-project/v1.0.0/dist/script.js')).toBeNull();
	});
});
