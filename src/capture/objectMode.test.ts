import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RoomPlanObject, RoomPlanWall } from '../../modules/arkit-capture/src/ArkitCapture.types.ts';
import {
  aimedAt, approachPoint, AZIMUTHS, blockedByWall, boxCorners, closeDistance, displayName, domeComplete, domeProgress,
  ENTER_AIM_S, ENTER_BLACK_S, exportBox, footprintDistance, makeDome, type ModeState, nativeMode, nextSlice,
  PHONE_MAX_M, refreshDome, sliceFor, sliceHint, stepMode, wantsOwnScan, type Vec3,
} from './objectMode.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

/** Dresser 1.0 x 0.8 x 0.5 m standing on the floor (y = 0) at x = 2. */
const dresser: RoomPlanObject = { id: 'd1', category: 'storage', center: [2, 0.4, 0], size: [1.0, 0.8, 0.5], yaw_deg: 0 };

test('selection: main furniture over 0.3 m² only', () => {
  assert.equal(wantsOwnScan(dresser), true);
  assert.equal(wantsOwnScan({ ...dresser, size: [0.4, 0.5, 0.4] }), false); // 0.16 m²
  assert.equal(wantsOwnScan({ ...dresser, category: 'toilet' }), false);
  assert.equal(wantsOwnScan({ ...dresser, category: 'television' }), false);
});

test('names: storage by size', () => {
  assert.equal(displayName(dresser), 'Şifonyer');
  assert.equal(displayName({ ...dresser, size: [0.5, 0.6, 0.4] }), 'Komidin');
  assert.equal(displayName({ ...dresser, size: [1.2, 2.0, 0.6] }), 'Dolap');
  assert.equal(displayName({ ...dresser, category: 'bed' }), 'Yatak');
});

test('export box grows 3 cm a side', () => {
  const b = exportBox(dresser);
  near(b.size[0], 1.06); near(b.size[1], 0.86); near(b.size[2], 0.56);
  assert.deepEqual(b.center, dresser.center);
});

test('yaw follows the worker convention: x axis -> (cos, 0, -sin)', () => {
  const turned = { ...dresser, center: [0, 0.4, 0] as Vec3, yaw_deg: 90 };
  // Long side (1.0 m along box x) now runs along world -z.
  const xs = boxCorners(turned).map((c) => c[0]);
  const zs = boxCorners(turned).map((c) => c[2]);
  near(Math.max(...xs), 0.25); near(Math.max(...zs), 0.5);
  near(footprintDistance([0, 0, -1.0], turned), 0.5);
  near(footprintDistance([1.0, 0, 0], turned), 0.75);
});

test('dome: 3 rings x 12, viewer elevations, close-up camera spots', () => {
  const dome = makeDome(dresser, 1.5, []);
  assert.equal(dome.length, 3 * AZIMUTHS);
  // Far ring is flatter than the near one: a far visitor sees it from low.
  const el = (r: number) => Math.asin(dome.find((s) => s.ring === r)!.dir[1]);
  assert.ok(el(0) < el(1) && el(1) < el(2));
  near(el(0), Math.atan2(1.5 - 0.4, 3.5));
  // Every spot is at the close distance.
  for (const s of dome) {
    near(Math.hypot(s.cam[0] - 2, s.cam[1] - 0.4, s.cam[2]), closeDistance(dresser));
  }
});

test('dome: the side against a wall is left out', () => {
  // Wall along x at z = -0.4 (just behind the dresser's back face at z = -0.25).
  const wall: RoomPlanWall = { center: [2, 1.2, -0.4], width: 4, yaw_deg: 0 };
  assert.equal(blockedByWall(dresser, [0, 0, -1], [wall]), true);
  assert.equal(blockedByWall(dresser, [0, 0, 1], [wall]), false);
  const dome = makeDome(dresser, 1.5, [wall]);
  assert.ok(dome.length < 36);
  assert.ok(dome.every((s) => s.dir[2] > -0.5)); // nothing from behind
});

