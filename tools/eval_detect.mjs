// サンプル画像に対する判定の正しさを確かめる。  node tools/eval_detect.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { detect, evaluate } from '../public/js/parking-detect.js';

const dir = fileURLToPath(new URL('../public/data/parking/', import.meta.url));
const lot = JSON.parse(readFileSync(dir + 'lot.json', 'utf8'));
const { scenes } = JSON.parse(readFileSync(dir + 'scenes.json', 'utf8'));
const W = lot.image.analysisWidth;
const H = lot.image.analysisHeight;
const load = (name) => ({ width: W, height: H, channels: 3, data: readFileSync(dir + 'scenes/' + name + '.rgb') });
const ref = load('reference');

for (const method of ['reference', 'features']) {
  for (const sc of scenes) {
    const r = detect(lot, load(sc.id), method === 'reference' ? ref : null);
    const ev = evaluate(r, sc.truthOccupied);
    const truth = new Set(sc.truthOccupied);
    const occ = r.stalls.filter((s) => truth.has(s.id)).map((s) => s.score);
    const vac = r.stalls.filter((s) => !truth.has(s.id)).map((s) => s.score);
    const f = (a) => (a.length ? `${Math.min(...a).toFixed(1)}〜${Math.max(...a).toFixed(1)}` : '-');
    console.log(`${method.padEnd(9)} ${sc.id.padEnd(8)} 正解率=${ev.accuracy} 誤検出=${ev.fp} 見逃し=${ev.fn}  占有マスのscore=${f(occ)}  空きマスのscore=${f(vac)}`);
  }
}
