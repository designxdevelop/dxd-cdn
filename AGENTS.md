# DXD CDN

Cloudflare Worker CDN for uploads, browsing, GitHub proxying, and direct R2 serving.

## Commands

- `npm run dev` (or `npm run start`) runs local Wrangler development.
- `npm run typecheck` checks the client package; `npm test` runs client and Worker-helper tests.
- Use `npm run deploy` only for an explicitly authorized deployment.

## Worker constraints

- Use ESM imports with explicit `.js` extensions.
- Bindings are `CDN_BUCKET`, `UPLOAD_PASSWORD`, `GITHUB_TOKEN`, and `ENVIRONMENT`.
- Keep Objects API semantics in `docs/api-objects.md`: public GET honors per-object cache control; live objects must revalidate rather than use a timed edge copy. Client Workers bind `CdnObjects`; see `docs/connect-a-worker.md`.

## Local verification

- Wrangler provides a local `CDN_BUCKET` emulator. Keep local state under the ignored `.wrangler/` directory and do not use `--remote` for local testing.
- Put `UPLOAD_PASSWORD` in ignored `.dev.vars`; protected routes and Objects writes return 401 without it. `GITHUB_TOKEN` is only required for the GitHub proxy path.
- Run local development and exercise the affected endpoint. A useful Objects smoke path is authenticated PUT, authenticated API GET, public object GET (including ETag/304 behavior), then browse UI.
