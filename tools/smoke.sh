#!/usr/bin/env bash
# 動作確認: 全ページ 200、駐車場の判定、デモログイン → QR チェックイン → ポイント → チケット発行
# 使い方: bash tools/smoke.sh https://saikazaki-ai-prototype.shimanto.workers.dev
set -u
BASE="${1:-http://localhost:8788}"
JAR="$(mktemp)"
FAIL=0
ok() { echo "OK   $*"; }
ng() { echo "NG   $*"; FAIL=1; }
jget() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log(eval('o.'+process.argv[1]))})" "$1"; }

echo "== ページ"
for p in / /parking/ /app/ /app/qr/ /css/style.css /js/parking-detect.js /js/parking-page.js /js/app.js /js/qr-print.js \
         /vendor/jsQR.js /vendor/qrcode.js /data/parking/lot.json /data/parking/scenes.json /data/parking/scenes/noon.jpg \
         /data/parking/scenes/reference.rgb /api/parking/scenes /api/parking/status /api/spots /api/me; do
  code=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$BASE$p")
  [ "$code" = 200 ] && ok "$code $p" || ng "$code $p"
done
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/no-such-page")
[ "$code" = 404 ] && ok "404 /no-such-page" || ng "$code /no-such-page"

echo "== 駐車場の判定"
for sc in empty morning noon event; do
  for m in reference features; do
    s=$(curl -s "$BASE/api/parking/status?scene=$sc&method=$m")
    echo "     $sc/$m: $(echo "$s" | jget 'summary.occupied+" of "+o.summary.total+" 占有 "+o.summary.congestion.label+" method="+o.method')"
  done
done
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/parking/status?scene=nope")
[ "$code" = 404 ] && ok "存在しないシーンは 404" || ng "存在しないシーン $code"

echo "== 認証・ポイント"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/wallet")
[ "$code" = 401 ] && ok "未ログインの wallet は 401" || ng "未ログイン wallet $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/auth/demo")
[ "$code" = 403 ] && ok "Origin なしのデモログインは 403" || ng "Origin なし $code"
mode=$(curl -s "$BASE/api/me" | jget 'mode')
echo "     mode=$mode"
if [ "$mode" = demo ]; then
  curl -s -c "$JAR" -b "$JAR" -X POST -H "Origin: $BASE" "$BASE/auth/demo" >/dev/null
  me=$(curl -s -b "$JAR" "$BASE/api/me")
  [ "$(echo "$me" | jget 'loggedIn')" = true ] && ok "デモログイン: $(echo "$me" | jget 'user.name')" || ng "デモログイン失敗 $me"
  spots=$(curl -s "$BASE/api/spots")
  for id in arrival store-fish store-cafe class departure; do
    k=$(echo "$spots" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s).spots.find(x=>x.id==='$id');console.log(new URL(o.qr).searchParams.get('k'))})")
    r=$(curl -s -b "$JAR" -X POST -H "Origin: $BASE" -H 'content-type: application/json' -d "{\"spot\":\"$id\",\"k\":\"$k\"}" "$BASE/api/checkin")
    echo "$r" | grep -q '"ok":true' && ok "チェックイン $id: +$(echo "$r" | jget 'points')pt 残高 $(echo "$r" | jget 'balance')" || ng "チェックイン $id: $r"
  done
  r=$(curl -s -b "$JAR" -X POST -H "Origin: $BASE" -H 'content-type: application/json' -d '{"spot":"store-fish","k":"wrong"}' "$BASE/api/checkin")
  echo "$r" | grep -q 'QRコードが正しくありません' && ok "誤ったキーは拒否" || ng "誤ったキー: $r"
  r=$(curl -s -b "$JAR" -X POST -H "Origin: $BASE" "$BASE/api/tickets")
  echo "$r" | grep -q '"ok":true' && ok "チケット発行: $(echo "$r" | jget 'ticket.code') 残高 $(echo "$r" | jget 'balance')" || ng "チケット発行: $r"
  tid=$(echo "$r" | jget 'ticket.id')
  r=$(curl -s -b "$JAR" -X POST -H "Origin: $BASE" "$BASE/api/tickets")
  echo "$r" | grep -q 'ポイントが足りません' && ok "残高不足の発行は拒否" || ng "残高不足: $r"
  r=$(curl -s -b "$JAR" -X POST -H "Origin: $BASE" "$BASE/api/tickets/$tid/use")
  echo "$r" | grep -q '"ok":true' && ok "チケット使用" || ng "チケット使用: $r"
  w=$(curl -s -b "$JAR" "$BASE/api/wallet")
  echo "     wallet: 残高 $(echo "$w" | jget 'balance') / チケット $(echo "$w" | jget 'tickets.length')枚 / 履歴 $(echo "$w" | jget 'ledger.length')件"
  r=$(curl -s -b "$JAR" -X POST -H "Origin: $BASE" "$BASE/api/demo/reset")
  echo "$r" | grep -q '"ok":true' && ok "デモデータのリセット" || ng "リセット: $r"
  curl -s -b "$JAR" -c "$JAR" -X POST -H "Origin: $BASE" "$BASE/auth/logout" >/dev/null
else
  loc=$(curl -s -o /dev/null -w '%{redirect_url}' "$BASE/auth/login")
  echo "$loc" | grep -q '^https://access.line.me/oauth2/v2.1/authorize' && ok "LINE 認可画面へリダイレクト" || ng "LINE リダイレクト: $loc"
fi
rm -f "$JAR"
[ $FAIL = 0 ] && echo "== すべて OK" || { echo "== NG あり"; exit 1; }
