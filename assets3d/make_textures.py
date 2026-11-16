# 生成机箱用的无缝平铺贴图（颜色 / 粗糙度 / 法线），给 Blender 建模用
import numpy as np
from PIL import Image
import os, sys
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tex')
N = 1024
rng = np.random.default_rng(7)
y, x = np.mgrid[0:N, 0:N].astype(np.float32) / N

def save(name, arr, mode='L', q=None):
    arr = np.clip(arr, 0, 1)
    img = Image.fromarray((arr * 255).astype(np.uint8), mode if arr.ndim == 2 else 'RGB')
    p = os.path.join(OUT, name); img.save(p, quality=q or 92) if p.endswith('.jpg') else img.save(p, optimize=True); print(p, os.path.getsize(p))

def normal_from_height(h, strength=4.0):
    gx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * strength
    gy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * strength
    n = np.stack([-gx, gy, np.ones_like(h)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n * .5 + .5

def tile_noise(scale, octaves=4):
    out = np.zeros((N, N), np.float32); amp = 1; tot = 0
    for o in range(octaves):
        s = scale * 2 ** o
        g = rng.random((s, s)).astype(np.float32)
        img = Image.fromarray((g * 255).astype(np.uint8)).resize((N, N), Image.BICUBIC)
        out += np.asarray(img, np.float32) / 255 * amp; tot += amp; amp *= .5
    return out / tot

# 1) 蜂窝网（六边形孔）：高度 + 颜色（孔是深色）——8×8 个蜂窝一张
def hexgrid(cells=10, wall=.13):
    s = cells; px = x * s; py = y * s * 2 / np.sqrt(3)
    # 轴向坐标找最近中心
    q = (px * 2 / 3); r = (-px / 3 + np.sqrt(3) / 3 * py * np.sqrt(3) / 2)
    # 简化：用两套错位网格求到最近中心距离
    cx = np.round(px); cy = np.round(py)
    d1 = np.hypot(px - cx, (py - cy) * .866)
    cx2 = np.floor(px) + .5; cy2 = np.floor(py) + .5
    d2 = np.hypot(px - cx2, (py - cy2) * .866)
    d = np.minimum(d1, d2)
    hole = 1 - np.clip((d - (.5 - wall)) / .04, 0, 1)
    return hole
hx = hexgrid(12)
save('hex_mask.png', hx)                             # 1 = 孔
h = 1 - hx * .9; save('hex_normal.png', normal_from_height(h, 6), 'RGB')
# 2) 圆孔网：规则排布的圆孔
def holes(cells=24, r=.32):
    px = x * cells; py = y * cells; dx = px - np.floor(px) - .5; dy = py - np.floor(py) - .5
    d = np.hypot(dx, dy); return 1 - np.clip((d - r) / .05, 0, 1)
ho = holes(28); save('holes_mask.png', ho); save('holes_normal.png', normal_from_height(1 - ho, 5), 'RGB')
# 3) 拉丝金属：横向细纹（粗糙度变化 + 法线）
streak = np.asarray(Image.fromarray((rng.random((N, 1)) * 255).astype(np.uint8)).resize((N, N), Image.BILINEAR), np.float32) / 255
streak = streak * .7 + tile_noise(64, 2) * .3
save('brushed_rough.jpg', .22 + streak * .16)
save('brushed_normal.png', normal_from_height(streak * .25, 1.5), 'RGB')
# 4) 斜纹格栅（MSI 那种斜条）
st = ((x + y) * 26) % 1; slat = np.clip((np.abs(st - .5) - .18) / .05, 0, 1)
save('slats_mask.png', 1 - slat); save('slats_normal.png', normal_from_height(slat, 5), 'RGB')
# 5) PCB：深绿黑底 + 走线 + 焊点
pcb = np.zeros((N, N, 3), np.float32); pcb[:] = (.03, .07, .05)
for _ in range(260):
    if rng.random() < .5:
        yy = rng.integers(0, N); x0, x1 = sorted(rng.integers(0, N, 2)); pcb[yy:yy + 2, x0:x1] = (.55, .45, .18)
    else:
        xx = rng.integers(0, N); y0, y1 = sorted(rng.integers(0, N, 2)); pcb[y0:y1, xx:xx + 2] = (.55, .45, .18)
for _ in range(90):
    cx, cy, w, hh = rng.integers(0, N - 60), rng.integers(0, N - 60), rng.integers(12, 60), rng.integers(12, 60)
    pcb[cy:cy + hh, cx:cx + w] = (.06, .06, .07)
save('pcb_color.jpg', pcb, 'RGB')
# 6) 屏幕画面：深色仪表盘风（发光贴图）
scr = np.zeros((N, N, 3), np.float32); scr[:] = (.01, .03, .03)
cxs, cys = .62, .5; rr = np.hypot((x - cxs) * 1.6, y - cys)
scr += np.clip(1 - np.abs(rr - .22) / .006, 0, 1)[..., None] * np.array([.2, 1, .6])
scr += np.clip(1 - np.abs(rr - .16) / .004, 0, 1)[..., None] * np.array([.1, .6, .4])
for i in range(9):
    yy = int((.12 + i * .085) * N); scr[yy:yy + 6, int(.06 * N):int((.18 + rng.random() * .2) * N)] = (.6, .75, .8)
for i in range(30):
    t = i / 30; scr[int((.8 - rng.random() * .3) * N):int(.86 * N), int((.5 + t * .45) * N):int((.5 + t * .45) * N) + 10] = (.1, .9, .5)
save('screen_emit.jpg', scr, 'RGB')
# 7) 键盘：按键网格的颜色
kb = np.full((N, N), .06, np.float32); kx = (x * 15) % 1; ky = (y * 6) % 1
kb[(kx > .08) & (kx < .92) & (ky > .1) & (ky < .9)] = .02
save('keys_color.jpg', np.stack([kb, kb, kb * 1.05], -1), 'RGB')
