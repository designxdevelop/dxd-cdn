import { describe, expect, it } from 'vitest';
import { hashedFilename, joinKey, MUTABLE_CACHE_CONTROL, publicUrl } from './keys.js';

describe('joinKey', () => {
  it('joins client/project/env style paths', () => {
    expect(joinKey('dxd-studio', 'countdown', 'prod', 'widgets', 'abc')).toBe(
      'dxd-studio/countdown/prod/widgets/abc',
    );
  });

  it('rejects traversal', () => {
    expect(() => joinKey('a', '..', 'b')).toThrow(/Invalid/);
  });
});

describe('hashedFilename', () => {
  it('inserts the hash before the extension', () => {
    expect(hashedFilename('personalization.js', 'abc123def456')).toBe(
      'personalization.abc123def456.js',
    );
  });

  it('appends when there is no extension', () => {
    expect(hashedFilename('platform', 'deadbeef')).toBe('platform.deadbeef');
  });
});

describe('MUTABLE_CACHE_CONTROL', () => {
  it('asks browsers to revalidate so republishes do not need a hard refresh', () => {
    expect(MUTABLE_CACHE_CONTROL).toBe('public, max-age=0, must-revalidate');
  });
});

describe('publicUrl', () => {
  it('adds cache-bust query when provided', () => {
    expect(publicUrl('https://cdn.example.com', 'a/b.json', 12)).toBe(
      'https://cdn.example.com/a/b.json?v=12',
    );
  });

  it('omits query when no bust', () => {
    expect(publicUrl('https://cdn.example.com/', '/a/b.json')).toBe(
      'https://cdn.example.com/a/b.json',
    );
  });
});
