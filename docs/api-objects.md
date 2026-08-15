# Objects API (programmatic publish / pull)

Shared by every DXD app and client project. The Worker does not know about Studio, widgets, or Elfsight — it only stores and serves keyed objects with per-object `Cache-Control`.

## Auth

```
Authorization: Bearer <UPLOAD_PASSWORD>
```

Query `?password=` also works (same secret as `/upload`).

## Convention: key namespaces

```
{client}/{project}/{env}/...
```

| Example key | Owner |
| --- | --- |
| `acme/brochure/prod/hero.webp` | Client site assets |
| `dxd-studio/platform.js` | Shared Studio embed loader (one file, all products) |
| `dxd-studio/countdown/prod/widgets/{id}/config.json` | Live widget config (short TTL) |
| `dxd-studio/countdown/prod/widgets/{id}/v12.json` | Immutable publish snapshot |

Stay under a dedicated `{client}` prefix so projects never collide.

## PUT `/api/objects`

Overwrite by default (needed so “publish again” updates the same live URL).

| Header | Purpose |
| --- | --- |
| `X-DXD-Object-Key` | Object key (required) |
| `Content-Type` | Stored + served content type |
| `X-DXD-Cache-Control` | Stored on the object; honored on public GET |
| `X-DXD-Overwrite` | `true` (default) or `false` (409 if exists) |

Body: raw bytes.

**Cache policies apps should choose:**

| Use | `Cache-Control` (`X-DXD-Cache-Control`) |
| --- | --- |
| Versioned / hashed files (`v12.json`, `personalization.abc123.js`) | `public, max-age=31536000, immutable` |
| Mutable “live” pointers (`config.json`, `personalization.js`) | `public, max-age=0, must-revalidate` (this is also the PUT default) |

Public GET honors the stored value for **all** of `Cache-Control`, `CDN-Cache-Control`, and `Cloudflare-CDN-Cache-Control`. Live defaults revalidate (`max-age=0, must-revalidate`); hashed snapshots are `immutable`. `If-None-Match` returns `304` when the object is unchanged (R2 conditional GET, no body download).

`@dxd/cdn` exports `MUTABLE_CACHE_CONTROL`, `IMMUTABLE_CACHE_CONTROL`, and `publishHashedAsset()` (Heard-style live + hashed snapshot). Client Workers on the same Cloudflare account can skip HTTP auth and bind `CdnObjects` — that binding can write **any** key in the bucket; see [connect-a-worker.md](./connect-a-worker.md).

Objects already stored as `immutable` (old PUT default, rclone) stay sticky until you overwrite them. Republish live keys after deploying this Worker.

## GET `/api/objects?key=…&as=meta|body`

Authenticated inspect/pull. Browsers and embeds should use the public URL instead:

```
GET https://cdn.designxdevelop.com/{key}
```

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
