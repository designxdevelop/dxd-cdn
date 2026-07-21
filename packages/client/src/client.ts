import { publicUrl } from './keys.js';

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

export type DxdCdnClientOptions = {
  /** e.g. https://cdn.designxdevelop.com */
  origin: string;
  /** Worker UPLOAD_PASSWORD */
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
    const versionedName = (input.versionedName ?? 'v{version}.json').replace(
      '{version}',
      String(input.version),
    );
    const prefix = input.prefix.replace(/\/$/, '');
    const versionedKey = `${prefix}/${versionedName}`;
    const liveKey = `${prefix}/${liveName}`;

    const versioned = await this.putObject({
      key: versionedKey,
      body: input.body,
      contentType: input.contentType,
      cacheControl: input.immutableCacheControl,
      overwrite: true,
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
