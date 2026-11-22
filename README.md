# saikazaki-ai-prototype

和歌山市・雑賀崎漁港への AI 活用提案を、公開 Web サービスの雛型として形にしたプロトタイプ。

公開URL: https://saikazaki-ai-prototype.shimanto.workers.dev/

| パス | 内容 |
|---|---|
| `/` | 提案資料（背景・課題・3本柱・助成金・出典） |
| `/parking/` | 駐車場の画像認識デモ（地理院タイル + 疑似画像、`/api/parking/status` で JSON） |
| `/app/` | QR 滞在ポイントアプリ（LINE ログイン / デモモード、チェックイン、500pt でチケット発行） |
| `/app/qr/` | 拠点 QR コードの発行（印刷用） |

設計: [`docs/design.md`](docs/design.md)

## 構成

Cloudflare Workers 1 つで、静的アセット（`public/`）・Worker API（`src/`）・D1 を動かす。

```
public/                静的アセット（HTML / CSS / JS / サンプル画像）
  js/parking-detect.js 駐車マスの判定ロジック（ブラウザと Worker で共通）
src/                   Worker（/api/*, /auth/*）
migrations/            D1 スキーマ
tools/make_scenes.py   地理院タイルからサンプル画像（疑似画像）を作る
tools/eval_detect.mjs  サンプル画像で判定の正しさを確かめる
tools/smoke.sh         公開URL・ローカルの動作確認
```

## コマンド

```bash
npm install
npm run db:migrate:local      # ローカル D1 を作る
npx wrangler dev              # ローカル起動
npm run eval                  # 判定ロジックの確認
bash tools/smoke.sh http://127.0.0.1:8787

npm run db:migrate            # 本番 D1 にスキーマを適用
npm run deploy                # 本番へデプロイ
bash tools/smoke.sh https://saikazaki-ai-prototype.shimanto.workers.dev
```

## LINE ログイン

`LINE_CHANNEL_ID`・`LINE_CHANNEL_SECRET`・`LINE_CALLBACK_URL` を secret で設定すると LINE ログインになる。
未設定のあいだはデモモード（モックユーザー）で動く。値はリポジトリに入れない。

```bash
npx wrangler secret put LINE_CHANNEL_ID
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CALLBACK_URL   # https://saikazaki-ai-prototype.shimanto.workers.dev/auth/callback
```

ローカルで試すときは `.dev.vars`（git 管理外）に書く。

## 出典・ライセンス

- 航空写真: 国土地理院 地理院タイル（全国最新写真（シームレス））。駐車場のサンプル画像は、これを切り出して車両を合成した疑似画像。
- `public/vendor/jsQR.js`: [jsQR](https://github.com/cozmo/jsQR)（Apache-2.0、`public/vendor/jsQR.LICENSE.txt`）
- `public/vendor/qrcode.js`: [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)（MIT、ファイル冒頭に表記）
