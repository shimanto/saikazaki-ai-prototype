# 設計書: 雑賀崎漁港 AI活用提案 公開Webサービス雛型

最終更新: 2026-11-22

この文書は、和歌山市・雑賀崎漁港への AI 活用提案を公開 Web サービスの雛型として形にするための設計である。
提案資料の公開、駐車場の画像認識デモ、QR ポイントアプリ（LINE ログイン付き）の 3 つを、Cloudflare Workers 1 つで動かす。

> 本サービスは **プロトタイプ（雛型）** である。駐車場の判定は疑似画像に対するデモであり、ポイント・チケットも実際の店舗では使えない。画面上にもその旨を明示する。

---

## 1. 全体構成

```
ブラウザ（スマホ）
   │
   ▼
Cloudflare Workers（saikazaki-ai-prototype）
   ├─ 静的アセット配信（public/）……… /, /parking/, /app/, /app/qr/ の HTML・JS・CSS・画像
   ├─ Worker API（src/）……………… /api/* と /auth/*（run_worker_first で Worker が先に処理）
   └─ D1（saikazaki-ai-prototype）…… 利用者・セッション・来訪・チェックイン・ポイント・チケット
```

| 項目 | 内容 |
|---|---|
| 実行環境 | Cloudflare Workers（静的アセット + Worker + D1） |
| 公開URL | `https://saikazaki-ai-prototype.shimanto.workers.dev/`（認証なし） |
| フロント | 素の HTML / CSS / ES Modules（ビルド不要）。スマホ幅を前提にしたレイアウト |
| 外部ライブラリ | QR 読み取り `jsQR`（Apache-2.0）、QR 生成 `qrcode-generator`（MIT）を `public/vendor/` に同梱。CDN には依存しない |
| 地図・写真 | 国土地理院 地理院タイル「全国最新写真（シームレス）」。出典を各画面に表記する |

## 2. 画面構成

| パス | 画面 | 概要 |
|---|---|---|
| `/` | 提案資料 | 背景・課題・提案の 3 本柱・助成金の概要・出典。公表資料ベースの数値のみ |
| `/parking/` | 駐車場の画像認識デモ | 地理院タイルで漁港周辺を表示 → サンプル画像を選ぶ → マスごとの判定結果（空き台数・混雑度・マス状態）を重ねて表示。画像のアップロード（差し替え）にも対応 |
| `/app/` | QR ポイントアプリ | ログイン → 拠点 QR の読み取り（カメラ / デモ用ボタン）→ ポイント付与 → 500pt でチケット発行。残高・履歴・チケット一覧 |
| `/app/qr/` | 拠点 QR の発行（印刷用） | 到着・鮮魚／船上販売・カフェ・捌き方教室・出発の各拠点の QR を A4 に印刷 |
| `/auth/login` | ログイン | LINE 設定済みなら LINE 認可画面へ、未設定ならデモモードのログイン |

共通: 画面上部に「プロトタイプ（デモ）」の帯を出す。デモモード時はアプリ画面に「デモモード（LINE未接続）」を出す。

## 3. API

すべて JSON。認証が必要なものはセッション Cookie（`sid`、HttpOnly・Secure・SameSite=Lax）で利用者を特定する。

