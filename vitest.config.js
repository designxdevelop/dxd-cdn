import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.toml' },
			miniflare: {
				bindings: {
					UPLOAD_PASSWORD: 'test-upload-password',
					// Pinned so the suite tests cache behavior rather than whatever
					// production currently ships. Tests that care about a non-zero
					// edge TTL set env.LIVE_EDGE_MAX_AGE themselves.
					LIVE_EDGE_MAX_AGE: 0,
				},
			},
		}),
	],
	test: {
		include: ['src/**/*.test.js'],
	},
});
