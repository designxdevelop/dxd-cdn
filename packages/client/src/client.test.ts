import { describe, expect, it, vi } from 'vitest';
import { DxdCdnClient } from './client.js';
import { IMMUTABLE_CACHE_CONTROL, MUTABLE_CACHE_CONTROL } from './keys.js';

describe('publishHashedAsset', () => {
  it('writes a hashed snapshot then overwrites the live filename', async () => {
    const puts: Array<{ key: string; cache: string; overwrite: string | null }> = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const key = headers.get('X-DXD-Object-Key') || '';
      const cache = headers.get('X-DXD-Cache-Control') || '';
      puts.push({ key, cache, overwrite: headers.get('X-DXD-Overwrite') });
      return new Response(
        JSON.stringify({
          ok: true,
          key,
          url: `https://cdn.designxdevelop.com/${key}`,
          cacheControl: cache,
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const cdn = new DxdCdnClient({
      origin: 'https://cdn.designxdevelop.com',
      uploadPassword: 'secret',
      fetch: fetchImpl as unknown as typeof fetch,
    });

    const result = await cdn.publishHashedAsset({
      prefix: 'heard/hp/prod',
      liveName: 'personalization.js',
      hash: 'abc123def456',
      body: 'console.log(1)',
      contentType: 'application/javascript; charset=utf-8',
    });

    expect(puts).toEqual([
      {
        key: 'heard/hp/prod/personalization.abc123def456.js',
        cache: IMMUTABLE_CACHE_CONTROL,
        overwrite: 'false',
      },
      {
        key: 'heard/hp/prod/personalization.js',
        cache: MUTABLE_CACHE_CONTROL,
        overwrite: 'true',
      },
    ]);
    expect(result.liveUrl).toBe('https://cdn.designxdevelop.com/heard/hp/prod/personalization.js');
    expect(result.versionedUrl).toBe(
      'https://cdn.designxdevelop.com/heard/hp/prod/personalization.abc123def456.js',
    );
  });

  it('does not start the live PUT until the snapshot PUT finishes', async () => {
    let finishSnapshot!: (response: Response) => void;
    const snapshotHeld = new Promise<Response>((resolve) => {
      finishSnapshot = resolve;
    });
    const puts: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const key = new Headers(init?.headers).get('X-DXD-Object-Key') || '';
      puts.push(key);
      if (key.endsWith('personalization.abc123def456.js')) {
        return snapshotHeld;
      }
      return new Response(
        JSON.stringify({
          ok: true,
          key,
          url: `https://cdn.designxdevelop.com/${key}`,
          cacheControl: MUTABLE_CACHE_CONTROL,
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const cdn = new DxdCdnClient({
      origin: 'https://cdn.designxdevelop.com',
      uploadPassword: 'secret',
      fetch: fetchImpl as unknown as typeof fetch,
    });

    const pending = cdn.publishHashedAsset({
      prefix: 'heard/hp/prod',
      liveName: 'personalization.js',
      hash: 'abc123def456',
      body: 'console.log(1)',
      contentType: 'application/javascript; charset=utf-8',
    });

    await vi.waitFor(() => {
      expect(puts).toEqual(['heard/hp/prod/personalization.abc123def456.js']);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    finishSnapshot!(
      new Response(
        JSON.stringify({
          ok: true,
          key: 'heard/hp/prod/personalization.abc123def456.js',
          url: 'https://cdn.designxdevelop.com/heard/hp/prod/personalization.abc123def456.js',
          cacheControl: IMMUTABLE_CACHE_CONTROL,
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await pending;
    expect(puts).toEqual([
      'heard/hp/prod/personalization.abc123def456.js',
      'heard/hp/prod/personalization.js',
    ]);
  });

  it('does not overwrite live if the snapshot PUT fails', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const key = new Headers(init?.headers).get('X-DXD-Object-Key') || '';
      if (key.endsWith('personalization.abc123def456.js')) {
        return new Response(JSON.stringify({ error: 'Object exists', key }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true, key, url: `https://cdn.designxdevelop.com/${key}` }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const cdn = new DxdCdnClient({
      origin: 'https://cdn.designxdevelop.com',
      uploadPassword: 'secret',
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      cdn.publishHashedAsset({
        prefix: 'heard/hp/prod',
        liveName: 'personalization.js',
        hash: 'abc123def456',
        body: 'console.log(1)',
        contentType: 'application/javascript; charset=utf-8',
      }),
    ).rejects.toThrow(/Object exists/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('deleteObject', () => {
  it('resolves true on success and false when the key is already gone', async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      requests.push({ url: href, method: init?.method || 'GET' });
      if (href.includes('absent')) {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      }
      return new Response(JSON.stringify({ ok: true, key: 'heard/a.js', purged: true }), {
        status: 200,
      });
    });

    const cdn = new DxdCdnClient({
      origin: 'https://cdn.designxdevelop.com',
      uploadPassword: 'secret',
      fetch: fetchImpl as unknown as typeof fetch,
    });

    expect(await cdn.deleteObject('heard/a.js')).toBe(true);
    expect(await cdn.deleteObject('heard/absent.js')).toBe(false);
    expect(requests.map((request) => request.method)).toEqual(['DELETE', 'DELETE']);
    expect(requests[0].url).toBe(
      'https://cdn.designxdevelop.com/api/objects?key=heard%2Fa.js',
    );
  });

  it('throws on a scope rejection rather than reporting nothing to delete', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'Key is outside this token scope' }), {
          status: 403,
        }),
    );

    const cdn = new DxdCdnClient({
      origin: 'https://cdn.designxdevelop.com',
      uploadPassword: 'app-token',
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(cdn.deleteObject('acme/a.js')).rejects.toThrow(/outside this token scope/);
  });
});

describe('listAllObjects', () => {
  it('follows the cursor until the listing is complete', async () => {
    const pages = [
      { prefix: 'heard/', objects: [{ key: 'heard/a.js' }], prefixes: [], truncated: true, cursor: 'c1' },
      { prefix: 'heard/', objects: [{ key: 'heard/b.js' }], prefixes: [], truncated: true, cursor: 'c2' },
      { prefix: 'heard/', objects: [{ key: 'heard/c.js' }], prefixes: [], truncated: false, cursor: null },
    ];
    const cursors: Array<string | null> = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const parsed = new URL(String(url));
      cursors.push(parsed.searchParams.get('cursor'));
      return new Response(JSON.stringify(pages.shift()), { status: 200 });
    });

    const cdn = new DxdCdnClient({
      origin: 'https://cdn.designxdevelop.com',
      uploadPassword: 'secret',
      fetch: fetchImpl as unknown as typeof fetch,
    });

    const objects = await cdn.listAllObjects({ prefix: 'heard/' });

    expect(objects.map((object) => object.key)).toEqual(['heard/a.js', 'heard/b.js', 'heard/c.js']);
    expect(cursors).toEqual([null, 'c1', 'c2']);
  });
});
