# Objects API (programmatic publish / pull)

Shared by every DXD app and client project. The Worker does not know about Studio, widgets, or Elfsight — it only stores and serves keyed objects with per-object `Cache-Control`.

## Auth

```
Authorization: Bearer <token>
```

Query `?password=<token>` also works.

Two kinds of token reach this API:

| Token | Scope |
| --- | --- |
| An `APP_TOKENS` entry | Only the prefixes and operations that entry grants |
| `UPLOAD_PASSWORD` | Operator: every operation, the whole bucket |

Give each app its own token. The operator secret should not travel to app CI.

### Scoped app tokens

`APP_TOKENS` is one secret holding a JSON object keyed by the **SHA-256 of each
token**, so the plaintext only ever lives in the app that uses it:

```jsonc
{
  "<sha256(token)>": { "app": "heard",  "prefixes": ["heard/"],      "ops": ["put", "get"] },
  "<sha256(token)>": { "app": "studio", "prefixes": ["dxd-studio/"], "ops": ["put", "get", "list", "delete"] }
}
```

| Field | Meaning |
| --- | --- |
| `app` | Name logged on every write by that token |
| `prefixes` | Key prefixes the token may touch. `"*"` means the whole bucket. A prefix matches at path-segment boundaries, so `heard` grants `heard/a.js` but not `heard-staging/a.js`. An exact key is a valid single-object prefix. |
| `ops` | Any of `put`, `get`, `list`, `delete`. Grant the narrowest set that works: `["put", "get"]` covers a publish pipeline, and `delete` is worth withholding from CI. |

Mint one:

```bash
node scripts/mint-app-token.mjs --app heard --prefixes heard/ --ops put,get
```

It prints the token to hand to the app and the `APP_TOKENS` entry to merge, then:

```bash
wrangler secret put APP_TOKENS      # production
# or add the one-line JSON to .dev.vars for local dev
```

An unknown token is `401`. A known token asking for a key outside its scope is
`403`. Prefix and operation checks live in `src/services/objects.js`, so the
HTTP API and the `CdnObjects` service binding cannot drift apart.

Entries that are malformed (no `app`, no `prefixes`, no recognized `ops`) are
ignored and logged. If the whole secret is unparseable, no app token works and
`UPLOAD_PASSWORD` still does — an app-token mistake cannot lock you out.

The operator routes (`/browse`, `/upload`, `/api/files`, `/api/file-stats`,
`/api/file-content`, `/api/delete-file`) accept **only** `UPLOAD_PASSWORD`; an
app token gets `401` there.

## Convention: key namespaces

```
{client}/{project}/{env}/...
```

| Example key | Owner |
| --- | --- |
| `acme/brochure/prod/hero.webp` | Client site assets |
| `dxd-studio/platform.js` | Shared Studio embed loader (one file, all products) |
| `dxd-studio/countdown/prod/widgets/{id}/config.json` | Live widget config (revalidate) |
| `dxd-studio/countdown/prod/widgets/{id}/v12.json` | Immutable publish snapshot |

Stay under a dedicated `{client}` prefix so projects never collide.

Any segment is fine, including version-shaped ones (`myapp/v1.2.3/bundle.js`,
`myapp/a1b2c3d/bundle.js`). The GitHub proxy lives under its own `/gh/` prefix
and no longer claims those keys.

## PUT `/api/objects`

Overwrite by default (needed so “publish again” updates the same live URL).

| Header | Purpose |
| --- | --- |
| `X-DXD-Object-Key` | Object key (required) |
| `Content-Type` | Stored + served content type |
| `X-DXD-Cache-Control` | One of the two policies below (omit for live default). Anything else is 400. |
| `X-DXD-Overwrite` | `true` (default) or `false` (409 if exists) |

Body: raw bytes.

**Cache policies apps should choose:**

| Use | `Cache-Control` (`X-DXD-Cache-Control`) |
| --- | --- |
| Versioned / hashed files (`v12.json`, `personalization.abc123.js`) | `public, max-age=31536000, immutable` |
| Mutable “live” pointers (`config.json`, `personalization.js`) | `public, max-age=0, must-revalidate` (this is also the PUT default) |

