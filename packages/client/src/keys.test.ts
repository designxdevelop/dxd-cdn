import { describe, expect, it } from 'vitest';
import { joinKey, publicUrl } from './keys.js';

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
