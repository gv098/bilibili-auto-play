import { videoKey } from './core.js';

const cache = new Map();

export function nextInSequence(rawUrl, data) {
  const key = videoKey(rawUrl);
  if (!key) throw new Error('无法识别当前视频');
  const [id, partText] = key.split('?p=');
  if (id !== data?.bvid && id !== `av${data?.aid}`) throw new Error('分 P 信息与当前视频不一致');
  if (!Array.isArray(data.pages) || !data.pages.length) throw new Error('视频分 P 信息不完整');
  const part = Number(partText);
  if (!Number.isInteger(part) || !data.pages.some(page => page.page === part)) throw new Error('未找到当前分 P');
  const nextPart = data.pages.filter(page => Number.isInteger(page.page) && page.page > part).sort((a, b) => a.page - b.page)[0];
  if (nextPart) {
    const url = new URL(rawUrl);
    url.searchParams.set('p', String(nextPart.page));
    for (const name of ['t', 'start_progress']) url.searchParams.delete(name);
    return { url: url.href, title: `P${nextPart.page} · ${nextPart.part || '下一分 P'}` };
  }
  const episodes = (data.ugc_season?.sections || []).flatMap(section => section.episodes || []);
  const ids = [...new Set(episodes.map(episode => episode.bvid || episode.arc?.bvid).filter(id => /^BV\w+$/.test(id || '')))];
  const index = ids.indexOf(data.bvid);
  if (index < 0 || index + 1 >= ids.length) return null;
  const nextId = ids[index + 1];
  const episode = episodes.find(episode => (episode.bvid || episode.arc?.bvid) === nextId);
  return { url: `https://www.bilibili.com/video/${nextId}/`, title: episode?.title || '合集下一条' };
}

export function loadVideoData(rawUrl, refresh = false) {
  const id = videoKey(rawUrl)?.split('?p=')[0];
  if (!id) return Promise.reject(new Error('无法识别当前视频'));
  const cached = cache.get(id);
  if (!refresh && cached && cached.expires > Date.now()) return cached.promise;
  const entry = { expires: Date.now() + 5 * 60 * 1000 };
  entry.promise = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const query = id.startsWith('av') ? `aid=${id.slice(2)}` : `bvid=${encodeURIComponent(id)}`;
      const response = await fetch(`https://api.bilibili.com/x/web-interface/view?${query}`, { signal: controller.signal, credentials: 'omit' });
      if (!response.ok) throw new Error('B 站视频信息暂不可用');
      const result = await response.json();
      if (result.code !== 0 || !result.data) throw new Error('无法读取分 P / 合集信息');
      return result.data;
    } finally { clearTimeout(timer); }
  })();
  entry.promise.catch(() => { if (cache.get(id) === entry) cache.delete(id); });
  cache.set(id, entry);
  if (cache.size > 64) cache.delete(cache.keys().next().value);
  return entry.promise;
}
