import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allUploaded, canRecord, needsNewMap, newHouse, nextUpload, reduce, relocalizeHint, segmentFields,
  NEW_MAP_BYTES, RELOC_HINT_MS, RELOC_NEW_MAP_MS, type House,
} from './houseSession.ts';

const T0 = new Date('2026-10-06T10:00:00Z');
const PID = '3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f';

function recorded(h: House, floor = -1.4, bytes = 1_000_000): House {
  h = reduce(h, { type: 'labelsPicked', labels: ['salon'] });
  h = reduce(h, { type: 'recordingStarted' });
  return reduce(h, { type: 'segmentSaved', archivePath: `/tmp/s${h.segments.length}.zip`, frameCount: 400, floorHeightM: floor, mapBytes: bytes });
}

test('new house waits for labels, cannot record yet', () => {
  const h = newHouse(PID, 'Ev', T0, 'm1');
  assert.equal(h.phase, 'pickLabels');
  assert.equal(canRecord(h), false);
  const r = reduce(h, { type: 'labelsPicked', labels: ['salon', 'mutfak'] });
  assert.equal(r.phase, 'ready');
  assert.equal(canRecord(r), true);
});

test('segment saved: pending upload on the current map, room done', () => {
  const h = recorded(newHouse(PID, 'Ev', T0, 'm1'));
  assert.equal(h.phase, 'roomDone');
  assert.equal(h.segments.length, 1);
  const s = h.segments[0];
  assert.deepEqual([s.index, s.mapId, s.upload, s.stored, s.relocalized], [0, 'm1', 'pending', false, true]);
  assert.deepEqual(s.labels, ['salon']);
  assert.equal(h.mapFloorY, -1.4);
});

test('continue in app keeps the same frame; second segment index 1', () => {
  let h = recorded(newHouse(PID, 'Ev', T0, 'm1'));
  h = reduce(h, { type: 'continue' });
  assert.equal(h.phase, 'pickLabels');
  h = recorded(h);
  assert.equal(h.segments[1].index, 1);
  assert.equal(h.segments[1].relocalized, true);
});

test('wrong-phase events change nothing', () => {
  const h = newHouse(PID, 'Ev', T0, 'm1');
  assert.equal(reduce(h, { type: 'recordingStarted' }), h);
  assert.equal(reduce(h, { type: 'finish' }), h);
  assert.equal(reduce(h, { type: 'uploaded', index: 7, captureId: 'c' }), h);
});

test('app reopened: locked until relocalized', () => {
  let h = recorded(newHouse(PID, 'Ev', T0, 'm1'));
  h = reduce(h, { type: 'appReopened', nowMs: 1000 });
  assert.equal(h.phase, 'resuming');
  assert.equal(canRecord(h), false);
  assert.equal(relocalizeHint(h, 1000 + RELOC_HINT_MS - 1), 'none');
  assert.equal(relocalizeHint(h, 1000 + RELOC_HINT_MS), 'hint');
  assert.equal(relocalizeHint(h, 1000 + RELOC_NEW_MAP_MS), 'offerNewMap');
  h = reduce(h, { type: 'relocalized' });
  assert.equal(h.phase, 'pickLabels');
  h = recorded(h);
  assert.equal(h.segments[1].relocalized, true);
  assert.equal(h.segments[1].mapId, 'm1');
});

test('new map chosen after failed relocalization', () => {
  let h = recorded(newHouse(PID, 'Ev', T0, 'm1'));
  h = reduce(h, { type: 'appReopened', nowMs: 0 });
  h = reduce(h, { type: 'newMapStarted', mapId: 'm2' });
  assert.deepEqual([h.phase, h.mapId, h.mapBytes, h.mapFloorY], ['pickLabels', 'm2', 0, null]);
  h = recorded(h, 1.6);
  assert.equal(h.segments[1].relocalized, false);
  assert.equal(h.segments[1].mapId, 'm2');
  assert.equal(h.mapFloorY, 1.6);
});

test('needsNewMap: big map or new floor', () => {
  assert.equal(needsNewMap(recorded(newHouse(PID, 'Ev', T0, 'm1'))), false);
  assert.equal(needsNewMap(recorded(newHouse(PID, 'Ev', T0, 'm1'), -1.4, NEW_MAP_BYTES + 1)), true);
  let h = recorded(newHouse(PID, 'Ev', T0, 'm1'), -1.4);
  h = reduce(h, { type: 'continue' });
  h = recorded(h, 1.5); // stairs went up ~2.9 m
  assert.equal(needsNewMap(h), true);
});

test('upload queue: pending first, failed kept stored, retry', () => {
  let h = recorded(newHouse(PID, 'Ev', T0, 'm1'));
  h = reduce(h, { type: 'continue' });
  h = recorded(h);
  assert.equal(nextUpload(h)?.index, 0);
  h = reduce(h, { type: 'uploadStarted', index: 0 });
  assert.equal(nextUpload(h), null, 'one at a time');
  const mp = { storagePath: 'u/1/frames.zip', uploadId: 'up', partSize: 8, partCount: 2, size: 16, etags: { 1: 'a' } };
  h = reduce(h, { type: 'uploadProgress', index: 0, multipart: mp });
  assert.deepEqual(h.segments[0].multipart, mp);
  h = reduce(h, { type: 'stored', index: 0 });
  h = reduce(h, { type: 'uploadFailed', index: 0, error: 'insufficient_credits' });
  assert.equal(h.segments[0].stored, true, 'archive in R2 survives the failure');
  assert.equal(nextUpload(h)?.index, 1, 'failed is not retried automatically');
  h = reduce(h, { type: 'retryUploads' });
  assert.equal(h.segments[0].upload, 'pending');
  h = reduce(h, { type: 'uploaded', index: 0, captureId: 'c0' });
  assert.equal(h.segments[0].error, undefined);
});

test('finish waits for uploads', () => {
  let h = recorded(newHouse(PID, 'Ev', T0, 'm1'));
  h = reduce(h, { type: 'finish' });
  assert.equal(h.phase, 'finishing');
  assert.equal(allUploaded(h), false);
  h = reduce(h, { type: 'uploadStarted', index: 0 });
  h = reduce(h, { type: 'uploaded', index: 0, captureId: 'c0' });
  assert.equal(allUploaded(h), true);
  h = reduce(h, { type: 'finished' });
  assert.equal(h.phase, 'finished');
});

test('segment fields for submit-capture', () => {
  const h = recorded(newHouse(PID, 'Ev', T0, 'm1'));
  assert.deepEqual(segmentFields(h, h.segments[0]), {
    property_id: PID, segment_index: 0, labels: ['salon'], floor_height_m: -1.4, map_id: 'm1',
  });
});
