import { detect } from '/js/parking-detect.js';

const $ = (id) => document.getElementById(id);
const state = { lot: null, scenes: [], scene: null, method: 'reference', result: null, image: null, upload: null, truth: null };

// ---- 地理院タイル（z17 の 3x3）で場所を表示 ----
function tileXY(lat, lon, z) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const y = ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n;
  return { x, y };
}
function drawTileMap(lot) {
  const z = 17;
  const el = $('tilemap');
  const c = tileXY(lot.center.lat, lot.center.lon, z);
  // 駐車場が中央付近に来るよう、左上のタイルを決める
  const x0 = Math.floor(c.x - 1.5 + 0.5);
  const y0 = Math.floor(c.y - 1.5 + 0.5);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const img = document.createElement('img');
      img.src = `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${z}/${x0 + i}/${y0 + j}.jpg`;
      img.alt = '';
      img.loading = 'lazy';
      img.style.left = `${(i * 100) / 3}%`;
      img.style.top = `${(j * 100) / 3}%`;
      el.appendChild(img);
    }
  }
  const pct = (t, t0) => `${((t - t0) / 3) * 100}%`;
  const nw = tileXY(lot.bounds.nw.lat, lot.bounds.nw.lon, z);
  const se = tileXY(lot.bounds.se.lat, lot.bounds.se.lon, z);
  const mark = document.createElement('div');
  mark.className = 'mark';
  mark.style.left = pct(nw.x, x0);
  mark.style.top = pct(nw.y, y0);
  mark.style.width = `${((se.x - nw.x) / 3) * 100}%`;
  mark.style.height = `${((se.y - nw.y) / 3) * 100}%`;
  el.appendChild(mark);
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = 'デモの駐車場エリア';
  label.style.left = pct(nw.x, x0);
  label.style.top = `calc(${pct(se.y, y0)} + 6px)`;
  el.appendChild(label);
  const port = tileXY(34.18852, 135.14626, z); // 漁港の船だまり付近
  const pl = document.createElement('div');
  pl.className = 'label';
  pl.textContent = '雑賀崎漁港';
  pl.style.left = pct(port.x, x0);
  pl.style.top = pct(port.y, y0);
  el.appendChild(pl);
}

// ---- 描画 ----
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function render() {
  const cv = $('view');
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (state.image) ctx.drawImage(state.image, 0, 0, cv.width, cv.height);
  if (!state.result) return;
  const byId = Object.fromEntries(state.result.stalls.map((s) => [s.id, s]));
  for (const s of state.lot.stalls) {
    const r = byId[s.id];
    if (!r) continue;
    const occ = r.state === 'occupied';
    ctx.beginPath();
    s.poly.forEach(([x, y], i) => (i ? ctx.lineTo(x * cv.width, y * cv.height) : ctx.moveTo(x * cv.width, y * cv.height)));
    ctx.closePath();
    ctx.fillStyle = occ ? 'rgba(192,57,43,0.28)' : 'rgba(31,138,76,0.32)';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = occ ? '#c0392b' : '#1f8a4c';
    ctx.stroke();
  }
}

function showResult(res, sourceText) {
  state.result = res;
  const s = res.summary;
  $('vacant').innerHTML = `${s.vacant}<small> 台</small>`;
  $('occupied').innerHTML = `${s.occupied}<small> 台</small>`;
  $('rate').innerHTML = `${Math.round(s.occupancyRate * 100)}<small> %</small>`;
  $('congestion').innerHTML = `<span class="congestion-${s.congestion.level}" style="font-size:1.2rem">${s.congestion.label}</span>`;
  $('source-line').textContent = `${sourceText} ／ 判定方法: ${res.method === 'reference' ? '基準画像との差分' : '特徴量のみ'}（閾値 ${res.threshold}）／ 全${s.total}マス`;
  const grid = $('stall-grid');
  grid.innerHTML = '';
  const rows = {};
  for (const st of res.stalls) (rows[st.id.split('-')[0]] ||= []).push(st);
  for (const [row, list] of Object.entries(rows)) {
    const div = document.createElement('div');
    div.className = 'stall-row';
    div.innerHTML = `<b>${row}</b>` + list.map((x) => `<span class="stall ${x.state}" title="${x.id}: ${x.state === 'occupied' ? '占有' : '空き'}（score ${x.score}）"></span>`).join('');
    grid.appendChild(div);
  }
  if (state.truth && !state.upload) {
    const truth = new Set(state.truth);
    const ok = res.stalls.filter((x) => (x.state === 'occupied') === truth.has(x.id)).length;
    $('accuracy').textContent = `参考: 疑似画像を作ったときの正解と比べた一致率 ${ok}/${res.stalls.length} マス（疑似画像なので実際の精度ではありません）`;
  } else {
    $('accuracy').textContent = '';
  }
  render();
}

