# DXD CDN

Cloudflare Worker CDN for uploads, browsing, GitHub proxying, and direct R2 serving.

## Commands

- `npm run dev` (or `npm run start`) runs local Wrangler development.
- `npm run typecheck` checks the client package; `npm test` runs the client tests plus the Worker tests, which execute inside `workerd` against a local R2 bucket.
- `./scripts/smoke.sh` exercises the documented end-to-end path against a running `npm run dev`.
- Use `npm run deploy` only for an explicitly authorized deployment.

## Worker constraints

- Use ESM imports with explicit `.js` extensions.
- Bindings are `CDN_BUCKET`, `UPLOAD_PASSWORD`, `APP_TOKENS`, `GITHUB_TOKEN`, `ENVIRONMENT`, `PUBLIC_ORIGIN`, and `LIVE_EDGE_MAX_AGE`.
- Keep Objects API semantics in `docs/api-objects.md`: public GET honors per-object cache control, and browsers always revalidate live objects. Whether Cloudflare keeps an edge copy of a live object is `LIVE_EDGE_MAX_AGE` (`0` means none); every live write purges that key's cache tag. Client Workers bind `CdnObjects`; see `docs/connect-a-worker.md`.
- Enforce token prefix and operation scopes in `src/services/objects.js`, never in a handler, so the HTTP API and the `CdnObjects` RPC entrypoint cannot drift apart.
- `api/`, `_cdn/`, and `analytics/` are reserved platform prefixes: not writable through the Objects API, not served on the public path.
- The GitHub proxy lives under `/gh/`. Every other public path is an R2 object key, and nothing may infer a route from the shape of a key.

## Local verification

- Wrangler provides a local `CDN_BUCKET` emulator. Keep local state under the ignored `.wrangler/` directory and do not use `--remote` for local testing.
- Put `UPLOAD_PASSWORD` in ignored `.dev.vars`; protected routes and Objects writes return 401 without it. Add an `APP_TOKENS` line there to exercise scoped tokens (`node scripts/mint-app-token.mjs` prints the entry). `GITHUB_TOKEN` is only required for the GitHub proxy path.
- Run local development and exercise the affected endpoint. A useful Objects smoke path is authenticated PUT, authenticated API GET, public object GET (including ETag/304 behavior), then browse UI.
- Workers Caching has no local implementation: `cache.purge()` is absent under `wrangler dev` and in tests, so purge-on-write can only be confirmed against a deployed Worker.
