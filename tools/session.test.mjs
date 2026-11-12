// node --test tools/
import test from 'node:test';
import assert from 'node:assert/strict';
import { SET, PLAN, planFor, nextSlot } from '../js/session.js';

test('slots run 1 to 7, then a new set starts', () => {
  assert.deepEqual(nextSlot(null), { setNo: 0, pos: 1, start: true });
  assert.deepEqual(nextSlot({ setNo: 4, pos: 3 }), { setNo: 4, pos: 4, start: false });
  assert.deepEqual(nextSlot({ setNo: 4, pos: SET }), { setNo: 5, pos: 1, start: true });
});

test('the plan has seven slots: one anchor first, the peak last', () => {
  assert.equal(PLAN.length, SET);
  assert.equal(PLAN[0], 'anchor');
  assert.equal(PLAN[SET - 1], 'peak');
});

test('adaptation: mostly skipped drops the stretch, nothing skipped adds one', () => {
  const skipped = Array(4).fill('skip').concat(Array(3).fill('dwell'));
  assert.ok(!planFor({ sittingSet: 1, previous: skipped }).includes('stretch'));
  const clean = Array(SET).fill('dwell');
  assert.equal(planFor({ sittingSet: 1, previous: clean }).filter((k) => k === 'stretch').length, 2);
  assert.deepEqual(planFor({ sittingSet: 1, previous: null }), PLAN);
});

test('long sittings lean toward rest from the fourth set', () => {
  const rests = (p) => p.filter((k) => k === 'rest').length;
  assert.ok(rests(planFor({ sittingSet: 3, previous: null })) > rests(planFor({ sittingSet: 2, previous: null })));
});

test('pace lowers the score of works far from the slot energy and leaves unknown ones alone', async () => {
  const { pace } = await import('../js/session.js');
  const scores = Float32Array.from([1, 1, 1]);
  const energy = Uint8Array.from([255, 38, 0]); // intense, still, unknown
  const peak = pace(scores, energy, 'peak');
  assert.ok(peak[0] > peak[1]);
  assert.equal(peak[2], 1);
  const rest = pace(scores, energy, 'rest');
  assert.ok(rest[1] > rest[0]);
  assert.equal(pace(scores, null, 'peak'), scores);
});

test('a profile learned in the 64-d model is widened, not reset, when the vector gains blocks', async () => {
  const { migration } = await import('../js/store.js');
  const state = { embedModel: 'm-v1', saved: [], profile: { cents: [{ v: [0.6, 0.8], n: 1 }], negs: [], cat: {}, ver: 3 } };
  const out = await migration(state, { manifest: { model: 'm-v1+blocks-v1', dim: 4 }, rooms: {} });
  assert.deepEqual(out.profile.cents[0].v, [0.6, 0.8, 0, 0]);
  assert.equal(out.embedModel, 'm-v1+blocks-v1');
  assert.ok(out.profile.attrs);
});
