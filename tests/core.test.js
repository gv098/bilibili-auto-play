import test from 'node:test';
import assert from 'node:assert/strict';
import { videoKey, validSpeed, orderedVideos, newState, policyFor } from '../core.js';

test('accepts ordinary desktop videos and distinguishes parts, rejecting other origins', () => {
  assert.equal(videoKey('https://www.bilibili.com/video/BV1CN8g6yEwJ/?spm_id_from=333&p=2'), 'BV1CN8g6yEwJ?p=2');
  assert.equal(videoKey('https://www.bilibili.com/video/av123'), 'av123?p=1');
  for (const url of ['https://evil.test/video/BV123', 'https://www.bilibili.com.evil.test/video/BV123', 'https://live.bilibili.com/123', 'https://www.bilibili.com/bangumi/play/ep123', 'garbage']) assert.equal(videoKey(url), null);
});
test('supports precise playback rates and rejects unsupported values', () => {
  for (const speed of [0.0625, 1.25, 2.75, 16]) assert.equal(validSpeed(String(speed)), speed);
  for (const speed of [0, -1, 16.01, Infinity, NaN, '', 'abc']) assert.throws(() => validSpeed(speed));
});
test('queue uses browser tab order and preserves duplicate video tabs', () => {
  const url = 'https://www.bilibili.com/video/BV123/';
  assert.deepEqual(orderedVideos([{ id: 1, index: 5, url }, { id: 2, index: 1, url }, { id: 3, index: 0, url: 'https://example.com' }]).map(item => item.id), [2, 1]);
});
test('only the active queue member receives play permission', () => {
  const state = { ...newState(), status: 'running', activeTabId: 1, items: [{ id: 1 }, { id: 2 }] };
  assert.equal(policyFor(state, 1).mode, 'play');
  assert.equal(policyFor(state, 2).mode, 'hold');
  assert.equal(policyFor(state, 3).mode, 'free');
  state.status = 'paused';
  assert.equal(policyFor(state, 1).mode, 'paused');
  assert.equal(policyFor(state, 2).mode, 'hold');
  state.status = 'idle';
  assert.equal(policyFor(state, 2).mode, 'free');
});
