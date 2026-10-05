import {
  hashedFilename,
  IMMUTABLE_CACHE_CONTROL,
  MUTABLE_CACHE_CONTROL,
  publicUrl,
} from './keys.js';

export type PutObjectInput = {
  key: string;
  body: string | Uint8Array | ArrayBuffer;
  contentType: string;
  cacheControl: string;
  overwrite?: boolean;
};

export type PutObjectResult = {
  ok: true;
  key: string;
  url: string;
  cacheControl: string;
  /**
   * Whether the Worker dropped Cloudflare's cached copy of this key. Always
   * `false` for immutable snapshots, which are create-only and cannot go stale.
   * `false` on a live write means a publish may be served stale at the edge
   * until `LIVE_EDGE_MAX_AGE` elapses — worth logging in CI.
   */
  purged?: boolean;
};

export type GetObjectMetaResult = {
  key: string;
  size: number;
  etag: string;
  uploaded: string;
  contentType: string | null;
  cacheControl: string | null;
  url: string;
};

export type ListObjectsInput = {
  /** Must be inside the token's scope. Omit to use the token's own prefix. */
  prefix?: string;
  /** Continue from a previous page's `cursor`. */
  cursor?: string;
  /** 1–1000. Defaults to R2's page size. */
  limit?: number;
  /** `/` to return folder prefixes instead of every key. */
  delimiter?: string;
};

export type ListedObject = {
  key: string;
  size: number;
  uploaded: string;
  etag: string;
  contentType: string | null;
  cacheControl: string | null;
};

export type ListObjectsResult = {
  prefix: string;
  objects: ListedObject[];
  /** Folder prefixes, when a `delimiter` was supplied. */
  prefixes: string[];
  truncated: boolean;
  cursor: string | null;
};

export type DxdCdnClientOptions = {
  /** e.g. https://cdn.designxdevelop.com */
  origin: string;
  /** A scoped app token from APP_TOKENS, or the operator UPLOAD_PASSWORD */
  uploadPassword: string;
  fetch?: typeof fetch;
};

export type PublishVersionedInput = {
  /** Directory prefix, e.g. `dxd-studio/countdown/prod/widgets/abc` */
  prefix: string;
  version: number | string;
  body: string | Uint8Array | ArrayBuffer;
  contentType: string;
  /** Filename for the live pointer (default `config.json`) */
  liveName?: string;
  /** Filename pattern for snapshot; `{version}` replaced (default `v{version}.json`) */
  versionedName?: string;
  immutableCacheControl: string;
  mutableCacheControl: string;
};

export type PublishHashedAssetInput = {
  /** Directory prefix, e.g. `heard/hp/prod` */
  prefix: string;
  /** Stable live filename, e.g. `personalization.js` */
  liveName: string;
  body: string | Uint8Array | ArrayBuffer;
  contentType: string;
  /** Content hash (caller computes; 8–16 hex chars is typical). */
  hash: string;
  immutableCacheControl?: string;
  mutableCacheControl?: string;
};

export type PublishVersionedResult = {
  versioned: PutObjectResult;
  live: PutObjectResult;
  /** Stable public URL embeds should fetch (no query) */
  liveUrl: string;
  versionedUrl: string;
};

function assertOk(res: Response, body: unknown): void {
  if (res.ok) return;
  const message =
    typeof body === 'object' && body && 'error' in body
      ? String((body as { error: unknown }).error)
      : `CDN request failed (${res.status})`;
  throw new Error(message);
}

/**
 * Authenticated client for `PUT|GET /api/objects`.
 * Project-agnostic — any DXD app or CI job can use this.
 */
