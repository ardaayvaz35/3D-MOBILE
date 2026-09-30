import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLS_DOOR, CLS_FLOOR, CLS_WINDOW, clusterPoints, crossing, floorHeight, isExterior, isTraversable,
  lumaSamples, manualOpening, mergeOpenings, missingVistas, openingNames, openingsFacing, openingsHint,
  rectFromPoints, visibleTargets, voteExterior, type Opening,
} from './openings.ts';

type V = [number, number, number];
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const ROOM: V = [0, 1.4, 0];

/** Grid of points on the wall z = zWall, x0..x1, y0..y1, as flat x,y,z,cls. */
function wall(cls: number, x0: number, x1: number, y0: number, y1: number, zWall = -3, step = 0.1): number[] {
  const out: number[] = [];
  for (let x = x0; x <= x1 + 1e-9; x += step) for (let y = y0; y <= y1 + 1e-9; y += step) out.push(x, y, zWall, cls);
  return out;
}

function windowAt(x0: number, x1: number, y0 = 1, y1 = 2.2): Opening {
  const [o] = mergeOpenings([], wall(CLS_WINDOW, x0, x1, y0, y1), ROOM);
  return o;
}

test('a window on the far wall becomes one outward-facing rectangle', () => {
  const o = windowAt(-0.5, 0.5);
  assert.equal(o.kind, 'window');
  near(o.width, 1, 1e-6);
  near(o.height, 1.2, 1e-6);
  near(o.normal[2], -1, 1e-9); // away from the room
  // top-left seen from the room (looking down -Z, right is +X) is at -X, top
  near(o.corners[0][0], -0.5); near(o.corners[0][1], 2.2);
  near(o.corners[1][0], 0.5); near(o.corners[2][1], 1.0);
});

test('a window and a door two metres apart are two openings; ids stay on re-detection', () => {
  const flat = [...wall(CLS_WINDOW, -2, -1, 1, 2.2), ...wall(CLS_DOOR, 1, 1.9, 0, 2.1)];
  const first = mergeOpenings([], flat, ROOM);
  assert.deepEqual(first.map((o) => o.kind), ['window', 'door']);
  const voted = first.map((o, i) => (i === 0 ? { ...o, seen: 3, clipped: 3, vista: 'v1' } : o));
  const again = mergeOpenings(voted, flat, ROOM);
  assert.equal(again.length, 2);
  assert.equal(again[0].id, first[0].id);
  assert.equal(again[0].vista, 'v1');
  assert.equal(again[0].seen, 3);
});

test('an opening the mesh stops showing is kept', () => {
  const first = mergeOpenings([], wall(CLS_WINDOW, -0.5, 0.5, 1, 2.2), ROOM);
  assert.equal(mergeOpenings(first, [], ROOM).length, 1);
});

test('too few, too small or curved clusters are ignored', () => {
  assert.equal(mergeOpenings([], wall(CLS_WINDOW, 0, 0.1, 1, 1.1), ROOM).length, 0);
  const bumpy: V[] = [];
  for (let x = -0.5; x <= 0.5; x += 0.1) for (let y = 1; y <= 2; y += 0.1) bumpy.push([x, y, -3 + (Math.round(x * 10) % 2 ? 0.3 : -0.3)]);
  assert.equal(rectFromPoints(bumpy, ROOM), null);
});

test('clustering separates groups further apart than the link distance', () => {
  const pts: V[] = [[0, 0, 0], [0.2, 0, 0], [0.4, 0, 0], [2, 0, 0], [2.2, 0, 0]];
  assert.deepEqual(clusterPoints(pts).map((c) => c.length).sort(), [2, 3]);
});

test('luma votes: clipped glass is exterior, visible glass is not', () => {
  let o = windowAt(-0.5, 0.5);
  assert.equal(lumaSamples(o).length, 16);
  assert.equal(isExterior(o), false); // no look yet
  o = voteExterior(o, new Array(16).fill(255));
  assert.equal(isExterior(o), true);
  let inner = windowAt(-0.5, 0.5);
  inner = voteExterior(inner, new Array(16).fill(120));
  assert.equal(isExterior(inner), false);
  // mostly out of view: no vote
  const skipped = voteExterior(inner, [255, 255, ...new Array(14).fill(-1)]);
  assert.equal(skipped.seen, inner.seen);
});

