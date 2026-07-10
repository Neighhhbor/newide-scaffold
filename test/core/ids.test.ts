import { describe, expect, it } from 'vitest';
import { createId } from '../../src/core';

describe('createId', () => {
  it('creates prefixed non-colliding ids across repeated calls', () => {
    const ids = Array.from({ length: 100 }, () => createId('run'));

    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(
        /^run_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });
});
