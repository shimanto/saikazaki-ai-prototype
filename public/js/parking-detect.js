// 駐車マスの占有／空き判定（雛型）。ブラウザと Cloudflare Worker の両方で使う。
// 画像は { width, height, data, channels } の形（data は RGB なら3、RGBA なら4バイト/画素）。
// マス・通路のポリゴンは画像サイズに対する 0〜1 の比率で持つ。

export const DEFAULT_PARAMS = {
  shrink: 0.2, // マスのポリゴンを重心方向に縮める割合（白線を避ける）
  referenceThreshold: 18, // 基準画像との差分の閾値（0〜255）
  featureThreshold: 22, // 特徴量だけで判定するときの閾値
};

const CONGESTION = [
  { max: 0.5, level: 1, label: '空いています' },
  { max: 0.8, level: 2, label: 'やや混雑' },
  { max: 0.95, level: 3, label: '混雑' },
  { max: Infinity, level: 4, label: '満車に近い' },
];

export function congestionOf(rate) {
  const c = CONGESTION.find((x) => rate < x.max) || CONGESTION[CONGESTION.length - 1];
  return { level: c.level, label: c.label };
}

function toPixels(poly, img) {
  return poly.map(([x, y]) => [x * img.width, y * img.height]);
}

function shrinkPoly(pts, k) {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  return pts.map(([x, y]) => [x + (cx - x) * k, y + (cy - y) * k]);
}

function inside(pts, x, y) {
  let hit = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

// ポリゴン内の画素の位置（data の添字）を列挙する
function pixelIndexes(poly, img, shrink) {
  const pts = shrinkPoly(toPixels(poly, img), shrink);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const x1 = Math.min(img.width - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(img.height - 1, Math.ceil(Math.max(...ys)));
  const ch = img.channels || 4;
  const out = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (inside(pts, x + 0.5, y + 0.5)) out.push((y * img.width + x) * ch);
    }
  }
  return out;
}

const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

function regionStats(img, idx) {
  const d = img.data;
  let sl = 0, sl2 = 0, sr = 0, sg = 0, sb = 0, ssat = 0;
  for (const i of idx) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const l = lum(d, i);
    sl += l; sl2 += l * l; sr += r; sg += g; sb += b;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    ssat += mx === 0 ? 0 : (mx - mn) / mx;
  }
  const n = idx.length || 1;
  const mean = sl / n;
  return {
    n: idx.length,
    lum: mean,
    std: Math.sqrt(Math.max(0, sl2 / n - mean * mean)),
    rgb: [sr / n, sg / n, sb / n],
    sat: ssat / n,
  };
}

// 通路の平均（露出の補正・舗装色の基準）
function controlStats(img, controls) {
  const idx = controls.flatMap((c) => pixelIndexes(c, img, 0.1));
  return regionStats(img, idx);
}

/**
 * マスごとの判定
 * @param {object} lot   lot.json（stalls, controls）
 * @param {object} img   入力画像
 * @param {object|null} ref 空車の基準画像（同じサイズ）。null なら特徴量だけで判定
 * @param {object} params DEFAULT_PARAMS の上書き
 */
export function detect(lot, img, ref = null, params = {}) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const useRef = !!ref && ref.width === img.width && ref.height === img.height;
  const method = useRef ? 'reference' : 'features';
  const ctl = controlStats(img, lot.controls || []);
  let gain = 1;
  if (useRef) {
    const rctl = controlStats(ref, lot.controls || []);
    gain = ctl.lum > 0 ? rctl.lum / ctl.lum : 1;
  }
  const threshold = useRef ? p.referenceThreshold : p.featureThreshold;
  const ch = img.channels || 4;
  const rch = ref ? ref.channels || 4 : ch;

  const stalls = lot.stalls.map((s) => {
    const idx = pixelIndexes(s.poly, img, p.shrink);
    let score;
    if (useRef) {
      // 露出を合わせたうえで、画素ごとの RGB 差の平均
      let sum = 0;
      for (const i of idx) {
        const j = (i / ch) * rch;
        sum += (Math.abs(img.data[i] * gain - ref.data[j]) +
          Math.abs(img.data[i + 1] * gain - ref.data[j + 1]) +
          Math.abs(img.data[i + 2] * gain - ref.data[j + 2])) / 3;
      }
      score = sum / (idx.length || 1);
    } else {
      const st = regionStats(img, idx);
      const colorDist = Math.hypot(st.rgb[0] - ctl.rgb[0], st.rgb[1] - ctl.rgb[1], st.rgb[2] - ctl.rgb[2]) / Math.sqrt(3);
      score = st.std * 0.8 + colorDist * 0.6 + Math.max(0, st.sat - ctl.sat) * 60;
    }
    const occupied = score > threshold;
    const margin = Math.abs(score - threshold) / threshold;
    const confidence = Math.min(0.99, 0.5 + margin * 0.5);
    return { id: s.id, state: occupied ? 'occupied' : 'vacant', score: Math.round(score * 10) / 10, confidence: Math.round(confidence * 100) / 100 };
  });

  const total = stalls.length;
  const occupied = stalls.filter((s) => s.state === 'occupied').length;
  const rate = total ? occupied / total : 0;
  return {
    method,
    threshold,
    exposureGain: Math.round(gain * 1000) / 1000,
    summary: {
      total,
      occupied,
      vacant: total - occupied,
      occupancyRate: Math.round(rate * 1000) / 1000,
      congestion: congestionOf(rate),
    },
    stalls,
  };
}

// 正解（占有マスの ID 一覧）との照合
export function evaluate(result, truthOccupied) {
  const truth = new Set(truthOccupied);
  let tp = 0, tn = 0, fp = 0, fn = 0;
  for (const s of result.stalls) {
    const t = truth.has(s.id);
    const o = s.state === 'occupied';
    if (o && t) tp++; else if (!o && !t) tn++; else if (o) fp++; else fn++;
  }
  const n = tp + tn + fp + fn;
  return { accuracy: n ? Math.round(((tp + tn) / n) * 1000) / 1000 : 0, tp, tn, fp, fn };
}
