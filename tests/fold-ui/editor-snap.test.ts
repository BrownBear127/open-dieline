import { describe, expect, it } from 'vitest';
import { snapDelta } from '@/ui/editor/editor-snap';

const bounds = Object.freeze({ minX: 10, minY: 20, maxX: 20, maxY: 30 });

describe('snapDelta', () => {
  it('uses corners, edge midpoints, and the center of the rotated AABB as candidates', () => {
    expect(snapDelta(bounds, {
      vertical: [14.25],
      horizontal: [24.5],
    }, 2)).toEqual({ dx: 0, dy: -0.5 });
  });

  it('chooses the closest target across both axes', () => {
    expect(snapDelta(bounds, {
      vertical: [21.5],
      horizontal: [31.75],
    }, 2)).toEqual({ dx: 1.5, dy: 0 });
  });

  it('prefers a vertical target over a horizontal target when distances tie', () => {
    expect(snapDelta(bounds, {
      vertical: [21],
      horizontal: [31],
    }, 2)).toEqual({ dx: 1, dy: 0 });
  });

  it('includes targets exactly at the two millimetre threshold', () => {
    expect(snapDelta(bounds, {
      vertical: [22],
      horizontal: [],
    }, 2)).toEqual({ dx: 2, dy: 0 });
  });

  it('returns null when every target is outside the threshold', () => {
    expect(snapDelta(bounds, {
      vertical: [22.01],
      horizontal: [32.01],
    }, 2)).toBeNull();
  });

  it('returns null when the caller disables snapping for Alt', () => {
    expect(snapDelta(bounds, {
      vertical: [20],
      horizontal: [30],
      disabled: true,
    }, 2)).toBeNull();
  });
});