### 駐車場

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/parking/scenes` | 選べるサンプル画像の一覧 |
| GET | `/api/parking/status?scene=<id>&method=<reference\|features>` | 指定画像の判定結果。`scene` 省略時は既定の画像（`noon`） |

`/api/parking/status` の応答例:

```json
{
  "demo": true,
  "lot": { "id": "saikazaki-west", "name": "漁港西側駐車場（デモ用に区画を定義）", "lat": 34.186974, "lon": 135.143107 },
  "scene": { "id": "noon", "label": "昼（疑似画像）", "capturedAt": null, "source": "国土地理院 空中写真を加工した疑似画像" },
  "method": "reference",
  "summary": { "total": 106, "occupied": 85, "vacant": 21, "occupancyRate": 0.802, "congestion": { "level": 3, "label": "混雑" } },
  "stalls": [ { "id": "A-01", "state": "occupied", "score": 41.2, "confidence": 0.93 } ],
  "attribution": "出典: 国土地理院 地理院タイル（全国最新写真（シームレス））を加工して作成",
  "generatedAt": "2026-11-22T00:00:00.000Z"
}
```

### 認証

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/auth/login` | LINE 設定済み → LINE 認可 URL へリダイレクト。未設定 → デモユーザーでログインして `/app/` へ |
| GET | `/auth/callback` | LINE からのコールバック。state 検証 → トークン取得 → ID トークン検証 → ログイン |
| POST | `/auth/logout` | セッション削除 |
| GET | `/api/me` | ログイン状態・表示名・モード（`line` / `demo`）・ポイント残高 |

