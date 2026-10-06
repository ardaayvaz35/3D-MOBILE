import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doneParts, missingParts, partRange, readEtag } from './multipartPlan.ts';
import type { MultipartState } from '../house/houseSession.ts';

const S = (etags: Record<number, string> = {}): MultipartState => ({
  storagePath: 'u/1/frames.zip', uploadId: 'up', partSize: 10, partCount: 3, size: 25, etags,
});

test('ranges: equal parts, short last', () => {
  assert.deepEqual(partRange(S(), 1), { position: 0, length: 10 });
  assert.deepEqual(partRange(S(), 3), { position: 20, length: 5 });
  assert.throws(() => partRange(S(), 0));
  assert.throws(() => partRange(S(), 4));
});

test('missing parts after a crash', () => {
  assert.deepEqual(missingParts(S()), [1, 2, 3]);
  assert.deepEqual(missingParts(S({ 1: '"a"', 3: '"c"' })), [2]);
  assert.deepEqual(missingParts(S({ 1: 'a', 2: 'b', 3: 'c' })), []);
});

test('etag header in any case', () => {
  assert.equal(readEtag({ ETag: '"x"' }), '"x"');
  assert.equal(readEtag({ etag: '"y"' }), '"y"');
  assert.equal(readEtag({ Etag: '"z"' }), '"z"');
  assert.equal(readEtag({}), null);
});

test('done parts for complete', () => {
  assert.deepEqual(doneParts(S({ 2: 'b', 1: 'a' })), [
    { part_number: 1, etag: 'a' }, { part_number: 2, etag: 'b' },
  ]);
});
