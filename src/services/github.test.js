import { afterEach, describe, expect, test, vi } from 'vitest';
import { fetchGithub, isAllowedGithubHost } from './github.js';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('isAllowedGithubHost', () => {
	test('allows GitHub and GitHubusercontent hosts', () => {
		expect(isAllowedGithubHost('github.com')).toBe(true);
		expect(isAllowedGithubHost('api.github.com')).toBe(true);
		expect(isAllowedGithubHost('raw.githubusercontent.com')).toBe(true);
		expect(isAllowedGithubHost('objects.githubusercontent.com')).toBe(true);
		expect(isAllowedGithubHost('evil.com')).toBe(false);
		expect(isAllowedGithubHost('notgithub.com')).toBe(false);
	});
});

describe('fetchGithub', () => {
	test('re-attaches Authorization on a GitHubusercontent redirect', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(null, {
					status: 302,
					headers: { Location: 'https://raw.githubusercontent.com/owner/repo/main/file.js' },
				}),
			)
			.mockResolvedValueOnce(new Response('ok', { status: 200 }));

		vi.stubGlobal('fetch', fetchMock);

		const response = await fetchGithub('https://github.com/owner/repo/raw/main/file.js', { GITHUB_TOKEN: 'secret' });
		expect(await response.text()).toBe('ok');
		expect(fetchMock).toHaveBeenCalledTimes(2);

		const first = fetchMock.mock.calls[0];
		const second = fetchMock.mock.calls[1];
		expect(first[1].redirect).toBe('manual');
		expect(first[1].headers.Authorization).toBe('token secret');
		expect(second[0]).toBe('https://raw.githubusercontent.com/owner/repo/main/file.js');
		expect(second[1].headers.Authorization).toBe('token secret');
	});

	test('refuses redirects off GitHub', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(null, {
					status: 302,
					headers: { Location: 'https://evil.example/steal' },
				}),
			),
		);

		await expect(fetchGithub('https://api.github.com/repos/a/b', { GITHUB_TOKEN: 'secret' })).rejects.toThrow(
			/Blocked GitHub redirect/,
		);
	});
});
