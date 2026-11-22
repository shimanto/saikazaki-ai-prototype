// ログイン（LINE Login v2.1 / デモモード）とセッション
import { cookie, error, json, newId, nowIso, parseCookies, randomToken, redirect, safeNext, sameOrigin } from './util.js';

const SESSION_DAYS = 30;
const LINE_AUTHORIZE = 'https://access.line.me/oauth2/v2.1/authorize';
const LINE_TOKEN = 'https://api.line.me/oauth2/v2.1/token';
const LINE_VERIFY = 'https://api.line.me/oauth2/v2.1/verify';

export function lineConfigured(env) {
  return !!(env.LINE_CHANNEL_ID && env.LINE_CHANNEL_SECRET && env.LINE_CALLBACK_URL);
}

export async function currentUser(req, env) {
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  return env.DB.prepare(
    `SELECT u.id, u.provider, u.display_name FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > ?`,
  ).bind(sid, nowIso()).first();
}

async function upsertUser(env, provider, providerUserId, displayName) {
  const existing = await env.DB.prepare('SELECT id FROM users WHERE provider = ? AND provider_user_id = ?')
    .bind(provider, providerUserId).first();
  if (existing) {
    await env.DB.prepare('UPDATE users SET display_name = ? WHERE id = ?').bind(displayName, existing.id).run();
    return existing.id;
  }
  const id = newId();
  await env.DB.prepare('INSERT INTO users (id, provider, provider_user_id, display_name, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, provider, providerUserId, displayName, nowIso()).run();
  return id;
}

async function startSession(env, userId) {
  const sid = randomToken(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400e3).toISOString();
  await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(sid, userId, expires, nowIso()).run();
  return cookie('sid', sid, { maxAge: SESSION_DAYS * 86400 });
}

// GET /auth/login
export async function login(req, env) {
  const url = new URL(req.url);
  const next = safeNext(url.searchParams.get('next'));
  if (!lineConfigured(env)) {
    // デモモード: アプリ画面のデモログインボタンへ
    return redirect(`/app/?login=demo&next=${encodeURIComponent(next)}`);
  }
  const state = randomToken(24);
  const nonce = randomToken(24);
  const expires = new Date(Date.now() + 10 * 60e3).toISOString();
  await env.DB.prepare('DELETE FROM oauth_states WHERE expires_at < ?').bind(nowIso()).run();
  await env.DB.prepare('INSERT INTO oauth_states (state, nonce, expires_at) VALUES (?, ?, ?)').bind(state, nonce, expires).run();
  const auth = new URL(LINE_AUTHORIZE);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('client_id', env.LINE_CHANNEL_ID);
  auth.searchParams.set('redirect_uri', env.LINE_CALLBACK_URL);
  auth.searchParams.set('state', state);
  auth.searchParams.set('scope', 'openid profile');
  auth.searchParams.set('nonce', nonce);
  return redirect(auth.toString(), {
    'set-cookie': [cookie('ls', state, { maxAge: 600, path: '/auth' }), cookie('ln', next, { maxAge: 600, path: '/auth' })],
  });
}

// GET /auth/callback
export async function callback(req, env) {
  if (!lineConfigured(env)) return redirect('/app/');
  const url = new URL(req.url);
  const c = parseCookies(req);
  const fail = (msg) => redirect(`/app/?error=${encodeURIComponent(msg)}`);
  if (url.searchParams.get('error')) return fail('LINEログインがキャンセルされました');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state || state !== c.ls) return fail('ログインの確認に失敗しました（state不一致）');
  const row = await env.DB.prepare('SELECT nonce, expires_at FROM oauth_states WHERE state = ?').bind(state).first();
  await env.DB.prepare('DELETE FROM oauth_states WHERE state = ?').bind(state).run();
  if (!row || row.expires_at < nowIso()) return fail('ログインの有効期限が切れました。もう一度お試しください');

  const tokenRes = await fetch(LINE_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: env.LINE_CALLBACK_URL,
      client_id: env.LINE_CHANNEL_ID,
      client_secret: env.LINE_CHANNEL_SECRET,
    }),
  });
  if (!tokenRes.ok) return fail('LINEのトークン取得に失敗しました');
  const token = await tokenRes.json();
  const verifyRes = await fetch(LINE_VERIFY, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: token.id_token, client_id: env.LINE_CHANNEL_ID, nonce: row.nonce }),
  });
  if (!verifyRes.ok) return fail('LINEのIDトークン検証に失敗しました');
  const idt = await verifyRes.json();
  if (!idt.sub) return fail('LINEの利用者IDを取得できませんでした');

  const userId = await upsertUser(env, 'line', idt.sub, (idt.name || 'LINE利用者').slice(0, 50));
  const sc = await startSession(env, userId);
  return redirect(safeNext(c.ln), {
    'set-cookie': [sc, cookie('ls', '', { maxAge: 0, path: '/auth' }), cookie('ln', '', { maxAge: 0, path: '/auth' })],
  });
}

// POST /auth/demo  デモモードのログイン（LINE 未設定のときだけ）
export async function demoLogin(req, env) {
  if (lineConfigured(env)) return error(403, 'LINEログインが有効なため、デモログインは使えません');
  if (!sameOrigin(req)) return error(403, '不正なリクエストです');
  const suffix = String(Math.floor(1000 + Math.random() * 9000));
  const userId = await upsertUser(env, 'demo', `demo-${newId()}`, `デモ利用者${suffix}`);
  const sc = await startSession(env, userId);
  return json({ ok: true }, 200, { 'set-cookie': sc });
}

// POST /auth/logout
export async function logout(req, env) {
  if (!sameOrigin(req)) return error(403, '不正なリクエストです');
  const sid = parseCookies(req).sid;
  if (sid) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sid).run();
  return json({ ok: true }, 200, { 'set-cookie': cookie('sid', '', { maxAge: 0 }) });
}