// ---- サンプル画像（サーバーの API で判定） ----
async function loadScene() {
  state.upload = null;
  $('back-to-sample').hidden = true;
  $('upload-note').textContent = '';
  const url = `/api/parking/status?scene=${encodeURIComponent(state.scene)}&method=${state.method}`;
  $('api-link').href = url;
  $('api-link').textContent = url;
  const [res, img] = await Promise.all([fetch(url).then((r) => r.json()), loadImage(state.scenes.find((s) => s.id === state.scene).image)]);
  state.image = img;
  const sc = state.allScenes.find((s) => s.id === state.scene);
  state.truth = sc ? sc.truthOccupied : null;
  showResult(res, `入力: ${res.scene.label}（サーバーで判定）`);
}

// ---- アップロード画像（ブラウザ内で判定） ----
let refCache = null;
async function referenceImage() {
  if (refCache) return refCache;
  const buf = new Uint8Array(await (await fetch(state.lot.reference)).arrayBuffer());
  refCache = { width: state.lot.image.analysisWidth, height: state.lot.image.analysisHeight, channels: 3, data: buf };
  return refCache;
}
async function analyzeUpload(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const w = state.lot.image.analysisWidth;
    const h = state.lot.image.analysisHeight;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h);
    const input = { width: w, height: h, channels: 4, data: data.data };
    const ref = state.method === 'reference' ? await referenceImage() : null;
    state.image = img;
    state.upload = file.name;
    showResult(detect(state.lot, input, ref), `入力: ${file.name}（ブラウザ内で判定・送信なし）`);
    $('back-to-sample').hidden = false;
    $('upload-note').textContent = `画像を ${w}×${h} に縮小して判定しました。縦横比が違う画像は引き伸ばされます。`;
  } catch {
    $('upload-note').textContent = '画像を読み込めませんでした。';
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---- マスを押したとき ----
function pointInPoly(pts, x, y) {
  let hit = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
$('view').addEventListener('click', (e) => {
  if (!state.result) return;
  const r = e.target.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  const s = state.lot.stalls.find((st) => pointInPoly(st.poly, x, y));
  if (!s) { $('stall-info').innerHTML = '&nbsp;'; return; }
  const res = state.result.stalls.find((st) => st.id === s.id);
  $('stall-info').textContent = `マス ${s.id}: ${res.state === 'occupied' ? '占有' : '空き'}（score ${res.score} ／ 閾値 ${state.result.threshold} ／ 確からしさ ${Math.round(res.confidence * 100)}%）`;
});

function setPressed(container, attr, value) {
  for (const b of container.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset[attr] === value));
}

async function init() {
  const [lot, scenes, all] = await Promise.all([
    fetch('/data/parking/lot.json').then((r) => r.json()),
    fetch('/api/parking/scenes').then((r) => r.json()),
    fetch('/data/parking/scenes.json').then((r) => r.json()),
  ]);
  state.lot = lot;
  state.scenes = scenes.scenes;
  state.allScenes = all.scenes;
  state.scene = scenes.default;
  drawTileMap(lot);
  const box = $('scenes');
  for (const s of state.scenes) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.scene = s.id;
    b.textContent = s.label.replace(/（.*）/, '');
    b.title = s.label;
    b.addEventListener('click', () => { state.scene = s.id; setPressed(box, 'scene', s.id); loadScene(); });
    box.appendChild(b);
  }
  setPressed(box, 'scene', state.scene);
  $('methods').addEventListener('click', (e) => {
    const m = e.target.dataset?.method;
    if (!m) return;
    state.method = m;
    setPressed($('methods'), 'method', m);
    const file = $('upload').files[0];
    if (state.upload && file) analyzeUpload(file);
    else loadScene();
  });
  $('upload').addEventListener('change', (e) => { if (e.target.files[0]) analyzeUpload(e.target.files[0]); });
  $('back-to-sample').addEventListener('click', () => { $('upload').value = ''; loadScene(); });
  await loadScene();
}

init().catch((e) => {
  console.error(e);
  $('source-line').textContent = 'データの読み込みに失敗しました。再読み込みしてください。';
});