test('slice fill: right direction, aimed and close; otherwise no', () => {
  const dome = makeDome(dresser, 1.5, []);
  const s = dome[5];
  const fwd: Vec3 = [dresser.center[0] - s.cam[0], dresser.center[1] - s.cam[1], dresser.center[2] - s.cam[2]];
  assert.equal(sliceFor(dome, dresser, s.cam, fwd), 5);
  // Looking away: no.
  assert.equal(sliceFor(dome, dresser, s.cam, [-fwd[0], -fwd[1], -fwd[2]]), -1);
  // Too far along the same line: no.
  const far: Vec3 = [2 + s.dir[0] * 5, 0.4 + s.dir[1] * 5, s.dir[2] * 5];
  assert.equal(sliceFor(dome, dresser, far, fwd), -1);
});

test('progress, next slice and hints', () => {
  const dome = makeDome(dresser, 1.5, []);
  assert.equal(domeProgress(dome), 0);
  dome.forEach((s, i) => { s.filled = i % 2 === 0; });
  near(domeProgress(dome), 0.5);
  const i = nextSlice(dome, dresser, dome[1].cam);
  assert.equal(i, 1);
  // Phone 40 cm under a slice's spot: lift it.
  const s = dome[1];
  assert.equal(sliceHint(s, [s.cam[0], s.cam[1] - 0.4, s.cam[2]], dresser), 'Telefonu kaldır');
  assert.equal(sliceHint(s, s.cam, dresser), null);
});

test('approach point stands in front of the piece, toward the phone', () => {
  const p = approachPoint(dresser, [6, 1.5, 0]);
  near(p[0], 2 + 0.5 + 0.9); near(p[2], 0);
});

test('mode machine: room -> black -> object -> black -> room', () => {
  let s: ModeState = { kind: 'room' };
  const fwd: Vec3 = [-1, -0.3, 0]; // looking toward the dresser (it is at -x from the phone)
  const base = { pending: [dresser], complete: false, heightDev: 0, fwd };
  s = stepMode(s, { ...base, now: 0, pos: [5, 1.5, 0] });
  assert.equal(s.kind, 'room'); // 2.5 m away
  s = stepMode(s, { ...base, now: 1, pos: [3.8, 1.5, 0] }); // 1.3 m from the footprint, pointed at it
  assert.equal(s.kind, 'room'); // eyeing starts
  s = stepMode(s, { ...base, now: 1 + ENTER_AIM_S, pos: [3.8, 1.5, 0] });
  assert.equal(s.kind, 'toObject');
  assert.deepEqual(nativeMode(s), { mode: 'paused', objectId: null });
  const t0 = 1 + ENTER_AIM_S;
  s = stepMode(s, { ...base, now: t0 + ENTER_BLACK_S - 0.1, pos: [3.8, 1.5, 0] });
  assert.equal(s.kind, 'toObject');
  s = stepMode(s, { ...base, now: t0 + ENTER_BLACK_S, pos: [3.8, 1.5, 0] });
  assert.deepEqual(nativeMode(s), { mode: 'object', objectId: 'd1' });
  s = stepMode(s, { ...base, now: 30, pos: [3, 0.8, 0], complete: true });
  assert.equal(s.kind, 'toRoom');
  s = stepMode(s, { ...base, now: 31, pos: [3, 1.3, 0], heightDev: -0.2 });
  assert.equal(s.kind, 'toRoom'); // still 20 cm low
  s = stepMode(s, { ...base, now: 32, pos: [3, 1.48, 0], heightDev: -0.02 });
  assert.equal(s.kind, 'room');
});

test('mode machine: close but looking away, or nothing pending, stays in room', () => {
  const away: Vec3 = [1, 0, 0];
  let s: ModeState = { kind: 'room' };
  for (let t = 0; t < 10; t++) s = stepMode(s, { now: t, pos: [2.6, 1.5, 0], fwd: away, pending: [dresser], complete: false, heightDev: 0 });
  assert.equal(s.kind, 'room');
  const at: Vec3 = [-1, -1, 0];
  s = { kind: 'room' };
  for (let t = 0; t < 10; t++) s = stepMode(s, { now: t, pos: [2.6, 1.5, 0], fwd: at, pending: [], complete: false, heightDev: 0 });
  assert.equal(s.kind, 'room');
});

