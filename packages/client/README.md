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

`publishVersioned` is the same idea with `v{n}.json` snapshots (Studio widgets).

`uploadPassword` takes either a scoped app token or the operator
`UPLOAD_PASSWORD`. Prefer a scoped token: it can only touch its own prefixes, so
a leak or a bug in one app cannot reach another's files.

## Managing an app's own files

```ts
// One page at a time, with a cursor.
const page = await cdn.listObjects({ prefix: 'heard/hp/prod/', limit: 100 });

// Or let the client follow the cursor for you.
for (const object of await cdn.listAllObjects({ prefix: 'heard/hp/prod/' })) {
  console.log(object.key, object.size, object.cacheControl);
}

// Resolves false when there was nothing to delete.
await cdn.deleteObject('heard/hp/prod/retired.js');
```

Omit `prefix` and a single-prefix token lists its own. `listObjects` needs the
`list` op and `deleteObject` needs `delete`, neither of which a publish-only
token has.

See [docs/api-objects.md](../../docs/api-objects.md) and [docs/connect-a-worker.md](../../docs/connect-a-worker.md).
