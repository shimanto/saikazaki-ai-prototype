-- 雑賀崎 AI活用プロトタイプ: 初期スキーマ
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('line', 'demo')),
  provider_user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (provider, provider_user_id)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE spots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('arrival', 'store', 'class', 'departure')),
  points INTEGER NOT NULL,
  qr_key TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE visits (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  stay_minutes INTEGER
);
CREATE INDEX idx_visits_user ON visits(user_id, started_at);

CREATE TABLE checkins (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  visit_id TEXT NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  spot_id TEXT NOT NULL REFERENCES spots(id),
  points INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (visit_id, spot_id)
);
CREATE INDEX idx_checkins_user ON checkins(user_id, created_at);

CREATE TABLE point_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ledger_user ON point_ledger(user_id, created_at);

CREATE TABLE tickets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  points_spent INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('unused', 'used')),
  issued_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX idx_tickets_user ON tickets(user_id, issued_at);

-- 拠点（qr_key は印刷する QR に入る値。秘密ではない）
INSERT INTO spots (id, name, kind, points, qr_key, description, sort) VALUES
 ('arrival',    '到着（駐車場・入口）',   'arrival',   50,  't97mp0h2m87X', '来訪の開始。同じ日の到着ポイントは1回まで', 1),
 ('store-fish', '鮮魚・船上販売',         'store',     100, '7dnUgFhyynV_', '1来訪につき1回', 2),
 ('store-cafe', 'カフェ・飲食',           'store',     100, 'WLPBFjuZ41HR', '1来訪につき1回', 3),
 ('class',      '魚の捌き方教室',         'class',     200, 'eClUOVdyLYYM', '1来訪につき1回', 4),
 ('departure',  '出発',                   'departure', 50,  'cn6KBYLpXeH8', '来訪の終了。滞在10分ごとに10pt（上限300pt）を加算', 5);
