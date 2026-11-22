"""地理院タイルから駐車場のサンプル画像（疑似画像）を作る。

使い方:  python tools/make_scenes.py
出力:    public/data/parking/lot.json            マス・通路の定義（0〜1 の比率）
         public/data/parking/scenes.json         シーン一覧と正解（どのマスに車を置いたか）
         public/data/parking/scenes/<id>.jpg     表示用（760x720）
         public/data/parking/scenes/<id>.rgb     解析用の生 RGB（380x360、1画素3バイト）

元画像: 国土地理院 地理院タイル「全国最新写真（シームレス）」z18
        https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg
"""
import io
import json
import math
import os
import random
import urllib.request

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "data", "parking")
TILE_URL = "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg"
Z, TX0, TY0, NX, NY = 18, 229478, 104553, 3, 2
CROP = (470, 130, 660, 310)  # モザイク上の切り出し範囲（px）
SCALE = 4                    # 表示用の拡大率 → 760x720
ANALYSIS_SIZE = (380, 360)   # 解析用（生 RGB）

# 列ごとの四角形（拡大後の座標）。tl→tr が車の長手方向、tl→bl に沿って n 等分する。
# skip: 先頭から除くマス数（写真に車・構造物が写っている箇所）
ROWS = [
    ("A", (203, 88), (258, 95), (165, 500), (112, 492), 17, 0),
    ("B", (258, 95), (313, 102), (220, 507), (165, 500), 17, 0),
    ("C", (375, 135), (418, 141), (330, 535), (287, 529), 16, 0),
    ("D", (465, 160), (508, 166), (418, 568), (372, 562), 16, 0),
    ("E", (508, 166), (551, 172), (461, 574), (418, 568), 16, 1),
    ("F", (608, 190), (650, 196), (548, 600), (503, 594), 16, 1),
    ("G", (650, 196), (692, 202), (590, 606), (548, 600), 16, 6),
]
# 通路（車が止まらない場所）。露出の補正と舗装色の基準に使う。
CONTROLS = [
    [(328, 125), (362, 132), (283, 505), (247, 500)],
    [(428, 152), (455, 158), (365, 545), (340, 540)],
    [(562, 184), (596, 191), (495, 578), (470, 574)],
]
SCENES = [
    # id, ラベル, 占有率, 明るさ, 色味(r,g,b), 乱数の種
    ("empty", "早朝・ほぼ空車（基準画像に近い）", 0.0, 0.97, (1.0, 1.0, 1.02), 11),
    ("morning", "朝（疑似画像）", 0.3, 0.92, (0.98, 1.0, 1.05), 12),
    ("noon", "昼（疑似画像）", 0.8, 1.05, (1.02, 1.0, 0.98), 13),
    ("event", "イベント日・満車に近い（疑似画像）", 0.97, 1.0, (1.0, 1.0, 1.0), 14),
]
CAR_COLORS = [(235, 235, 232), (240, 240, 238), (190, 192, 196), (160, 162, 168), (40, 40, 44),
              (25, 30, 40), (70, 90, 140), (150, 40, 40), (200, 185, 150), (90, 100, 95)]


def fetch_mosaic():
    im = Image.new("RGB", (256 * NX, 256 * NY))
    for i in range(NX):
        for j in range(NY):
            url = TILE_URL.format(z=Z, x=TX0 + i, y=TY0 + j)
            req = urllib.request.Request(url, headers={"User-Agent": "saikazaki-ai-prototype/0.1"})
            data = urllib.request.urlopen(req, timeout=30).read()
            im.paste(Image.open(io.BytesIO(data)).convert("RGB"), (256 * i, 256 * j))
    return im


