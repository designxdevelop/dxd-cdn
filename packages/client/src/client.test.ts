import { describe, expect, it, vi } from 'vitest';
import { DxdCdnClient } from './client.js';
import { IMMUTABLE_CACHE_CONTROL, MUTABLE_CACHE_CONTROL } from './keys.js';

describe('publishHashedAsset', () => {
  it('writes a hashed snapshot then overwrites the live filename', async () => {
    const puts: Array<{ key: string; cache: string }> = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const key = new Headers(init?.headers).get('X-DXD-Object-Key') || '';
      const cache = new Headers(init?.headers).get('X-DXD-Cache-Control') || '';
      puts.push({ key, cache });
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
      },
      {
        key: 'heard/hp/prod/personalization.js',
        cache: MUTABLE_CACHE_CONTROL,
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
        return new Response(JSON.stringify({ error: 'R2 unavailable' }), {
          status: 500,
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
    ).rejects.toThrow(/R2 unavailable/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
