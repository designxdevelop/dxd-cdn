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
import { DxdCdnClient, DEFAULT_CDN_ORIGIN, joinKey } from '@dxd/cdn';

const cdn = new DxdCdnClient({
  origin: DEFAULT_CDN_ORIGIN,
  uploadPassword: process.env.DXD_CDN_UPLOAD_PASSWORD!,
});

await cdn.publishHashedAsset({
  prefix: joinKey('heard', 'hp', 'prod'),
  liveName: 'personalization.js',
  hash: 'abc123def456',
  body: scriptBytes,
  contentType: 'application/javascript; charset=utf-8',
});
```

`publishVersioned` is the same idea with `v{n}.json` snapshots (Studio widgets). See [docs/api-objects.md](../../docs/api-objects.md) and [docs/connect-a-worker.md](../../docs/connect-a-worker.md).
