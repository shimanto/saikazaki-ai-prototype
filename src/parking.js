// 駐車場の判定 API。判定ロジックはブラウザと同じ public/js/parking-detect.js を使う。
import { detect } from '../public/js/parking-detect.js';
import { error, json } from './util.js';

const cache = new Map(); // 同じ isolate の中で、読み込んだデータと判定結果を使い回す

async function asset(env, req, path, type) {
  const key = `asset:${path}`;
  if (cache.has(key)) return cache.get(key);
  const res = await env.ASSETS.fetch(new Request(new URL(path, req.url)));
  if (!res.ok) throw new Error(`asset ${path} ${res.status}`);
  const v = type === 'json' ? await res.json() : new Uint8Array(await res.arrayBuffer());
  cache.set(key, v);
  return v;
}

async function loadRaw(env, req, lot, path) {
  const data = await asset(env, req, path, 'bin');
  return { width: lot.image.analysisWidth, height: lot.image.analysisHeight, channels: 3, data };
}

export async function scenes(req, env) {
  const s = await asset(env, req, '/data/parking/scenes.json', 'json');
  return json({
    default: s.default,
    scenes: s.scenes.map(({ id, label, image }) => ({ id, label, image })),
    demo: true,
  });
}

export async function status(req, env) {
  const url = new URL(req.url);
  const lot = await asset(env, req, '/data/parking/lot.json', 'json');
  const s = await asset(env, req, '/data/parking/scenes.json', 'json');
  const sceneId = url.searchParams.get('scene') || s.default;
  const method = url.searchParams.get('method') === 'features' ? 'features' : 'reference';
  const scene = s.scenes.find((x) => x.id === sceneId);
  if (!scene) return error(404, `サンプル画像 ${sceneId} はありません`, { scenes: s.scenes.map((x) => x.id) });

  const key = `result:${scene.id}:${method}`;
  let result = cache.get(key);
  if (!result) {
    const img = await loadRaw(env, req, lot, scene.raw);
    const ref = method === 'reference' ? await loadRaw(env, req, lot, lot.reference) : null;
    result = detect(lot, img, ref);
    cache.set(key, result);
  }
  return json({
    demo: true,
    notice: 'デモ: 国土地理院の空中写真に車両を合成した疑似画像を判定した結果です。実際の駐車状況ではありません。',
    lot: { id: lot.id, name: lot.name, lat: lot.center.lat, lon: lot.center.lon },
    scene: { id: scene.id, label: scene.label, image: scene.image, capturedAt: null, source: '国土地理院 空中写真を加工した疑似画像' },
    method: result.method,
    threshold: result.threshold,
    exposureGain: result.exposureGain,
    summary: result.summary,
    stalls: result.stalls,
    attribution: lot.attribution,
    generatedAt: new Date().toISOString(),
  });
}
