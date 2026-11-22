// 拠点チェックイン・ポイント・デジタルチケット
import { error, json, jstDayStartIso, newId, nowIso, randomToken } from './util.js';

export const TICKET_COST = 500;
const STAY_STEP_MIN = 10; // 滞在 10 分ごとに
const STAY_STEP_PT = 10; //  10pt
const STAY_MAX_PT = 300; // 上限
const VISIT_EXPIRE_HOURS = 12; // これより古い未終了の来訪は打ち切る

export async function balanceOf(env, userId) {
  const r = await env.DB.prepare('SELECT COALESCE(SUM(delta), 0) AS b FROM point_ledger WHERE user_id = ?').bind(userId).first();
  return r.b;
}

async function openVisit(env, userId) {
  const v = await env.DB.prepare('SELECT * FROM visits WHERE user_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1')
    .bind(userId).first();
  if (!v) return null;
  if (Date.now() - Date.parse(v.started_at) > VISIT_EXPIRE_HOURS * 3600e3) {
    // 出発チェックインのない古い来訪は、滞在ポイントなしで終了
    await env.DB.prepare('UPDATE visits SET ended_at = ?, stay_minutes = 0 WHERE id = ?').bind(nowIso(), v.id).run();
    return null;
  }
  return v;
}

export async function listSpots(req, env) {
  const origin = new URL(req.url).origin;
  const { results } = await env.DB.prepare('SELECT id, name, kind, points, qr_key, description FROM spots ORDER BY sort').all();
  return json({
    spots: results.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      points: s.points,
      description: s.description,
      qr: `${origin}/app/?spot=${encodeURIComponent(s.id)}&k=${encodeURIComponent(s.qr_key)}`,
    })),
  });
}

