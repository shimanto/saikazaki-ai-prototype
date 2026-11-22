// 共通の小さな関数

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function error(status, message, extra = {}) {
  return json({ error: message, ...extra }, status);
}

export const nowIso = () => new Date().toISOString();

export function randomToken(bytes = 32) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const newId = () => crypto.randomUUID();

export function parseCookies(req) {
  const out = {};
  const raw = req.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name, value, { maxAge, path = '/' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; Secure; SameSite=Lax`;
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  return c;
}

// 状態を変えるリクエストは自サイトからのものだけ受け付ける（CSRF 対策）
export function sameOrigin(req) {
  const origin = req.headers.get('origin');
  return !!origin && origin === new URL(req.url).origin;
}

// 日本時間の「今日 0 時」を UTC の ISO 文字列で返す
export function jstDayStartIso(date = new Date()) {
  const jst = new Date(date.getTime() + 9 * 3600e3);
  const midnightJst = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
  return new Date(midnightJst - 9 * 3600e3).toISOString();
}

// 戻り先は /app 配下のパスだけ許可する（オープンリダイレクト対策）
export function safeNext(next) {
  if (typeof next !== 'string') return '/app/';
  if (!/^\/app(\/|$|\?)/.test(next) || next.startsWith('//')) return '/app/';
  return next;
}

export function redirect(location, headers = {}) {
  const h = new Headers({ location, 'cache-control': 'no-store' });
  for (const [k, v] of Object.entries(headers)) {
    if (Array.isArray(v)) v.forEach((x) => h.append(k, x));
    else h.append(k, v);
  }
  return new Response(null, { status: 302, headers: h });
}