def lerp(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


def build_stalls():
    stalls = []
    for name, tl, tr, br, bl, n, skip in ROWS:
        for i in range(skip, n):
            p = [lerp(tl, bl, i / n), lerp(tr, br, i / n), lerp(tr, br, (i + 1) / n), lerp(tl, bl, (i + 1) / n)]
            stalls.append({"id": f"{name}-{i + 1 - skip:02d}", "row": name, "poly": p})
    return stalls


def tile_latlon(px, py):
    n = 2 ** Z
    x = TX0 + px / 256
    y = TY0 + py / 256
    lon = x / n * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return round(lat, 6), round(lon, 6)


def draw_car(base, stall, rng):
    p = stall["poly"]
    cx = sum(q[0] for q in p) / 4 + rng.uniform(-2, 2)
    cy = sum(q[1] for q in p) / 4 + rng.uniform(-1.5, 1.5)
    ux, uy = p[1][0] - p[0][0], p[1][1] - p[0][1]
    stall_len = math.hypot(ux, uy)
    stall_w = math.hypot(p[3][0] - p[0][0], p[3][1] - p[0][1])
    length = stall_len * rng.uniform(0.74, 0.84)
    width = stall_w * rng.uniform(0.68, 0.78)
    angle = math.degrees(math.atan2(uy, ux)) + rng.uniform(-3, 3)
    if rng.random() < 0.5:
        angle += 180
    color = rng.choice(CAR_COLORS)
    ss = 4  # 描画の拡大率（なめらかにするため）
    w, h = int(length * ss), int(width * ss)
    pad = 6 * ss
    car = Image.new("RGBA", (w + 2 * pad, h + 2 * pad), (0, 0, 0, 0))
    d = ImageDraw.Draw(car)
    body = (pad, pad, pad + w, pad + h)
    d.rounded_rectangle(body, radius=int(h * 0.3), fill=color + (255,))
    dark = tuple(max(0, int(c * 0.35)) for c in color) + (255,)
    if sum(color) < 200:
        dark = (110, 120, 130, 255)
    # フロントガラス・リアガラス
    d.rounded_rectangle((pad + w * 0.24, pad + h * 0.12, pad + w * 0.36, pad + h * 0.88), radius=int(h * 0.1), fill=dark)
    d.rounded_rectangle((pad + w * 0.74, pad + h * 0.16, pad + w * 0.82, pad + h * 0.84), radius=int(h * 0.08), fill=dark)
    roof = tuple(min(255, int(c * 1.06 + 6)) for c in color) + (255,)
    d.rectangle((pad + w * 0.37, pad + h * 0.16, pad + w * 0.73, pad + h * 0.84), fill=roof)
    car = car.resize((car.width // ss, car.height // ss), Image.LANCZOS).rotate(-angle, expand=True, resample=Image.BICUBIC)
    # 影
    shadow = Image.new("RGBA", car.size, (0, 0, 0, 0))
    alpha = car.split()[3].point(lambda a: int(a * 0.45))
    shadow.putalpha(alpha)
    shadow = shadow.filter(ImageFilter.GaussianBlur(1.5))
    ox, oy = int(cx - car.width / 2), int(cy - car.height / 2)
    base.alpha_composite(shadow, (ox + 3, oy + 3))
    base.alpha_composite(car, (ox, oy))


def apply_light(im, gain, tint, rng):
    r, g, b = im.split()
    chans = [c.point(lambda v, k=gain * t: max(0, min(255, int(v * k)))) for c, t in zip((r, g, b), tint)]
    out = Image.merge("RGB", chans)
    noise = Image.effect_noise(out.size, 6).convert("L")
    return Image.blend(out, Image.merge("RGB", (noise, noise, noise)), 0.03)


def main():
    os.makedirs(os.path.join(OUT, "scenes"), exist_ok=True)
    mosaic = fetch_mosaic()
    crop = mosaic.crop(CROP)
    W, H = crop.width * SCALE, crop.height * SCALE
    base = crop.resize((W, H), Image.BICUBIC)
    stalls = build_stalls()

    def norm(poly):
        return [[round(x / W, 5), round(y / H, 5)] for x, y in poly]

    nw = tile_latlon(CROP[0], CROP[1])
    se = tile_latlon(CROP[2], CROP[3])
    center = tile_latlon((CROP[0] + CROP[2]) / 2, (CROP[1] + CROP[3]) / 2)
    lot = {
        "id": "saikazaki-west",
        "name": "漁港西側駐車場（デモ用に区画を定義）",
        "note": "区画は航空写真の白線に合わせてデモ用に定義したもの。公表されている駐車場台数とは一致させていない。",
        "center": {"lat": center[0], "lon": center[1]},
        "bounds": {"nw": {"lat": nw[0], "lon": nw[1]}, "se": {"lat": se[0], "lon": se[1]}},
        "image": {"width": W, "height": H, "analysisWidth": ANALYSIS_SIZE[0], "analysisHeight": ANALYSIS_SIZE[1]},
        "reference": "/data/parking/scenes/reference.rgb",
        "stalls": [{"id": s["id"], "row": s["row"], "poly": norm(s["poly"])} for s in stalls],
        "controls": [norm(c) for c in CONTROLS],
        "attribution": "出典: 国土地理院 地理院タイル（全国最新写真（シームレス））を加工して作成",
    }
    with open(os.path.join(OUT, "lot.json"), "w", encoding="utf-8") as f:
        json.dump(lot, f, ensure_ascii=False, indent=1)

    # 基準画像（空車）
    base.save(os.path.join(OUT, "scenes", "reference.jpg"), quality=88)
    with open(os.path.join(OUT, "scenes", "reference.rgb"), "wb") as f:
        f.write(base.resize(ANALYSIS_SIZE, Image.BOX).tobytes())

    scenes = []
    for sid, label, rate, gain, tint, seed in SCENES:
        rng = random.Random(seed)
        im = base.convert("RGBA")
        occupied = sorted(s["id"] for s in rng.sample(stalls, round(len(stalls) * rate)))
        for s in stalls:
            if s["id"] in occupied:
                draw_car(im, s, rng)
        im = apply_light(im.convert("RGB"), gain, tint, rng)
        im.save(os.path.join(OUT, "scenes", f"{sid}.jpg"), quality=88)
        with open(os.path.join(OUT, "scenes", f"{sid}.rgb"), "wb") as f:
            f.write(im.resize(ANALYSIS_SIZE, Image.BOX).tobytes())
        scenes.append({"id": sid, "label": label, "image": f"/data/parking/scenes/{sid}.jpg",
                       "raw": f"/data/parking/scenes/{sid}.rgb", "truthOccupied": occupied})
        print(sid, len(occupied), "/", len(stalls))
    with open(os.path.join(OUT, "scenes.json"), "w", encoding="utf-8") as f:
        json.dump({"default": "noon", "scenes": scenes}, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