PUT allowlists only those two strings. Public GET honors the stored value on `Cache-Control` (what browsers see) and on `CDN-Cache-Control` / `Cloudflare-CDN-Cache-Control` (what Cloudflare sees), except for the one case in [Live objects at the edge](#live-objects-at-the-edge) below. `If-None-Match` / `If-Modified-Since` return `304` when the object is unchanged (R2 conditional GET, no body download).

Every public response carries two cache tags: `dxd-cdn:{client}` and a per-object
`dxd-cdn-key:{percent-encoded key}`. A write purges only its own key's tag, so
republishing one file does not evict a whole client's assets.

### Live objects at the edge

Workers Caching is on. Immutable snapshots get a real edge copy and request
collapsing, which is safe because an immutable key is create-only and can never
change underneath a cached response.

Live keys are governed by `LIVE_EDGE_MAX_AGE` in `wrangler.toml`:

| `LIVE_EDGE_MAX_AGE` | Browser sees | Cloudflare sees | Meaning |
| --- | --- | --- | --- |
| `0` (default) | `max-age=0, must-revalidate` | same | Every GET reaches the Worker. A republish is instantly visible. |
| `3600` | `max-age=0, must-revalidate` | `public, max-age=3600` | Cloudflare answers the browser's revalidation instead of R2. A republish relies on purge. |

Browsers always revalidate, at any setting. Raising the value trades a
dependence on purge for far fewer Worker invocations and R2 reads.

**Before raising it**, confirm purge actually works in production, because a
failed purge hides a publish for up to that long:

1. Deploy, then `PUT` a live key and read `purged` in the JSON response. The
   Worker reports `purged: true` only when Cloudflare accepted the purge.
   (`purged` is always `false` locally — the local runtime has no purge API — and
   always `false` for immutable writes, which need none.)
2. `GET` the public URL twice and watch `CF-Cache-Status` go `MISS` then `HIT`.
3. Republish and `GET` again. You must see the new bytes on the first request.

Purge draws on Cloudflare's free-tier purge rate limits regardless of plan, so a
very high write rate can get a purge rejected; those rejections are logged with
the key and surface as `purged: false`.

To roll back, set `LIVE_EDGE_MAX_AGE = 0` and deploy — no code change. The Worker
version is part of the cache key, so a deploy also starts from an empty cache.

`@dxd/cdn` exports `MUTABLE_CACHE_CONTROL`, `IMMUTABLE_CACHE_CONTROL`, and `publishHashedAsset()` (Heard-style live + hashed snapshot). Client Workers on the same Cloudflare account can skip HTTP auth and bind `CdnObjects`; see [connect-a-worker.md](./connect-a-worker.md) for the full-access and scoped forms of that binding.

Objects already stored as `immutable` (old PUT default, rclone) stay sticky in R2 until you overwrite them. Republish live keys after deploying this Worker. Browsers that already cached a URL as `immutable` will not revalidate — use a new hashed/versioned URL or purge for those clients.

## GET `/api/objects?key=…&as=meta|body`

Authenticated inspect/pull. Needs the `get` op. Browsers and embeds should use the public URL instead:

```
GET https://cdn.designxdevelop.com/{key}
```

## HEAD `/api/objects?key=…`

Existence and freshness with no body — `curl -I` friendly, and cheaper than
`as=meta` when a script only needs a status code. Needs the `get` op. Metadata
comes back in headers, since a HEAD response cannot carry JSON:

| Header | Value |
| --- | --- |
| `ETag`, `Last-Modified` | Same as the public GET |
| `X-DXD-Object-Key` | Normalized key |
| `X-DXD-Object-Size` | Bytes |
| `X-DXD-Content-Type`, `X-DXD-Cache-Control` | Stored metadata |

## DELETE `/api/objects?key=…`

Needs the `delete` op, which app tokens do not get unless you grant it. `200` with
`{ ok, key, purged }`, or `404` if there was nothing there. Purges the key's
cached response.

## GET `/api/objects/list?prefix=&cursor=&limit=&delimiter=`

Scoped, paginated listing. Needs the `list` op.

| Parameter | Meaning |
| --- | --- |
| `prefix` | Must be inside the token's scope. Optional for an operator token (whole bucket) or a token with exactly one prefix (that prefix). A multi-prefix token must say which one. |
| `cursor` | Continue from a previous page's `cursor` |
| `limit` | 1–1000, default 1000 (R2's page size) |
| `delimiter` | `/` to get folder prefixes in `prefixes` instead of every key |

```jsonc
{
  "prefix": "heard/",
  "objects": [
    { "key": "heard/hp/prod/personalization.js", "size": 2041, "uploaded": "2026-10-04T22:31:48.606Z",
      "etag": "\"…\"", "contentType": "application/javascript; charset=utf-8",
      "cacheControl": "public, max-age=0, must-revalidate" }
  ],
  "prefixes": [],
  "truncated": true,
  "cursor": "…"
}
```

Keep requesting with `cursor` while `truncated` is `true`. This is the endpoint
apps should use; `/api/files` is the operator view of the whole bucket and needs
the operator token.

## TypeScript client

Use the `@dxd/cdn` package in this repo (`packages/client`). Any DXD project (Studio, client sites, CI) depends on that — not on Studio-specific path helpers.

```ts
import { DxdCdnClient, IMMUTABLE_CACHE_CONTROL, MUTABLE_CACHE_CONTROL, publicUrl } from '@dxd/cdn';

const cdn = new DxdCdnClient({
  origin: 'https://cdn.designxdevelop.com',
  uploadPassword: process.env.DXD_CDN_UPLOAD_PASSWORD!,
});

await cdn.putObject({
  key: 'my-app/prod/data.json',
  body: JSON.stringify(payload),
  contentType: 'application/json',
  cacheControl: MUTABLE_CACHE_CONTROL,
});
```

## Elfsight-style embeds (Studio)

Snippet stays stable — **no version in the HTML**. One shared loader; widget id is on the mount node:

```html
<!-- DXD Studio Countdown | Free books -->
<script src="https://cdn.designxdevelop.com/dxd-studio/platform.js" async></script>
<div class="dxd-app-34fd47e8-15e7-4b0b-89e0-32aa4ccc5bf2" data-dxd-app-lazy></div>
```

`platform.js` discovers `.dxd-app-{publicId}` nodes and fetches that widget's `config.json`. Republish overwrites `config.json` (browsers revalidate; no version in the snippet). Immutable `v{n}.json` files remain for rollback/history.

Connecting a new Studio app or client Worker: [connect-a-worker.md](./connect-a-worker.md).