### ポイント

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/spots` | 拠点一覧（QR 印刷ページ用。QR に埋め込む文字列を含む） |
| POST | `/api/checkin` | `{ "spot": "arrival", "k": "<拠点キー>" }` でチェックイン。付与ポイントを返す |
| GET | `/api/wallet` | 残高・来訪状況・ポイント履歴・チケット一覧 |
| POST | `/api/tickets` | 500pt を消費してチケットを発行 |
| POST | `/api/tickets/:id/use` | チケットを使用済みにする（店舗側操作のデモ） |
| POST | `/api/demo/reset` | デモユーザーのデータを消す（デモモードのみ） |

## 4. データモデル（D1）

```sql
users(id TEXT PK, provider TEXT /* line|demo */, provider_user_id TEXT, display_name TEXT, created_at TEXT)
sessions(id TEXT PK /* ランダム256bit */, user_id TEXT, expires_at TEXT, created_at TEXT)
oauth_states(state TEXT PK, nonce TEXT, expires_at TEXT)
spots(id TEXT PK, name TEXT, kind TEXT, points INTEGER, qr_key TEXT, sort INTEGER)
visits(id TEXT PK, user_id TEXT, started_at TEXT, ended_at TEXT NULL, stay_minutes INTEGER NULL)
checkins(id TEXT PK, user_id TEXT, visit_id TEXT, spot_id TEXT, points INTEGER, created_at TEXT, UNIQUE(visit_id, spot_id))
point_ledger(id TEXT PK, user_id TEXT, delta INTEGER, reason TEXT, ref_id TEXT, created_at TEXT)
tickets(id TEXT PK, user_id TEXT, code TEXT, points_spent INTEGER, status TEXT /* unused|used */, issued_at TEXT, used_at TEXT NULL)
```

- 残高は `point_ledger` の合計（台帳方式）。付与・消費をすべて行で残すので、後から集計・監査できる。
- 個人情報は持たない。保存するのは LINE の内部ID（`sub`）と表示名のみで、アプリ内の表示と重複防止にだけ使う。メールアドレス・プロフィール画像は取得しない（スコープは `openid profile`）。

## 5. ポイントのルール（雛型の初期値）

| 拠点 | 種類 | 付与 | 条件 |
|---|---|---|---|
| 到着（駐車場・入口） | arrival | 50pt | 来訪を開始。同じ日の到着ポイントは 1 回まで |
| 鮮魚・船上販売 | store | 100pt | 1 来訪につき 1 回 |
| カフェ・飲食 | store | 100pt | 1 来訪につき 1 回 |
| 魚の捌き方教室 | class | 200pt | 1 来訪につき 1 回 |
| 出発 | departure | 50pt + 滞在ポイント | 来訪を終了。滞在 10 分ごとに 10pt（上限 300pt） |

- 到着をせずに店舗等でチェックインした場合は、その時点で来訪を開始する。
- 残高 500pt で「デジタルチケット」を 1 枚発行できる（500pt 消費）。チケットは「次回のお買い物で使える」もので、割引内容は実証時に店舗と決める（画面上は「内容は実証時に決定」と表示）。
- 滞在時間に応じたポイントで「長く滞在してもらう」ことを促し、出発チェックインで駐車場の回転（出庫）も把握できるようにする。

## 6. 駐車場の画像認識（雛型）

### 6.1 入力
- 国土地理院の空中写真（地理院タイル z18、全国最新写真（シームレス））から、漁港西側の駐車場周辺（約 190×180px、北西 34.187373,135.142597 〜 南東 34.186574,135.143616）を切り出し、4 倍に拡大した画像を「空車の基準画像」とした。
- これに車両を合成した疑似画像（朝・昼・イベント時）を `tools/make_scenes.py` で生成した。生成時の正解（どのマスに車を置いたか）も JSON で保存し、判定の正しさを確認する。
- 駐車マスは、航空写真上の白線に合わせて「列」ごとの四角形（4 頂点）を定義し、列を等分して 1 マスずつのポリゴンにした（`public/data/parking/lot.json`）。座標は画像サイズに対する 0〜1 の比率で持つので、解像度の違う画像にもそのまま使える。
- 区画数（106）はデモ用に定義したもので、公表されている駐車場の台数（110台）とは一致させていない。写真に車・構造物が写っているマス（列 E・F の先頭、列 G の先頭6マス）は除いた。

### 6.2 判定手法
各マスのポリゴンを重心方向に 20% 縮めて白線を避け、その内側の画素から特徴量を求める。

1. **基準画像との差分（`reference`、既定）**
   - 通路（車が止まらない場所）の明るさで、入力画像の露出を基準画像に合わせる（明るさの補正係数 = 基準の通路平均 ÷ 入力の通路平均）。
   - マス内の画素ごとの RGB 差の平均（0〜255）を `score` とし、閾値（既定 18）を超えたら「占有」。
2. **特徴量だけで判定（`features`、基準画像なし）**
   - 輝度の標準偏差（テクスチャ）、通路の舗装色からの色の離れ、彩度を足し合わせて `score` とし、閾値（既定 22）を超えたら「占有」。
   - 基準画像を用意できないカメラ向け。影・汚れに弱い。

`confidence` は score と閾値の距離から 0.5〜0.99 で出す目安値。
混雑度は占有率で 4 段階: 〜50% 空いています / 〜80% やや混雑 / 〜95% 混雑 / それ以上 満車に近い。

判定ロジックは `public/js/parking-detect.js` の 1 ファイルにまとめ、**ブラウザ（アップロード画像）と Worker（`/api/parking/status`）の両方で同じコードを使う**。Worker では画像デコードの CPU を使わないよう、サンプル画像を解析用の生 RGB（380×360、`*.rgb`）でも持つ。

### 6.3 疑似画像での確認結果（`node tools/eval_detect.mjs`）

| 画像 | 正解の占有数 | 基準画像との差分 | 特徴量のみ |
|---|---|---|---|
| 早朝・ほぼ空車 | 0 / 106 | 106/106 一致 | 106/106 一致 |
| 朝 | 32 / 106 | 106/106 一致 | 106/106 一致 |
| 昼 | 85 / 106 | 106/106 一致 | 106/106 一致 |
| イベント日 | 103 / 106 | 106/106 一致 | 106/106 一致 |

score の分布（差分方式）は、空きマス 0.3〜4.6、占有マス 25.3〜127.2（閾値 18）。最も差が小さいのは舗装に近い灰色の車。
疑似画像は車がくっきりしているので、この一致率は実際のカメラ画像での精度を表さない。

### 6.4 限界
- 疑似画像での確認であり、実際の車両・天候・影・夜間での精度は未検証。
- 航空写真は真上から撮った 1 枚で、時刻による変化がない。定点カメラは斜め上からの画角になり、手前の車が奥のマスを隠す。

## 7. 将来の実カメラへの差し替え方

1. **カメラの設置と画角決め**: 駐車場を見下ろせる位置（照明柱・建物の屋上など）に定点カメラを置く。
2. **マスの定義をやり直す**: カメラ画像の 1 枚目で、マスごとの 4 頂点を指定して `lot.json` と同じ形式（0〜1 の比率）で保存する。斜めの画角でもポリゴンなのでそのまま使える。通路（`controls`）も指定する。
3. **基準画像を撮る**: 早朝など空車のときの画像を時間帯別（朝・昼・夕）に用意する。
4. **画像の取り込み**: 次のどちらかにする。
   - (a) 現地の小型 PC・ラズパイで撮影 → 同じ `parking-detect.js`（Node）で判定 → 結果 JSON だけを Worker に POST（`/api/parking/ingest` を追加、デバイス用トークンで認証）。画像を外に出さないので、映り込んだ人・ナンバーの扱いの面でも安全。**推奨**。
   - (b) 画像を R2 にアップロード → Worker で判定。JPEG のデコードに CPU を使うため、Workers の有料プランか、縮小済み画像の送信が前提。
5. **結果の保存**: D1 に `parking_snapshots(lot_id, captured_at, occupied, vacant, stalls_json)` を追加し、`/api/parking/status` を「最新のスナップショットを返す」に切り替える。時系列は混雑予測・LINE 通知に使う。
6. **認識手法の強化**: 疑似画像の閾値判定から、実画像を集めて車両検出モデル（物体検出）やマス単位の分類モデルに置き換える。`detect()` の入出力（画素 → マスごとの状態）を変えなければ、画面・API は作り直さなくてよい。

## 8. LINE ログイン

- 環境変数 / secret: `LINE_CHANNEL_ID`、`LINE_CHANNEL_SECRET`、`LINE_CALLBACK_URL`。**値はリポジトリに入れない**（`wrangler secret put` で設定）。
- 3 つすべてが設定されているときだけ LINE モード。どれかが欠けていればデモモード（モックユーザー「デモ利用者」でログイン）。
- フロー: `/auth/login` で `state`・`nonce` を作って D1 に保存（10 分有効）→ `https://access.line.me/oauth2/v2.1/authorize` へ → `/auth/callback` で `state` を照合 → `https://api.line.me/oauth2/v2.1/token` で ID トークン取得 → `https://api.line.me/oauth2/v2.1/verify` で ID トークンを検証（`client_id` と `nonce` も照合）→ `sub` と `name` で利用者を作成・更新 → セッション発行。
- セッションは D1 の `sessions` に置く（30 日有効）。Cookie にはランダムな ID だけを入れる。

## 9. セキュリティ・プライバシー

- 状態を変える API は POST のみ、かつ `Origin` ヘッダーが自サイトのときだけ受け付ける（CSRF 対策）。
- 拠点 QR には拠点 ID と拠点キーを入れる。キーは推測しにくいランダム値だが、印刷物なので秘密ではない。実運用では日替わりキーや、店舗端末に表示する動的 QR を検討する。
- 駐車場の画像処理は、マスの占有・空きだけを出し、ナンバー・人物は扱わない。

## 10. ディレクトリ構成

```
public/                 静的アセット（そのまま配信）
  index.html            提案資料
  parking/index.html    駐車場デモ
  app/index.html        ポイントアプリ
  app/qr/index.html     QR 発行（印刷用）
  js/parking-detect.js  判定ロジック（ブラウザ・Worker 共通）
  data/parking/         マス定義・サンプル画像（表示用 JPEG・解析用 RGB・正解 JSON）
  vendor/               jsQR, qrcode-generator
src/                    Worker（API・認証）
migrations/             D1 のスキーマ
tools/make_scenes.py    地理院タイルからサンプル画像を作るスクリプト
```