test('mode machine: looking away resets the entry wait', () => {
  const at: Vec3 = [-1, -0.3, 0];
  const away: Vec3 = [1, 0, 0];
  const base = { pos: [3.8, 1.5, 0] as Vec3, pending: [dresser], complete: false, heightDev: 0 };
  let s: ModeState = stepMode({ kind: 'room' }, { ...base, now: 0, fwd: at });
  s = stepMode(s, { ...base, now: 0.6, fwd: away });
  s = stepMode(s, { ...base, now: 0.7, fwd: at });
  s = stepMode(s, { ...base, now: 1.2, fwd: at });
  assert.equal(s.kind, 'room'); // only 0.5 s since looking back
  s = stepMode(s, { ...base, now: 0.7 + ENTER_AIM_S, fwd: at });
  assert.equal(s.kind, 'toObject');
});

/** Bed 1.7 x 0.76 x 2.1 m on the floor (y = 0) at the origin, head against a wall at z = -1.1. */
const bed: RoomPlanObject = { id: 'b1', category: 'bed', center: [0, 0.38, 0], size: [1.7, 0.76, 2.1], yaw_deg: 0 };

test('aim: looking at the bed but not its middle counts (close up)', () => {
  const cam: Vec3 = [1.6, 1.5, 0.6];
  const fwd: Vec3 = [0.5 - cam[0], 0.5 - cam[1], 0.9 - cam[2]]; // at the foot corner
  assert.ok(aimedAt(bed, cam, fwd));
  assert.ok(!aimedAt(bed, cam, [1, 0, 0])); // away from it
});

test('dome: spots off the floor map are unreachable and do not count', () => {
  // Free floor only in front of the foot (z > 1.2) and to the +x side.
  const free = (p: Vec3) => p[2] > 1.2 || p[0] > 1.0;
  const dome = makeDome(bed, 1.6, [], { free, floorY: 0 });
  const reach = dome.filter((s) => s.reachable);
  assert.ok(reach.length > 0 && reach.length < dome.length);
  for (const s of reach) assert.ok(free(s.cam));
  // Every reachable spot is at a height a person can hold.
  for (const s of reach) assert.ok(s.cam[1] >= 0.4 - 1e-9 && s.cam[1] <= PHONE_MAX_M + 1e-9, `${s.cam[1]}`);
  reach.forEach((s) => { s.filled = true; });
  assert.equal(domeProgress(dome), 1);
  assert.ok(domeComplete(dome));
  // Unreachable slices are never offered as next.
  dome.forEach((s) => { s.filled = false; });
  const i = nextSlice(dome, bed, [0, 1.5, -3]);
  assert.ok(dome[i].reachable);
});

test('dome: nothing reachable is 0 %, not complete; the floor map growing brings slices back', () => {
  const dome = makeDome(bed, 1.6, [], { free: () => false, floorY: 0 });
  assert.equal(domeProgress(dome), 0);
  assert.ok(!domeComplete(dome));
  refreshDome(dome, bed, { free: () => true, floorY: 0 });
  assert.ok(dome.some((s) => s.reachable));
});

test('hint: height asked at the phone own distance, not a fixed far spot', () => {
  const dome = makeDome(bed, 1.6, [], { floorY: 0 });
  const s = dome.filter((d) => d.ring === 2 && d.reachable)[0];
  const hSpot = Math.hypot(s.cam[0], s.cam[2]);
  const h = [s.dir[0], 0, s.dir[2]];
  const hl = Math.hypot(h[0], h[2]);
  const at = (y: number): Vec3 => [(h[0] / hl) * hSpot, y, (h[2] / hl) * hSpot];
  assert.equal(sliceHint(s, at(s.cam[1]), bed), null);
  assert.equal(sliceHint(s, at(s.cam[1] - 0.3), bed), 'Telefonu kaldır');
  assert.equal(sliceHint(s, at(s.cam[1] + 0.3), bed), 'Telefonu biraz indir');
  // Far beyond the spot: walk in first.
  assert.equal(sliceHint(s, [(h[0] / hl) * (hSpot + 1.5), s.cam[1], (h[2] / hl) * (hSpot + 1.5)], bed), 'Biraz yaklaş');
});
