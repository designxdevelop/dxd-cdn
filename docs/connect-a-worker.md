# Connecting apps and Workers to DXD CDN

DXD CDN is the shared object store for Design X Develop: Studio widgets, client marketing scripts, and anything a client Worker needs to host at a stable URL.

Heard homepage personalization (`heard-visitor-personalization` / `heard-edge`) is the reference integration:

- **Worker** (`heard.designxdevelop.com`) — APIs, config, kill switches
- **CDN** (`cdn.designxdevelop.com/heard/hp/prod/…`) — browser embed JS
- Deploying the Heard repo publishes embeds via the Objects API. You never redeploy `dxd-cdn` for a script change.

Use the same split for new client Workers.

## Key layout

```
{client}/{project}/{env}/…
```

| Key | Who |
| --- | --- |
| `heard/hp/prod/personalization.js` | Heard embed (live pointer) |
| `heard/hp/prod/personalization.{hash}.js` | Immutable snapshot |
| `dxd-studio/countdown/prod/widgets/{id}/config.json` | Studio live config |
| `acme/site/prod/hero.webp` | Client static asset |

Keep one `{client}` prefix per customer so projects cannot collide.

## 1. Publish from Node / CI (Heard pattern)

Any DXD repo can depend on `@dxd/cdn` and publish on deploy.

```ts
import { createHash } from 'node:crypto';
import {
  DEFAULT_CDN_ORIGIN,
  DxdCdnClient,
  joinKey,
} from '@dxd/cdn';

const cdn = new DxdCdnClient({
  origin: process.env.DXD_CDN_ORIGIN || DEFAULT_CDN_ORIGIN,
  uploadPassword: process.env.DXD_CDN_UPLOAD_PASSWORD!,
});

const body = readFileSync('dist/personalization.js');
const hash = createHash('sha256').update(body).digest('hex').slice(0, 12);

await cdn.publishHashedAsset({
  prefix: joinKey('heard', 'hp', 'prod'),
  liveName: 'personalization.js',
  hash,
  body,
  contentType: 'application/javascript; charset=utf-8',
});
```

Webflow / client sites keep a **stable** script tag:

```html
<script src="https://cdn.designxdevelop.com/heard/hp/prod/personalization.js" async></script>
```

Live keys use `Cache-Control: public, max-age=0, must-revalidate` on the browser **and** Cloudflare cache headers. Browsers revalidate on the next page load — no hard refresh, no `?v=` on the embed. There is no 60s edge copy of live files; each GET hits the Worker/R2 (usually a cheap `304`). Hashed snapshots stay `immutable` for rollback.

After this Worker is deployed, **republish existing live keys** (Heard `personalization.js`, Studio `config.json`, etc.). Objects already stored as `immutable` stay sticky until overwritten. Browsers that already cached those URLs as immutable also need that republish.

### Secrets

| Variable | Where |
| --- | --- |
| `DXD_CDN_UPLOAD_PASSWORD` | `.dev.vars` locally; GitHub Actions secret in CI |
| `DXD_CDN_ORIGIN` | Optional. Defaults to `https://cdn.designxdevelop.com` |

Do not give client repos R2 API tokens. The Objects API is the write path; rclone/S3 bypasses per-object cache metadata.

Until `@dxd/cdn` is on a registry:

```json
"@dxd/cdn": "file:../dxd-cdn/packages/client"
```

## 2. Bind a client Worker (no password on the Worker)

Same Cloudflare account as `dxd-cdn`. The Worker talks to CDN over a [service binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/) — nothing goes over the public internet, and `UPLOAD_PASSWORD` does not live in the client Worker.

**Binding `CdnObjects` can put/get every key in the bucket.** Only bind Workers you trust; there is no per-client prefix check.

**dxd-cdn** already exports `CdnObjects`.

**Client Worker `wrangler.toml`:**

```toml
[[services]]
binding = "DXD_CDN"
service = "dxd-cdn"
entrypoint = "CdnObjects"
```

```js
export default {
	async fetch(request, env) {
		const published = await env.DXD_CDN.putObject({
			key: 'heard/hp/prod/config.json',
			body: JSON.stringify({ ok: true }),
			contentType: 'application/json',
			// omit cacheControl → live/revalidate default
		});
		return Response.json(published);
	},
};
```

```js
const meta = await env.DXD_CDN.getObjectMeta('heard/hp/prod/config.json');
```

Public browsers still `GET https://cdn.designxdevelop.com/{key}` — they never call the RPC.

Use this when a Worker **generates** an asset at runtime (rendered HTML, per-tenant JSON). Keep using `@dxd/cdn` from Node when the file exists at build time (Heard embeds).

## 3. Read from the browser

Public GET, no auth:

```
https://cdn.designxdevelop.com/{key}
```

CORS is `*`. Mutable files revalidate; hashed files are cached for a year.

## Cache in one sentence

| Object | Browser | Cloudflare |
| --- | --- | --- |
| Live pointer (`personalization.js`, `config.json`, `/upload` files) | Revalidate every navigation (`max-age=0, must-revalidate`) | Same header; no timed edge copy |
| Hashed / versioned (`*.abc123.js`, GitHub `/:repo/:version/:file`) | 1 year `immutable` | 1 year `immutable` |

Overwrite the live key and the next navigation sees the new bytes (or a `304` if nothing changed). Do not turn on Workers Cache for live URLs until there is purge-on-PUT — a 60s edge copy would hide publishes.

See [api-objects.md](./api-objects.md) for headers and the HTTP contract.