// POST /api/checkin { spot, k }
export async function checkin(req, env, user) {
  let body;
  try { body = await req.json(); } catch { return error(400, 'リクエストの形式が正しくありません'); }
  const spot = await env.DB.prepare('SELECT * FROM spots WHERE id = ?').bind(String(body.spot || '')).first();
  if (!spot || spot.qr_key !== String(body.k || '')) return error(400, 'QRコードが正しくありません');

  const now = new Date();
  const nowS = now.toISOString();
  let visit = await openVisit(env, user.id);
  const stmts = [];
  const breakdown = [];
  let message = '';

  if (spot.kind === 'arrival') {
    if (visit) return error(409, 'すでに到着チェックイン済みです。出発時に「出発」のQRを読み取ってください');
    visit = { id: newId(), started_at: nowS };
    stmts.push(env.DB.prepare('INSERT INTO visits (id, user_id, started_at) VALUES (?, ?, ?)').bind(visit.id, user.id, nowS));
    const already = await env.DB.prepare(
      "SELECT 1 FROM point_ledger WHERE user_id = ? AND reason = 'checkin:arrival' AND created_at >= ? LIMIT 1",
    ).bind(user.id, jstDayStartIso(now)).first();
    if (already) message = '到着ポイントは1日1回までです（来訪は記録しました）';
    else breakdown.push({ label: spot.name, points: spot.points, reason: 'checkin:arrival' });
  } else {
    if (!visit) {
      // 到着を読み取らずに来た場合は、ここで来訪を開始する
      visit = { id: newId(), started_at: nowS };
      stmts.push(env.DB.prepare('INSERT INTO visits (id, user_id, started_at) VALUES (?, ?, ?)').bind(visit.id, user.id, nowS));
    } else {
      const dup = await env.DB.prepare('SELECT 1 FROM checkins WHERE visit_id = ? AND spot_id = ?').bind(visit.id, spot.id).first();
      if (dup) return error(409, `「${spot.name}」はこの来訪でチェックイン済みです`);
    }
    breakdown.push({ label: spot.name, points: spot.points, reason: `checkin:${spot.id}` });
    if (spot.kind === 'departure') {
      const minutes = Math.max(0, Math.floor((now - Date.parse(visit.started_at)) / 60e3));
      const stayPts = Math.min(STAY_MAX_PT, Math.floor(minutes / STAY_STEP_MIN) * STAY_STEP_PT);
      breakdown.push({ label: `滞在ポイント（${minutes}分）`, points: stayPts, reason: 'stay' });
      stmts.push(env.DB.prepare('UPDATE visits SET ended_at = ?, stay_minutes = ? WHERE id = ?').bind(nowS, minutes, visit.id));
    }
  }

  const total = breakdown.reduce((s, b) => s + b.points, 0);
  const checkinId = newId();
  stmts.push(env.DB.prepare('INSERT INTO checkins (id, user_id, visit_id, spot_id, points, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(checkinId, user.id, visit.id, spot.id, total, nowS));
  for (const b of breakdown) {
    if (b.points > 0) {
      stmts.push(env.DB.prepare('INSERT INTO point_ledger (id, user_id, delta, reason, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(newId(), user.id, b.points, b.reason, checkinId, nowS));
    }
  }
  try {
    await env.DB.batch(stmts);
  } catch (e) {
    if (String(e).includes('UNIQUE')) return error(409, `「${spot.name}」はこの来訪でチェックイン済みです`);
    throw e;
  }
  const balance = await balanceOf(env, user.id);
  return json({
    ok: true,
    spot: { id: spot.id, name: spot.name, kind: spot.kind },
    points: total,
    breakdown: breakdown.map(({ label, points }) => ({ label, points })),
    message,
    balance,
    canIssueTicket: balance >= TICKET_COST,
    visitEnded: spot.kind === 'departure',
  });
}

// GET /api/wallet
export async function wallet(env, user) {
  const balance = await balanceOf(env, user.id);
  const visit = await openVisit(env, user.id);
  let visitCheckins = [];
  if (visit) {
    const r = await env.DB.prepare(
      'SELECT c.spot_id, s.name, c.points, c.created_at FROM checkins c JOIN spots s ON s.id = c.spot_id WHERE c.visit_id = ? ORDER BY c.created_at',
    ).bind(visit.id).all();
    visitCheckins = r.results;
  }
  const ledger = await env.DB.prepare(
    'SELECT delta, reason, created_at FROM point_ledger WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 30',
  ).bind(user.id).all();
  const tickets = await env.DB.prepare(
    'SELECT id, code, points_spent, status, issued_at, used_at FROM tickets WHERE user_id = ? ORDER BY issued_at DESC',
  ).bind(user.id).all();
  const spotNames = Object.fromEntries((await env.DB.prepare('SELECT id, name FROM spots').all()).results.map((s) => [s.id, s.name]));
  const reasonLabel = (r) => {
    if (r.startsWith('checkin:')) return spotNames[r.slice(8)] || r;
    if (r === 'stay') return '滞在ポイント';
    if (r === 'ticket') return 'チケット発行';
    return r;
  };
  return json({
    balance,
    ticketCost: TICKET_COST,
    canIssueTicket: balance >= TICKET_COST,
    visit: visit ? { startedAt: visit.started_at, checkins: visitCheckins } : null,
    ledger: ledger.results.map((l) => ({ delta: l.delta, label: reasonLabel(l.reason), at: l.created_at })),
    tickets: tickets.results,
  });
}

// POST /api/tickets  500pt でチケット発行
export async function issueTicket(env, user) {
  const ledgerId = newId();
  const ticketId = newId();
  const code = 'SK-' + randomToken(6).toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 8);
  const now = nowIso();
  // 残高の確認と消費を 1 つのトランザクションで行う（同時押しでも二重発行しない）
  const [ins] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO point_ledger (id, user_id, delta, reason, ref_id, created_at)
       SELECT ?, ?, ?, 'ticket', ?, ? WHERE (SELECT COALESCE(SUM(delta), 0) FROM point_ledger WHERE user_id = ?) >= ?`,
    ).bind(ledgerId, user.id, -TICKET_COST, ticketId, now, user.id, TICKET_COST),
    env.DB.prepare(
      `INSERT INTO tickets (id, user_id, code, points_spent, status, issued_at)
       SELECT ?, ?, ?, ?, 'unused', ? WHERE EXISTS (SELECT 1 FROM point_ledger WHERE id = ?)`,
    ).bind(ticketId, user.id, code, TICKET_COST, now, ledgerId),
  ]);
  if (!ins.meta.changes) return error(400, `ポイントが足りません（${TICKET_COST}ptで1枚発行できます）`);
  return json({ ok: true, ticket: { id: ticketId, code, points_spent: TICKET_COST, status: 'unused', issued_at: now }, balance: await balanceOf(env, user.id) });
}

// POST /api/tickets/:id/use  店舗での使用（デモ）
export async function useTicket(env, user, id) {
  const r = await env.DB.prepare("UPDATE tickets SET status = 'used', used_at = ? WHERE id = ? AND user_id = ? AND status = 'unused'")
    .bind(nowIso(), id, user.id).run();
  if (!r.meta.changes) return error(400, 'このチケットは使えません（使用済みか、見つかりません）');
  return json({ ok: true });
}

// POST /api/demo/reset  デモ利用者のデータを消す
export async function demoReset(env, user) {
  if (user.provider !== 'demo') return error(403, 'デモ利用者だけが使えます');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM tickets WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM point_ledger WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM checkins WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM visits WHERE user_id = ?').bind(user.id),
  ]);
  return json({ ok: true });
}
