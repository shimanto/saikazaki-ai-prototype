// 滞在ポイントアプリ
const $ = (id) => document.getElementById(id);
const TICKET_COST = 500;
let me = null;
let spots = [];

const fmt = (iso) => new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4500);
}

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `エラー（${res.status}）`);
  return data;
}

// ---- QR の中身（URL）から拠点を取り出す ----
function parseSpotUrl(text) {
  try {
    const u = new URL(text, location.origin);
    const spot = u.searchParams.get('spot');
    const k = u.searchParams.get('k');
    if (u.origin === location.origin && spot && k) return { spot, k };
  } catch { /* URL でない */ }
  return null;
}

async function doCheckin(spot, k) {
  try {
    const r = await api('/api/checkin', { method: 'POST', body: JSON.stringify({ spot, k }) });
    const detail = r.breakdown.map((b) => `${b.label} +${b.points}pt`).join('、');
    let msg = `「${r.spot.name}」にチェックインしました。+${r.points}pt（${detail}）`;
    if (r.message) msg += ` ${r.message}`;
    if (r.canIssueTicket) msg += ' チケットを発行できます！';
    toast(msg);
  } catch (e) {
    toast(e.message, true);
  }
  await refresh();
}

// ---- 画面の更新 ----
async function refresh() {
  const w = await api('/api/wallet');
  $('balance').textContent = w.balance.toLocaleString('ja-JP');
  const pct = Math.min(100, (w.balance / TICKET_COST) * 100);
  $('progress').style.width = `${pct}%`;
  $('to-ticket').textContent = w.canIssueTicket ? 'チケットを発行できます' : `チケットまであと ${TICKET_COST - w.balance}pt`;
  $('issue').disabled = !w.canIssueTicket;

  const visit = $('visit');
  if (w.visit) {
    const done = new Set(w.visit.checkins.map((c) => c.spot_id));
    visit.className = 'small';
    visit.innerHTML = `<p style="margin:0 0 6px">来訪開始: ${fmt(w.visit.startedAt)}（出発のQRを読み取ると滞在ポイントが加算されます）</p>` +
      '<ul class="list">' + spots.map((s) => `<li><span>${esc(s.name)}</span><span>${done.has(s.id) ? '<span class="badge ok">済</span>' : '<span class="muted">未</span>'}</span></li>`).join('') + '</ul>';
  } else {
    visit.className = 'small muted';
    visit.textContent = 'まだ到着チェックインをしていません（前回の来訪は終了しています）。';
  }

  const tk = $('tickets');
  tk.innerHTML = w.tickets.length ? '' : '<p class="small muted">まだチケットはありません。</p>';
  for (const t of w.tickets) {
    const div = document.createElement('div');
    div.className = 'ticket' + (t.status === 'used' ? ' used' : '');
    div.innerHTML = `<div><div class="small">次回のお買い物チケット</div><div class="code">${esc(t.code)}</div><div class="small muted">発行 ${fmt(t.issued_at)}${t.used_at ? ` ／ 使用 ${fmt(t.used_at)}` : ''}</div></div>`;
    if (t.status === 'unused') {
      const b = document.createElement('button');
      b.className = 'btn small secondary';
      b.textContent = '店舗で使う（デモ）';
      b.addEventListener('click', async () => {
        if (!confirm('このチケットを使用済みにします。よろしいですか？（店舗での操作のデモ）')) return;
        try { await api(`/api/tickets/${t.id}/use`, { method: 'POST' }); toast('チケットを使用済みにしました'); } catch (e) { toast(e.message, true); }
        refresh();
      });
      div.appendChild(b);
    } else {
      div.insertAdjacentHTML('beforeend', '<span class="badge">使用済み</span>');
    }
    tk.appendChild(div);
  }

  $('ledger').innerHTML = w.ledger.length
    ? w.ledger.map((l) => `<li><span>${esc(l.label)}<br><span class="small muted">${fmt(l.at)}</span></span><span class="${l.delta > 0 ? 'plus' : 'minus'}">${l.delta > 0 ? '+' : ''}${l.delta}pt</span></li>`).join('')
    : '<li class="muted">まだ履歴はありません。</li>';
}