test('traversable: doors, and tall openings that reach the floor', () => {
  const [door] = mergeOpenings([], wall(CLS_DOOR, 0, 0.9, 0, 2.1), ROOM);
  assert.equal(isTraversable(door, 0), true);
  const tallGlass = windowAt(-0.5, 0.5, 0.05, 2.1);
  assert.equal(isTraversable(tallGlass, 0), true);
  assert.equal(isTraversable(windowAt(-0.5, 0.5), 0), false); // sill at 1 m
});

test('floor height from floor points, or from the phone path', () => {
  const floor: V[] = Array.from({ length: 30 }, (_, i) => [i * 0.1, 0.01 * (i % 3), 0]);
  near(floorHeight(floor, [])!, 0);
  near(floorHeight([], [[0, 1.5, 0], [0, 1.4, 0]])!, -0.05);
  assert.equal(floorHeight([], []), null);
});

test('crossing: walking out through the door and back in', () => {
  const [door] = mergeOpenings([], wall(CLS_DOOR, -0.45, 0.45, 0, 2.1), ROOM);
  assert.equal(crossing([0, 1.4, -2.8], [0, 1.4, -3.2], door), 'out');
  assert.equal(crossing([0, 1.4, -3.2], [0, 1.4, -2.8], door), 'in');
  assert.equal(crossing([0, 1.4, -2.0], [0, 1.4, -2.5], door), null); // not reached
  assert.equal(crossing([3, 1.4, -2.8], [3, 1.4, -3.2], door), null); // through the wall beside it
});

test('openingsFacing picks exterior openings in front of the phone', () => {
  const o = voteExterior(windowAt(-0.5, 0.5), new Array(16).fill(255));
  assert.equal(openingsFacing([o], [0, 0, -1]).length, 1);
  assert.equal(openingsFacing([o], [0, 0, 1]).length, 0);
  assert.equal(openingsFacing([windowAt(-0.5, 0.5)], [0, 0, -1]).length, 0); // not exterior
});

test('visible targets: through a window only outward directions within its cone', () => {
  const o = windowAt(-0.5, 0.5);
  const path: V[] = [[0, 1.4, 0], [0.5, 1.4, -1], [-0.5, 1.4, -1]];
  const t = visibleTargets([o], path, false)!;
  assert.ok(t.length >= 4);
  for (const d of t) assert.ok(d[2] < 0); // all look out of the -Z wall
  assert.ok(!t.some((d) => d[1] > 0.8)); // nothing near the zenith
  // outside: the whole half-space in front of the facade
  const out = visibleTargets([o], [], true)!;
  assert.ok(out.length > t.length);
  for (const d of out) assert.ok(d[2] <= 1e-9); // never behind the facade
  // nothing detected: caller falls back to the fixed grid
  assert.equal(visibleTargets([], path, false), null);
});

test('manual opening from four taps, and missing-vista list', () => {
  const taps: V[] = [[-0.4, 2, -3], [0.4, 2, -3], [0.4, 1, -3], [-0.4, 1, -3]];
  const list = manualOpening([], taps, ROOM)!;
  assert.equal(list[0].kind, 'manual');
  near(list[0].width, 0.8);
  const ext = list.map((o) => voteExterior(o, new Array(16).fill(255)));
  assert.equal(missingVistas(ext).length, 1);
  assert.equal(missingVistas(ext.map((o) => ({ ...o, vista: 'v1' }))).length, 0);
  assert.equal(openingNames(ext).get(ext[0].id), 'Elle 1');
});

test('hint JSON carries the decisions', () => {
  const o = voteExterior(windowAt(-0.5, 0.5), new Array(16).fill(255));
  const h = openingsHint([{ ...o, vista: 'v1' }], 0);
  assert.equal(h.openings[0].exterior, true);
  assert.equal(h.openings[0].vista, 'v1');
  assert.equal(h.openings[0].source, 'arkit');
  assert.equal(h.floor_y, 0);
  assert.ok(CLS_FLOOR > 0);
});
