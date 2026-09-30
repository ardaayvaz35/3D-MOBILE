import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTargets, toScreen, angleDeg, nextTarget, holdStep, HOLD_S } from './vistaTargets.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
// Identity pose: camera at origin looking down world -Z, +Y up (ARKit convention).
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

test('28 unit targets around the starting heading, none behind it', () => {
  const t = makeTargets([0, 0, -1]);
  assert.equal(t.length, 28);
  for (const d of t) {
    near(Math.hypot(...d), 1);
    assert.ok(angleDeg([d[0], 0, d[2]], [0, 0, -1]) <= 90 + 1e-6);
  }
  // straight ahead, level row +15 exists
  assert.ok(t.some((d) => angleDeg(d, [0, Math.sin(15 * Math.PI / 180), -Math.cos(15 * Math.PI / 180)]) < 1e-6));
});

test('start heading ignores pitch: looking down still centres the grid horizontally', () => {
  const a = makeTargets([0, -0.8, -0.6]);
  const b = makeTargets([0, 0, -1]);
  a.forEach((d, i) => d.forEach((c, k) => near(c, b[i][k])));
});

test('toScreen matches GuidanceEngine mapping (right = cam.y, up = -cam.x, forward = -cam.z)', () => {
  // With the identity pose the camera frame equals the world frame.
  let s = toScreen([0, 0, -1], I);
  near(s.forward, 1); near(s.right, 0); near(s.up, 0);
  s = toScreen([0, 1, 0], I);   // world +Y = camera +Y = portrait right (sensor is landscape)
  near(s.right, 1);
  s = toScreen([1, 0, 0], I);   // world +X = camera +X = portrait down
  near(s.up, -1);
});

test('toScreen uses the pose rotation', () => {
  // Camera turned 90 deg left (yaw +90 about +Y): it now looks down world -X.
  const c = Math.cos(Math.PI / 2), s = Math.sin(Math.PI / 2);
  const yaw90 = [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
  const r = toScreen([-1, 0, 0], yaw90);
  near(r.forward, 1);
});

test('nextTarget picks the closest unfinished one, -1 when all done', () => {
  const t: [number, number, number][] = [[0, 0, -1], [1, 0, 0], [-1, 0, 0]];
  assert.equal(nextTarget(t, [false, false, false], [0.9, 0, -0.1]), 1);
  assert.equal(nextTarget(t, [false, true, false], [0.9, 0, -0.1]), 0);
  assert.equal(nextTarget(t, [true, true, true], [0, 0, -1]), -1);
});

test('holdStep fires once after HOLD_S aligned and tracking normal', () => {
  const st = { held: 0 };
  assert.equal(holdStep(st, true, true, HOLD_S / 2), false);
  assert.equal(holdStep(st, true, true, HOLD_S / 2 + 1e-3), true);
  assert.equal(st.held, 0);
});

test('holdStep resets when alignment or tracking is lost', () => {
  const st = { held: 0 };
  holdStep(st, true, true, HOLD_S * 0.9);
  assert.equal(holdStep(st, false, true, 0.01), false);
  assert.equal(st.held, 0);
  holdStep(st, true, true, HOLD_S * 0.9);
  assert.equal(holdStep(st, true, false, 0.5), false); // weak tracking never shoots
  assert.equal(st.held, 0);
});