// ---- カメラで QR を読み取る ----
let stream = null;
let scanning = false;
async function startScan() {
  if (!navigator.mediaDevices?.getUserMedia) { toast('この端末ではカメラを使えません。下のデモ用ボタンをお使いください', true); return; }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch {
    toast('カメラを起動できませんでした（許可をご確認ください）', true);
    return;
  }
  const video = $('video');
  video.srcObject = stream;
  await video.play();
  $('scanner').hidden = false;
  $('scan').hidden = true;
  $('scan-msg').textContent = '拠点のQRコードを枠内に写してください。';
  scanning = true;
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const tick = () => {
    if (!scanning) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      const scale = Math.min(1, 640 / video.videoWidth);
      cv.width = Math.round(video.videoWidth * scale);
      cv.height = Math.round(video.videoHeight * scale);
      ctx.drawImage(video, 0, 0, cv.width, cv.height);
      const img = ctx.getImageData(0, 0, cv.width, cv.height);
      const code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
      if (code?.data) {
        const p = parseSpotUrl(code.data);
        if (p) { stopScan(); doCheckin(p.spot, p.k); return; }
        $('scan-msg').textContent = 'このQRコードは拠点のQRではありません。';
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
function stopScan() {
  scanning = false;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  $('scanner').hidden = true;
  $('scan').hidden = false;
}

// ---- 起動 ----
async function init() {
  const params = new URLSearchParams(location.search);
  const scanned = params.get('spot') && params.get('k') ? { spot: params.get('spot'), k: params.get('k') } : null;
  if (scanned) sessionStorage.setItem('pendingCheckin', JSON.stringify(scanned));
  if (params.get('error')) { $('error-box').textContent = params.get('error'); $('error-box').hidden = false; }
  if (location.search) history.replaceState(null, '', '/app/');

  me = await api('/api/me');
  $('mode-demo').hidden = me.mode !== 'demo';
  const pending = JSON.parse(sessionStorage.getItem('pendingCheckin') || 'null');

  if (!me.loggedIn) {
    $('login-view').hidden = false;
    $('pending-checkin').hidden = !pending;
    if (me.mode === 'line') {
      $('line-login').hidden = false;
      $('line-login').href = '/auth/login?next=/app/';
    } else {
      $('demo-login').hidden = false;
      $('demo-login').addEventListener('click', async () => {
        try { await api('/auth/demo', { method: 'POST' }); location.reload(); } catch (e) { toast(e.message, true); }
      });
    }
    return;
  }

  $('main-view').hidden = false;
  $('user-name').textContent = me.user.name;
  $('reset').hidden = me.user.provider !== 'demo';
  spots = (await api('/api/spots')).spots;
  const box = $('spot-buttons');
  for (const s of spots) {
    const p = parseSpotUrl(s.qr);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn secondary';
    b.innerHTML = `${esc(s.name)}<small>${s.kind === 'departure' ? '50pt＋滞在' : `${s.points}pt`}</small>`;
    b.addEventListener('click', () => doCheckin(p.spot, p.k));
    box.appendChild(b);
  }
  $('scan').addEventListener('click', startScan);
  $('scan-stop').addEventListener('click', stopScan);
  $('issue').addEventListener('click', async () => {
    try {
      const r = await api('/api/tickets', { method: 'POST' });
      toast(`チケット ${r.ticket.code} を発行しました`);
    } catch (e) { toast(e.message, true); }
    refresh();
  });
  $('logout').addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    location.href = '/app/';
  });
  $('reset').addEventListener('click', async () => {
    if (!confirm('このデモ利用者のポイント・チケット・来訪の記録をすべて消します。よろしいですか？')) return;
    try { await api('/api/demo/reset', { method: 'POST' }); toast('デモデータをリセットしました'); } catch (e) { toast(e.message, true); }
    refresh();
  });

  await refresh();
  if (pending) {
    sessionStorage.removeItem('pendingCheckin');
    await doCheckin(pending.spot, pending.k);
  }
}

init().catch((e) => {
  console.error(e);
  $('error-box').textContent = '読み込みに失敗しました。再読み込みしてください。';
  $('error-box').hidden = false;
});
