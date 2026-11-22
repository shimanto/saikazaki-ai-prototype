// 雑賀崎漁港 AI活用プロトタイプ: Worker の入り口
// /api/* と /auth/* をここで処理し、それ以外は静的アセット（public/）を返す。
import * as auth from './auth.js';
import * as parking from './parking.js';
import * as points from './points.js';
import { error, json, sameOrigin } from './util.js';

async function route(req, env) {
  const url = new URL(req.url);
  const { pathname: p } = url;
  const m = req.method;

  // 駐車場（ログイン不要）
  if (m === 'GET' && p === '/api/parking/scenes') return parking.scenes(req, env);
  if (m === 'GET' && p === '/api/parking/status') return parking.status(req, env);
  if (m === 'GET' && p === '/api/spots') return points.listSpots(req, env);

  // 認証
  if (m === 'GET' && p === '/auth/login') return auth.login(req, env);
  if (m === 'GET' && p === '/auth/callback') return auth.callback(req, env);
  if (m === 'POST' && p === '/auth/demo') return auth.demoLogin(req, env);
  if (m === 'POST' && p === '/auth/logout') return auth.logout(req, env);

  if (m === 'GET' && p === '/api/me') {
    const user = await auth.currentUser(req, env);
    const mode = auth.lineConfigured(env) ? 'line' : 'demo';
    if (!user) return json({ loggedIn: false, mode });
    return json({
      loggedIn: true,
      mode,
      user: { name: user.display_name, provider: user.provider },
      balance: await points.balanceOf(env, user.id),
    });
  }

  // ここから先はログインが必要
  if (p.startsWith('/api/')) {
    const user = await auth.currentUser(req, env);
    if (!user) return error(401, 'ログインしてください');
    if (m !== 'GET' && !sameOrigin(req)) return error(403, '不正なリクエストです');
    if (m === 'GET' && p === '/api/wallet') return points.wallet(env, user);
    if (m === 'POST' && p === '/api/checkin') return points.checkin(req, env, user);
    if (m === 'POST' && p === '/api/tickets') return points.issueTicket(env, user);
    const t = p.match(/^\/api\/tickets\/([0-9a-f-]{36})\/use$/);
    if (m === 'POST' && t) return points.useTicket(env, user, t[1]);
    if (m === 'POST' && p === '/api/demo/reset') return points.demoReset(env, user);
    return error(404, '見つかりません');
  }
  if (p.startsWith('/auth/')) return error(404, '見つかりません');
  return env.ASSETS.fetch(req);
}

export default {
  async fetch(req, env) {
    try {
      return await route(req, env);
    } catch (e) {
      console.error(e);
      return error(500, 'サーバーでエラーが起きました');
    }
  },
};
