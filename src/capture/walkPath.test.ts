import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RoomPlanObject } from '../../modules/arkit-capture/src/ArkitCapture.types.ts';
import { buildGrid, findPath, resample } from './walkPath.ts';
import type { Vec3 } from './objectMode.ts';

/** Floor points every 20 cm over x 0..4, z 0..3. */
function floor(): Vec3[] {
  const out: Vec3[] = [];
  for (let x = 0; x <= 4.001; x += 0.2) for (let z = 0; z <= 3.001; z += 0.2) out.push([x, 0, z]);
  return out;
}

const pathLen = (p: Vec3[]) => p.slice(1).reduce((s, q, i) => s + Math.hypot(q[0] - p[i][0], q[2] - p[i][2]), 0);

test('open floor: about the straight line', () => {
  const g = buildGrid(floor(), [], [], [])!;
  const p = findPath(g, [0.3, 1.4, 1.5], [3.7, 0, 1.5])!;
  assert.ok(p);
  assert.ok(Math.abs(pathLen(p) - 3.4) < 0.3, String(pathLen(p)));
});

test('a bed in the way: the route goes round, never through it', () => {
  const bed: RoomPlanObject = { id: 'b', category: 'bed', center: [2, 0.25, 1.2], size: [1.0, 0.5, 2.4], yaw_deg: 0 };
  const g = buildGrid(floor(), [], [bed], [])!;
  const p = findPath(g, [0.5, 1.4, 1.0], [3.5, 0, 1.0])!;
  assert.ok(p);
  for (const q of p) {
    const inside = Math.abs(q[0] - 2) <= 0.5 && Math.abs(q[2] - 1.2) <= 1.2;
    assert.equal(inside, false, `through the bed at ${q}`);
  }
  assert.ok(pathLen(p) > 3.2);
});

test('goal inside furniture snaps to the floor next to it', () => {
  const table: RoomPlanObject = { id: 't', category: 'table', center: [2, 0.4, 1.5], size: [0.8, 0.8, 0.8], yaw_deg: 0 };
  const g = buildGrid(floor(), [], [table], [])!;
  const p = findPath(g, [0.5, 1.4, 1.5], [2, 0, 1.5]);
  assert.ok(p);
  const end = p![p!.length - 1];
  assert.ok(Math.hypot(end[0] - 2, end[2] - 1.5) <= 1.0);
});

test('walled off: no route', () => {
  // Wall across the room at x = 2 (along z), full width.
  const g = buildGrid(floor(), [], [], [{ center: [2, 1, 1.5], width: 6, yaw_deg: 90 }])!;
  assert.equal(findPath(g, [0.5, 1.4, 1.5], [3.5, 0, 1.5]), null);
});

test('resample: points every step along the path, capped', () => {
  const pts = resample([[0, 0, 0], [1, 0, 0], [1, 0, 1]], 0.5, 1.6);
  assert.deepEqual(pts.map((p) => [Math.round(p[0] * 10) / 10, Math.round(p[2] * 10) / 10]),
    [[0, 0], [0.5, 0], [1, 0], [1, 0.5]]);
});
