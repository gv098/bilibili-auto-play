import test from 'node:test';
import assert from 'node:assert/strict';
import { nextInSequence, loadVideoData } from '../sequence.js';

const url = 'https://www.bilibili.com/video/BVparts/';
const data = { bvid: 'BVparts', aid: 123, pages: [{ page: 1, part: 'One' }, { page: 2, part: 'Two' }, { page: 3, part: 'Three' }] };
test('parts continue in the same tab from current P and clear old seek positions', () => {
  const next = nextInSequence(`${url}?p=2&t=80&start_progress=50`, data);
  assert.equal(next.url, `${url}?p=3`);
  assert.equal(next.title, 'P3 · Three');
  assert.equal(nextInSequence(`${url}?p=3`, data), null);
  assert.equal(new URL(nextInSequence('https://www.bilibili.com/video/av123/', data).url).searchParams.get('p'), '2');
});
test('finish parts before continuing collection order, without wrapping to first episode', () => {
  const collection = { ...data, ugc_season: { sections: [
    { episodes: [{ bvid: 'BVbefore' }, { bvid: 'BVparts' }] },
    { episodes: [{ bvid: 'BVparts' }, { bvid: 'BVafter', title: 'Next episode' }] },
  ] } };
  assert.equal(new URL(nextInSequence(url, collection).url).searchParams.get('p'), '2');
  assert.deepEqual(nextInSequence(`${url}?p=3`, collection), { url: 'https://www.bilibili.com/video/BVafter/', title: 'Next episode' });
  assert.equal(nextInSequence('https://www.bilibili.com/video/BVafter/?p=3', { ...collection, bvid: 'BVafter' }), null);
});
test('invalid and stale metadata cannot silently skip a part', () => {
  assert.throws(() => nextInSequence(url, { ...data, bvid: 'BVother' }));
  assert.throws(() => nextInSequence(url, { ...data, pages: [] }));
  assert.throws(() => nextInSequence(`${url}?p=8`, data));
});
test('public metadata fetch omits credentials, shares in-flight reads, and retries failures', async () => {
  let count = 0;
  globalThis.fetch = async (request, options) => {
    count++;
    assert.equal(new URL(request).hostname, 'api.bilibili.com');
    assert.equal(options.credentials, 'omit');
    return { ok: true, async json() { return { code: count === 1 ? -1 : 0, data }; } };
  };
  await assert.rejects(loadVideoData(url));
  const [a, b] = await Promise.all([loadVideoData(url), loadVideoData(`${url}?p=2`)]);
  assert.equal(count, 2);
  assert.deepEqual(a, b);
});
