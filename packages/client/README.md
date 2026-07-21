# @dxd/cdn

Shared TypeScript client for [cdn.designxdevelop.com](https://cdn.designxdevelop.com).

Use this from **any** DXD project (Studio, client sites, GitHub Actions). Do not fork a Studio-only client.

## Install (local)

Until published to a registry:

```json
"@dxd/cdn": "file:../dxd-cdn/packages/client"
```

(adjust relative path from the consuming repo).

## Usage

```ts
import {
  DxdCdnClient,
  DEFAULT_CDN_ORIGIN,
  IMMUTABLE_CACHE_CONTROL,
  MUTABLE_CACHE_CONTROL,
  joinKey,
} from '@dxd/cdn';

const cdn = new DxdCdnClient({
  origin: DEFAULT_CDN_ORIGIN,
  uploadPassword: process.env.DXD_CDN_UPLOAD_PASSWORD!,
});

const prefix = joinKey('my-client', 'my-project', 'prod', 'widgets', widgetId);

await cdn.publishVersioned({
  prefix,
  version: 3,
  body: JSON.stringify(config),
  contentType: 'application/json',
  immutableCacheControl: IMMUTABLE_CACHE_CONTROL,
  mutableCacheControl: MUTABLE_CACHE_CONTROL,
});
```

See [docs/api-objects.md](../../docs/api-objects.md) for the Worker contract and Elfsight-style embed notes.