export class DxdCdnClient {
  readonly origin: string;
  private readonly uploadPassword: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DxdCdnClientOptions) {
    this.origin = options.origin.replace(/\/$/, '');
    this.uploadPassword = options.uploadPassword;
    this.fetchImpl = options.fetch ?? fetch;
  }

  private authHeaders(extra?: HeadersInit): Headers {
    const headers = new Headers(extra);
    headers.set('Authorization', `Bearer ${this.uploadPassword}`);
    return headers;
  }

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    const headers = this.authHeaders({
      'Content-Type': input.contentType,
      'X-DXD-Object-Key': input.key,
      'X-DXD-Cache-Control': input.cacheControl,
      'X-DXD-Overwrite': input.overwrite === false ? 'false' : 'true',
    });

    const res = await this.fetchImpl(`${this.origin}/api/objects`, {
      method: 'PUT',
      headers,
      body: input.body as BodyInit,
    });

    const json = (await res.json().catch(() => ({}))) as PutObjectResult & { error?: string };
    assertOk(res, json);
    return json;
  }

  async getObjectMeta(key: string): Promise<GetObjectMetaResult | null> {
    const url = new URL(`${this.origin}/api/objects`);
    url.searchParams.set('key', key);
    url.searchParams.set('as', 'meta');

    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: this.authHeaders(),
    });

    if (res.status === 404) return null;
    const json = (await res.json().catch(() => ({}))) as GetObjectMetaResult & { error?: string };
    assertOk(res, json);
    return json;
  }

  /** Needs the `delete` op. Resolves false when there was nothing to delete. */
  async deleteObject(key: string): Promise<boolean> {
    const url = new URL(`${this.origin}/api/objects`);
    url.searchParams.set('key', key);

    const res = await this.fetchImpl(url, {
      method: 'DELETE',
      headers: this.authHeaders(),
    });

    if (res.status === 404) return false;
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    assertOk(res, json);
    return true;
  }

  /**
   * One page of a scoped listing. Needs the `list` op. Keep calling with
   * `cursor` while `truncated` is true. Omit `prefix` to use the token's own.
   */
  async listObjects(input: ListObjectsInput = {}): Promise<ListObjectsResult> {
    const url = new URL(`${this.origin}/api/objects/list`);
    if (input.prefix) url.searchParams.set('prefix', input.prefix);
    if (input.cursor) url.searchParams.set('cursor', input.cursor);
    if (input.limit) url.searchParams.set('limit', String(input.limit));
    if (input.delimiter) url.searchParams.set('delimiter', input.delimiter);

    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: this.authHeaders(),
    });

    const json = (await res.json().catch(() => ({}))) as ListObjectsResult & { error?: string };
    assertOk(res, json);
    return json;
  }

  /** Every key under a prefix, following the cursor for you. */
  async listAllObjects(input: Omit<ListObjectsInput, 'cursor'> = {}): Promise<ListedObject[]> {
    const objects: ListedObject[] = [];
    let cursor: string | undefined;

    do {
      const page = await this.listObjects({ ...input, cursor });
      objects.push(...page.objects);
      cursor = page.cursor ?? undefined;
    } while (cursor);

    return objects;
  }

  async getObjectBody(key: string): Promise<{ contentType: string; body: string } | null> {
    const url = new URL(`${this.origin}/api/objects`);
    url.searchParams.set('key', key);
    url.searchParams.set('as', 'body');

    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: this.authHeaders(),
    });

    if (res.status === 404) return null;
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      assertOk(res, json);
    }

    return {
      contentType: res.headers.get('Content-Type') || 'application/octet-stream',
      body: await res.text(),
    };
  }

  /** Unauthenticated public GET (what browsers / embeds use). */
  async fetchPublic(key: string, cacheBust?: string | number): Promise<Response> {
    return this.fetchImpl(publicUrl(this.origin, key, cacheBust), {
      method: 'GET',
      headers: { Accept: 'application/json, */*' },
    });
  }

  /**
   * Write an immutable snapshot + overwrite the live pointer at the same prefix.
   * Used by Studio widget publish and any other versioned artifact pipeline.
   */
  async publishVersioned(input: PublishVersionedInput): Promise<PublishVersionedResult> {
    const liveName = input.liveName ?? 'config.json';
    const snapshotName = (input.versionedName ?? 'v{version}.json').replace(
      '{version}',
      String(input.version),
    );
    return this.publishLiveAndSnapshot({
      prefix: input.prefix,
      liveName,
      snapshotName,
      body: input.body,
      contentType: input.contentType,
      immutableCacheControl: input.immutableCacheControl,
      mutableCacheControl: input.mutableCacheControl,
    });
  }

  /**
   * Hashed snapshot + overwrite of the stable live filename.
   */
  async publishHashedAsset(input: PublishHashedAssetInput): Promise<PublishVersionedResult> {
    return this.publishLiveAndSnapshot({
      prefix: input.prefix,
      liveName: input.liveName,
      snapshotName: hashedFilename(input.liveName, input.hash),
      body: input.body,
      contentType: input.contentType,
      immutableCacheControl: input.immutableCacheControl ?? IMMUTABLE_CACHE_CONTROL,
      mutableCacheControl: input.mutableCacheControl ?? MUTABLE_CACHE_CONTROL,
    });
  }

  private async publishLiveAndSnapshot(input: {
    prefix: string;
    liveName: string;
    snapshotName: string;
    body: string | Uint8Array | ArrayBuffer;
    contentType: string;
    immutableCacheControl: string;
    mutableCacheControl: string;
  }): Promise<PublishVersionedResult> {
    const prefix = input.prefix.replace(/\/$/, '');
    const versionedKey = `${prefix}/${input.snapshotName}`;
    const liveKey = `${prefix}/${input.liveName}`;

    const versioned = await this.putObject({
      key: versionedKey,
      body: input.body,
      contentType: input.contentType,
      cacheControl: input.immutableCacheControl,
      overwrite: false,
    });

    const live = await this.putObject({
      key: liveKey,
      body: input.body,
      contentType: input.contentType,
      cacheControl: input.mutableCacheControl,
      overwrite: true,
    });

    return {
      versioned,
      live,
      liveUrl: publicUrl(this.origin, liveKey),
      versionedUrl: publicUrl(this.origin, versionedKey),
    };
  }
}
