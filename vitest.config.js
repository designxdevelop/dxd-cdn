import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.toml' },
			miniflare: {
				bindings: {
					UPLOAD_PASSWORD: 'test-upload-password',
				},
			},
		}),
	],
	test: {
		include: ['src/**/*.test.js'],
	},
});
