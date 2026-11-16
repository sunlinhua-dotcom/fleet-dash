# DASH 机库资产：在 Blender 5.2 里按真实尺寸建每台机器，PBR 材质 + 平铺贴图，导出一个 GLB（共用贴图只存一份）。
# 用法：blender -b --python build_assets.py -- <贴图目录> <输出目录> [render]
# 约定：Blender 里 -Y 是正面（导出后朝网页镜头），+X 侧是玻璃侧板；每台一个空物体做根，名字 = 资产 id。
# 材质名 STATUS 的面在网页里按机器状态上色（正常冷白 / 忙绿 / 偏热琥珀 / 过热红 / 离线灰）。
import bpy, bmesh, math, os, sys
from mathutils import Vector, Matrix

argv = sys.argv[sys.argv.index('--') + 1:]
TEX, OUT = argv[0], argv[1]
RENDER = len(argv) > 2 and argv[2] == 'render'
os.makedirs(OUT, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
SCN = bpy.context.scene

# ---------------------------------------------------------------- 材质
IMG = {}
def img(name, noncolor=False):
    if name not in IMG:
        im = bpy.data.images.load(os.path.join(TEX, name))
        if noncolor: im.colorspace_settings.name = 'Non-Color'
        IMG[name] = im
    return IMG[name]

MATS, TILE = {}, {}
def mat(name, color=(.1, .1, .1), metal=0., rough=.5, emit=None, estr=0., coat=0., alpha=1., ctex=None, rtex=None, ntex=None, etex=None, nstr=1., tile=.05, atex=None):
    if name in MATS: return MATS[name]
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; b = nt.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Metallic'].default_value = metal
    b.inputs['Roughness'].default_value = rough
    if coat: b.inputs['Coat Weight'].default_value = coat; b.inputs['Coat Roughness'].default_value = .08
    if alpha < 1:
        b.inputs['Alpha'].default_value = alpha
        for attr, val in (('surface_render_method', 'BLENDED'), ('blend_method', 'BLEND')):
            try: setattr(m, attr, val)
            except Exception: pass
    if emit is not None:
        b.inputs['Emission Color'].default_value = (*emit, 1); b.inputs['Emission Strength'].default_value = estr
    if ctex:   # 颜色贴图 × 颜色（glTF 导出认 Multiply 混合）
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = img(ctex)
        mix = nt.nodes.new('ShaderNodeMix'); mix.data_type = 'RGBA'; mix.blend_type = 'MULTIPLY'; mix.inputs['Factor'].default_value = 1
        nt.links.new(t.outputs['Color'], mix.inputs['A']); mix.inputs['B'].default_value = (*color, 1)
        nt.links.new(mix.outputs['Result'], b.inputs['Base Color'])
    if rtex:
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = img(rtex, True); nt.links.new(t.outputs['Color'], b.inputs['Roughness'])
    if atex:   # 透孔：贴图 alpha 经 Round 节点 = glTF alphaMode MASK
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = img(atex)
        mix = nt.nodes.new('ShaderNodeMix'); mix.data_type = 'RGBA'; mix.blend_type = 'MULTIPLY'; mix.inputs['Factor'].default_value = 1
        nt.links.new(t.outputs['Color'], mix.inputs['A']); mix.inputs['B'].default_value = (*color, 1); nt.links.new(mix.outputs['Result'], b.inputs['Base Color'])
        rd = nt.nodes.new('ShaderNodeMath'); rd.operation = 'ROUND'; nt.links.new(t.outputs['Alpha'], rd.inputs[0]); nt.links.new(rd.outputs[0], b.inputs['Alpha'])
        for attr, val in (('surface_render_method', 'DITHERED'), ('blend_method', 'CLIP')):
            try: setattr(m, attr, val)
            except Exception: pass
    if ntex:
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = img(ntex, True)
        nm = nt.nodes.new('ShaderNodeNormalMap'); nm.inputs['Strength'].default_value = nstr
        nt.links.new(t.outputs['Color'], nm.inputs['Color']); nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
    if etex:
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = img(etex)
        nt.links.new(t.outputs['Color'], b.inputs['Emission Color']); b.inputs['Emission Strength'].default_value = estr or 1.5
    MATS[name] = m; TILE[name] = tile
    return m

# 公用材质
M = dict(
    status=mat('STATUS', (1, 1, 1), 0, .3, emit=(1, 1, 1), estr=6),
    black_metal=mat('black_metal', (.035, .037, .042), .85, .32, rtex='brushed_rough.jpg', ntex='brushed_normal.png', nstr=.4, tile=.25),
    graphite=mat('graphite', (.11, .115, .125), .9, .3, rtex='brushed_rough.jpg', ntex='brushed_normal.png', nstr=.5, tile=.2),
    titanium=mat('titanium', (.22, .225, .235), 1., .28, rtex='brushed_rough.jpg', ntex='brushed_normal.png', nstr=.5, tile=.2),
    alu=mat('alu', (.78, .79, .81), 1., .24, rtex='brushed_rough.jpg', ntex='brushed_normal.png', nstr=.35, tile=.3),
    space_black=mat('space_black', (.055, .057, .062), .95, .3, rtex='brushed_rough.jpg', ntex='brushed_normal.png', nstr=.3, tile=.3),
    white_case=mat('white_case', (.56, .57, .59), .0, .42, coat=.3),
    matte_black=mat('matte_black', (.025, .026, .03), .0, .62),
    rubber=mat('rubber', (.02, .02, .022), 0, .85),
    glass=mat('glass', (.6, .7, .78), 0, .03, alpha=.1, coat=.5),
    hex_cut=mat('hex_cut', (.16, .17, .19), .85, .35, atex='hex_rgba.png', ntex='hex_normal.png', nstr=1., tile=.06),
    holes_cut=mat('holes_cut', (.22, .23, .25), .85, .38, atex='holes_rgba.png', ntex='holes_normal.png', nstr=1., tile=.05),
    slats_cut=mat('slats_cut', (.06, .06, .065), .7, .4, atex='slats_rgba.png', ntex='slats_normal.png', nstr=1., tile=.05),
    inner_glow=mat('inner_glow', (.02, .03, .05), 0, .8, emit=(.12, .2, .35), estr=1.2),
    tint_glass=mat('tint_glass', (.08, .09, .1), 0, .05, alpha=.42, coat=1),
    hex=mat('hex_grille', (.16, .17, .19), .85, .35, ctex='hex_color.jpg', ntex='hex_normal.png', nstr=1.2, tile=.06),
    hex_dark=mat('hex_grille_dark', (.07, .075, .085), .8, .4, ctex='hex_color.jpg', ntex='hex_normal.png', nstr=1.2, tile=.05),
    holes=mat('holes', (.2, .21, .23), .85, .38, ctex='holes_color.jpg', ntex='holes_normal.png', nstr=1.1, tile=.05),
    slats=mat('slats', (.05, .05, .055), .7, .4, ctex='slats_color.jpg', ntex='slats_normal.png', nstr=1.2, tile=.05),
    pcb=mat('pcb', (1, 1, 1), .1, .45, ctex='pcb_color.jpg', tile=.18),
    screen=mat('screen', (0, 0, 0), 0, .05, etex='screen_emit.jpg', estr=2.2, coat=1, tile=-1),
    keys=mat('keys', (1, 1, 1), 0, .6, ctex='keys_color.jpg', tile=-1),
    gold=mat('gold', (.83, .64, .3), 1., .28, rtex='brushed_rough.jpg', tile=.2),
    nv_green=mat('nv_green', (.3, .8, .1), 0, .4, emit=(.35, 1, .1), estr=3),
    rgb_cyan=mat('rgb_cyan', (.1, .8, 1), 0, .3, emit=(.15, .75, 1), estr=16),
    rgb_magenta=mat('rgb_magenta', (1, .1, .8), 0, .3, emit=(1, .15, .75), estr=14),
    rgb_red=mat('rgb_red', (1, .05, .08), 0, .3, emit=(1, .06, .1), estr=14),
    rgb_white=mat('rgb_white', (1, 1, 1), 0, .3, emit=(.9, .95, 1), estr=10),
    copper=mat('copper', (.95, .55, .35), 1, .3),
    fan_blade=mat('fan_blade', (.03, .03, .035), 0, .45),
    silver_logo=mat('silver_logo', (.85, .86, .88), 1, .18),
    red_accent=mat('red_accent', (.85, .05, .07), .3, .35),
    label=mat('label', (.82, .83, .8), 0, .6),
    powder=mat('powder', (.045, .048, .054), .15, .62, ntex='brushed_normal.png', nstr=.25, tile=.25),
    usb_blue=mat('usb_blue', (.1, .3, .9), 0, .4, emit=(.1, .35, 1), estr=2),
    sleeve_white=mat('sleeve_white', (.8, .8, .82), 0, .7),
)

# ---------------------------------------------------------------- 几何（全部 bmesh，不依赖界面上下文）
class Asset:
    def __init__(self, name):
        self.name = name; self.parts = {}
    def add(self, material, bm):
        me = bpy.data.meshes.new('tmp'); bm.to_mesh(me); bm.free()
        key = material.name
        if key not in self.parts: self.parts[key] = (material, bmesh.new())
        self.parts[key][1].from_mesh(me); bpy.data.meshes.remove(me)
    def finish(self):
        root = bpy.data.objects.new(self.name, None); SCN.collection.objects.link(root)
        for key, (material, bm) in self.parts.items():
            me = bpy.data.meshes.new(f'{self.name}.{key}')
            uvl = bm.loops.layers.uv.verify(); tile = TILE.get(key, .05)
            bm.normal_update()
            if tile == -1:   # 屏幕 / 键盘：按包围盒铺满 0..1
                xs = [v.co for v in bm.verts]
                for f in bm.faces:
                    n = f.normal; ax = max(range(3), key=lambda i: abs(n[i])); a, c = [i for i in range(3) if i != ax]
                    lo = [min(p[a] for p in xs), min(p[c] for p in xs)]; hi = [max(p[a] for p in xs), max(p[c] for p in xs)]
                    for l in f.loops: l[uvl].uv = ((l.vert.co[a] - lo[0]) / max(1e-6, hi[0] - lo[0]), (l.vert.co[c] - lo[1]) / max(1e-6, hi[1] - lo[1]))
            else:
                for f in bm.faces:
                    n = f.normal; ax = max(range(3), key=lambda i: abs(n[i])); a, c = [i for i in range(3) if i != ax]
                    for l in f.loops: l[uvl].uv = (l.vert.co[a] / tile, l.vert.co[c] / tile)
            bm.to_mesh(me); bm.free()
            for p in me.polygons: p.use_smooth = True
            try: me.set_sharp_from_angle(angle=math.radians(32))
            except Exception: pass
            ob = bpy.data.objects.new(me.name, me); ob.data.materials.append(material); ob.parent = root
            SCN.collection.objects.link(ob)
        return root

def box(sx, sy, sz, cx=0, cy=0, cz=0, bev=.0, seg=2, rz=0.):
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1)
    for v in bm.verts: v.co = Vector((v.co.x * sx, v.co.y * sy, v.co.z * sz))
    if bev > 0: bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bev, segments=seg, profile=.5, affect='EDGES', clamp_overlap=True)
    if rz: bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(rz, 3, 'Z'))
    bmesh.ops.translate(bm, verts=bm.verts, vec=(cx, cy, cz))
    return bm

def cyl(r, h, cx=0, cy=0, cz=0, axis='Z', seg=40, r2=None, cap=True):
    bm = bmesh.new(); bmesh.ops.create_cone(bm, cap_ends=cap, segments=seg, radius1=r, radius2=r if r2 is None else r2, depth=h)
    if axis == 'X': bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, 'Y'))
    if axis == 'Y': bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, 'X'))
    bmesh.ops.translate(bm, verts=bm.verts, vec=(cx, cy, cz))
    return bm

def torus(R, r, cx=0, cy=0, cz=0, axis='Z', seg=48, rseg=10):
    bm = bmesh.new()
    verts = []
    for i in range(seg):
        a = i / seg * math.tau; ring = []
        for j in range(rseg):
            b = j / rseg * math.tau
            p = Vector(((R + r * math.cos(b)) * math.cos(a), (R + r * math.cos(b)) * math.sin(a), r * math.sin(b)))
            ring.append(bm.verts.new(p))
        verts.append(ring)
    for i in range(seg):
        for j in range(rseg):
            a, b, c, d = verts[i][j], verts[(i + 1) % seg][j], verts[(i + 1) % seg][(j + 1) % rseg], verts[i][(j + 1) % rseg]
            bm.faces.new((a, b, c, d))
    if axis == 'X': bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, 'Y'))
    if axis == 'Y': bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, 'X'))
    bmesh.ops.translate(bm, verts=bm.verts, vec=(cx, cy, cz))
    return bm

def text(asset, material, body, size, cx, cy, cz, depth=.0006, rot=(0, 0, 0), align='CENTER'):
    cu = bpy.data.curves.new('t', type='FONT'); cu.body = body; cu.size = size; cu.extrude = depth; cu.align_x = align; cu.align_y = 'CENTER'
    ob = bpy.data.objects.new('t', cu); SCN.collection.objects.link(ob)
    ob.rotation_euler = rot; ob.location = (cx, cy, cz)
    bpy.context.view_layer.update()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(bpy.context.evaluated_depsgraph_get()))
    me.transform(ob.matrix_world)
    bm = bmesh.new(); bm.from_mesh(me); bpy.data.meshes.remove(me); bpy.data.objects.remove(ob); bpy.data.curves.remove(cu)
    asset.add(material, bm)

def fan(asset, cx, cy, cz, d, axis='Y', blades=9, ring_mat=None, frame=True):
    """风扇：外框 + 9 片斜叶 + 中心轴盖；axis = 出风方向"""
    r = d / 2
    if frame: asset.add(M['matte_black'], torus(r * .98, d * .03, cx, cy, cz, axis, 48, 8))
    if ring_mat: asset.add(ring_mat, torus(r * .9, d * .012, cx, cy, cz, axis, 64, 6))
    asset.add(M['matte_black'], cyl(r * .3, d * .12, cx, cy, cz, axis, 32))
    for i in range(blades):
        a = i / blades * math.tau
        bm = box(r * .62, d * .012, d * .1)
        bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(.45, 3, 'X'))
        bmesh.ops.translate(bm, verts=bm.verts, vec=(r * .58, 0, 0))
        bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(a, 3, 'Y'))
        if axis == 'Z': bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, 'X'))
        if axis == 'X': bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, 'Z'))
        bmesh.ops.translate(bm, verts=bm.verts, vec=(cx, cy, cz))
        asset.add(M['fan_blade'], bm)

def status_strip(asset, sx, sz, cx, cy, cz):
    asset.add(M['status'], box(sx, .0015, sz, cx, cy, cz))

# ---------------------------------------------------------------- 各台机器
def gb10(name, shell, front, accent=None, logo='', logo_mat=None):
    """GB10 小主机：150×150×51 mm，倒角外壳 + 正面格栅 + 侧面散热槽 + 顶面 logo + 状态灯"""
    a = Asset(name); W, D, H = .150, .150, .051
    a.add(shell, box(W, D, H, 0, 0, H / 2, bev=.006, seg=4))
    a.add(front, box(W * .86, .002, H * .62, 0, -D / 2 - .0008, H * .5))               # 正面格栅
    a.add(front, box(W * .86, .002, H * .62, 0, D / 2 + .0008, H * .5))                # 背面格栅
    for i in range(9):                                                                  # 侧面散热槽
        a.add(M['matte_black'], box(.0012, D * .05, H * .5, W / 2 + .0002, -D * .32 + i * D * .08, H * .5))
    a.add(M['rubber'], box(W * .82, D * .82, .003, 0, 0, -.0005, bev=.001))
    status_strip(a, W * .3, .0022, 0, -D / 2 - .0022, H * .16)                          # 正面状态灯条
    if accent: a.add(accent, box(W * .9, .0016, .0018, 0, -D / 2 - .0016, H * .9))
    for (x, y) in ((-.045, .0755), (-.03, .0755), (.03, .0755), (.045, .0755)):          # 背面接口
        a.add(M['matte_black'], box(.01, .003, .006, x, y, H * .25))
    if logo: text(a, logo_mat or M['silver_logo'], logo, .018 if logo != 'DELL' else .012, 0, 0, H + .0002)
    for (x, y) in ((-.055, -.055), (.055, -.055), (-.055, .055), (.055, .055)): a.add(M['rubber'], cyl(.008, .004, x, y, -.002, 'Z', 20))
    if name == 'spark_asus':   # 顶面状态光环 + 斜切饰面
        a.add(M['status'], torus(.042, .0016, 0, 0, H + .0006, 'Z', 96, 8))
        a.add(M['graphite'], box(W * .9, .012, .002, 0, -D * .38, H + .0005, bev=.0008))
    if name == 'spark_msi':    # 顶面两道红色斜饰条
        for dx in (-.03, .03): a.add(M['red_accent'], box(.075, .003, .0008, dx, -D * .3, H + .0004, rz=math.radians(28)))
    if name == 'spark_dell':   # 圆形 logo 环 + 银色腰线
        a.add(M['silver_logo'], torus(.022, .0016, 0, 0, H + .0006, 'Z', 80, 8))
        a.add(M['alu'], box(W + .001, D + .001, .004, 0, 0, H * .32))
    return a.finish()

def server_a100():
    """4U 机架服务器：蜂窝前面板 + 8 个硬盘托架 + 挂耳把手 + NVIDIA 绿色饰条"""
    a = Asset('server_a100'); W, D, H = .44, .70, .176
    a.add(M['graphite'], box(W, D, H, 0, 0, H / 2, bev=.004, seg=3))
    a.add(M['hex_cut'], box(W * .9, .004, H * .52, 0, -D / 2 - .001, H * .62))
    a.add(M['matte_black'], box(W * .9, .002, H * .52, 0, -D / 2 + .05, H * .62))
    for k in range(6): fan(a, -W * .375 + k * W * .15, -D / 2 + .028, H * .62, .062, 'Y', ring_mat=M['nv_green'])
    for i in range(8):                                                                  # 硬盘托架
        x = -W * .42 + i * W * .12
        a.add(M['black_metal'], box(W * .105, .008, H * .2, x, -D / 2 - .003, H * .17, bev=.002))
        a.add(M['status'], box(.004, .002, .004, x + W * .035, -D / 2 - .008, H * .23))
        a.add(M['rgb_cyan'], box(.004, .002, .004, x + W * .045, -D / 2 - .008, H * .23))
    for s in (-1, 1):                                                                   # 挂耳 + 把手
        a.add(M['titanium'], box(.03, .012, H, s * (W / 2 + .015), -D / 2 + .004, H / 2, bev=.002))
        a.add(M['alu'], torus(.022, .004, s * (W / 2 + .018), -D / 2 - .012, H / 2, 'X', 32, 8))
    a.add(M['nv_green'], box(W * .9, .002, .004, 0, -D / 2 - .002, H * .93))
    a.add(M['status'], box(.05, .002, .006, W * .36, -D / 2 - .0035, H * .93))
    text(a, M['silver_logo'], 'A100 ×4', .022, -W * .3, -D / 2 - .0035, H * .93, rot=(math.pi / 2, 0, 0))
    a.add(M['alu'], box(W * .96, D * .9, .002, 0, .0, H + .001))                         # 顶盖
    a.add(M['powder'], box(W * .985, D * .985, .002, 0, 0, H + .001, bev=.0008))            # 粉末喷涂顶盖（不反光成白板）
    a.add(M['hex_dark'], box(W * .82, D * .2, .0015, 0, -D * .33, H + .0022))                # 前段进风格栅
    for i in range(3): a.add(M['titanium'], box(W * .9, .004, .0012, 0, -D * .1 + i * D * .2, H + .0024))   # 顶盖压筋
    for (x, y) in ((-W * .45, -D * .45), (W * .45, -D * .45), (-W * .45, D * .45), (W * .45, D * .45), (0, -D * .45), (0, D * .45)):
        a.add(M['silver_logo'], cyl(.004, .0015, x, y, H + .0025, 'Z', 16))
    a.add(M['label'], box(.11, .06, .0006, W * .28, D * .32, H + .0024))
    text(a, M['matte_black'], 'NVIDIA A100', .009, W * .28, D * .32 + .01, H + .0028)
    text(a, M['matte_black'], '4 x 40GB SXM', .006, W * .28, D * .32 - .008, H + .0028)
    a.add(M['screen'], box(.05, .002, .018, -W * .36, -D / 2 - .004, H * .93))
    return a.finish()

def tower(name, shell, front, gpus, ram_mat, fan_ring, H=.46, W=.21, D=.45, glass=True, open_frame=False, logo=''):
    """塔式机：外壳 + 玻璃侧板（+X）+ 主板 / 风冷塔 / 内存 / 显卡 / 前置 RGB 风扇 / 电源仓"""
    a = Asset(name)
    t = .006
    if open_frame:   # 开放式测试架：铝框
        for (x, y) in ((-W / 2, -D / 2), (W / 2, -D / 2), (-W / 2, D / 2), (W / 2, D / 2)):
            a.add(M['alu'], box(.016, .016, H, x, y, H / 2, bev=.002))
        for z in (.01, H - .01):
            a.add(M['alu'], box(W, .016, .016, 0, -D / 2, z, bev=.002)); a.add(M['alu'], box(W, .016, .016, 0, D / 2, z, bev=.002))
            a.add(M['alu'], box(.016, D, .016, -W / 2, 0, z, bev=.002)); a.add(M['alu'], box(.016, D, .016, W / 2, 0, z, bev=.002))
    else:
        a.add(shell, box(W, D, t, 0, 0, t / 2, bev=.002))                                    # 底
        for (sx, sy, cx_, cy_) in ((W, .04, 0, -D / 2 + .02), (W, .04, 0, D / 2 - .02), (.025, D, -W / 2 + .0125, 0), (.025, D, W / 2 - .0125, 0)):
            a.add(shell, box(sx, sy, t, cx_, cy_, H - t / 2, bev=.002))                    # 顶框
        a.add(M['hex_cut'], box(W - .05, D - .08, .003, 0, 0, H - .002))                      # 顶部透孔
        for fy in (-D * .15, D * .15): fan(a, 0, fy, H - .022, .12, 'Z', ring_mat=fan_ring)   # 顶部风扇
        for (x, y) in ((-W * .4, -D * .42), (W * .4, -D * .42), (-W * .4, D * .42), (W * .4, D * .42)): a.add(M['rubber'], cyl(.016, .012, x, y, -.006, 'Z', 24))
        # 前置 IO：开机键（状态灯圈）+ 两个 USB-A + USB-C
        a.add(M['alu'], cyl(.008, .004, -W * .3, -D / 2 - .002, H * .97, 'Y', 32)); a.add(M['status'], torus(.0105, .0013, -W * .3, -D / 2 - .003, H * .97, 'Y', 48, 6))
        for k, x in enumerate((-W * .08, W * .04)):
            a.add(M['matte_black'], box(.013, .004, .006, x, -D / 2 - .002, H * .97)); a.add(M['usb_blue'], box(.009, .002, .0015, x, -D / 2 - .0035, H * .97 + .001))
        a.add(M['matte_black'], box(.009, .004, .0035, W * .16, -D / 2 - .002, H * .97, bev=.001))
        a.add(shell, box(t, D, H, -W / 2 + t / 2, 0, H / 2, bev=.003))                       # 左侧板
        a.add(shell, box(W, t, H, 0, D / 2 - t / 2, H / 2, bev=.003))                        # 背板
        cut = {'hex_grille': M['hex_cut'], 'hex_grille_dark': M['hex_cut'], 'holes': M['holes_cut'], 'slats': M['slats_cut']}.get(front.name, front)
        a.add(cut, box(W - .004, .004, H * .92, 0, -D / 2 + .002, H * .5, bev=.002))         # 前面板（透孔，能看到后面的 RGB 风扇）
        a.add(M['inner_glow'], box(.002, D * .9, H * .9, -W / 2 + .008, 0, H / 2))           # 内侧背光：零件剪影
        if fan_ring: a.add(fan_ring, box(.004, D * .9, .004, W / 2 - .02, 0, H - .018))       # 机箱内顶部灯带
        if fan_ring: a.add(fan_ring, box(.004, .004, H * .8, W / 2 - .02, D / 2 - .02, H / 2))
        a.add(shell, box(W, .012, H * .06, 0, -D / 2 + .004, H * .97, bev=.003))
        a.add(M['glass'] if glass else shell, box(.004, D - .02, H - .02, W / 2 - .002, 0, H / 2, bev=.002))   # 玻璃侧板
        a.add(M['black_metal'], box(.006, D, .01, W / 2 - .004, 0, H - .006)); a.add(M['black_metal'], box(.006, D, .01, W / 2 - .004, 0, .006))
        a.add(M['matte_black'], box(W * .95, D * .5, H * .2, 0, D * .2, H * .1, bev=.003))   # 电源仓
        status_strip(a, W * .7, .003, 0, -D / 2 - .001, H * .985)                             # 顶部状态灯
    # 主板 + 供电散热片 + M.2 散热片 + 芯片组盖板 + 24pin 线
    a.add(M['pcb'], box(.003, D * .6, H * .62, -W / 2 + .012, D * .05, H * .6))
    a.add(M['graphite'], box(.02, .085, .022, -W / 2 + .024, D * .12, H * .78, bev=.002))
    a.add(M['graphite'], box(.02, .022, .075, -W / 2 + .024, D * .2, H * .66, bev=.002))
    a.add(M['graphite'], box(.006, .085, .024, -W / 2 + .016, D * .06, H * .49, bev=.0015))
    a.add(M['black_metal'], box(.006, .06, .055, -W / 2 + .016, D * .24, H * .43, bev=.002))
    text(a, M['silver_logo'], logo or 'GAMING', .007, -W / 2 + .0195, D * .24, H * .43, rot=(math.pi / 2, 0, math.pi / 2))
    for k in range(6): a.add(M['sleeve_white'] if not open_frame else M['matte_black'], cyl(.0022, H * .32, -W / 2 + .03 + k * .0001, -D * .22 + k * .005, H * .55, 'Z', 10))
    # 风冷塔：一叠鳍片 + 热管 + 风扇
    for i in range(18):
        a.add(M['alu'], box(.06, .07, .0012, -W / 2 + .05, D * .12, H * .62 + (i - 9) * .0045))
    for k in range(3): a.add(M['copper'], cyl(.003, .1, -W / 2 + .03, D * .12 - .02 + k * .02, H * .62, 'Z', 12))
    fan(a, -W / 2 + .05, D * .12 - .045, H * .62, .085, 'Y', ring_mat=fan_ring)
    # 内存四根 + 顶部 RGB
    for k in range(4):
        a.add(M['black_metal'], box(.012, .006, .04, -W / 2 + .025, D * .28 + k * .01, H * .66))
        a.add(ram_mat, box(.012, .006, .004, -W / 2 + .025, D * .28 + k * .01, H * .686))
    # 显卡
    for gi, g in enumerate(gpus):
        z = H * .38 - gi * .06
        L, T, Hh = g.get('len', .3), g.get('thick', .045), g.get('h', .12)
        a.add(g['mat'], box(Hh * .9, L, T, -W / 2 + .012 + Hh * .45, -D * .02, z, bev=.004, seg=3))   # 外罩（横插）
        a.add(M['black_metal'], box(Hh * .9, L * .98, .003, -W / 2 + .012 + Hh * .45, -D * .02, z + T / 2 + .002))  # 背板
        nf = g.get('fans', 2)
        for f in range(nf):
            fy = -D * .02 - L / 2 + L * (f + .5) / nf
            fan(a, -W / 2 + .012 + Hh * .45, fy, z - T / 2 - .002, min(L / nf * .82, Hh * .8), 'Z', ring_mat=g.get('ring'))
        if g.get('logo_mat'): a.add(g['logo_mat'], box(.003, L * .5, .004, -W / 2 + .012 + Hh * .9, -D * .02, z))
        a.add(M['alu'], box(.004, .002, T + .01, -W / 2 + .012 + Hh * .45, D / 2 - .03, z))                       # 挡板
        for c2 in range(2): a.add(M['matte_black'], cyl(.0025, .05, -W / 2 + .012 + Hh * .6 + c2 * .006, -D * .02 + L * .25, z + T / 2 + .025, 'Z', 10))   # 供电线
        if g.get('label'): text(a, M['silver_logo'], g['label'], .011, -W / 2 + .012 + Hh * .9 + .002, -D * .02, z, rot=(0, math.pi / 2, math.pi / 2))
    if len(gpus) > 1 and gpus[0].get('nvlink'):
        a.add(M['nv_green'], box(.008, .06, H * .06 + .01, -W / 2 + .012 + .11, -D * .02 + .05, H * .38 - .03))
    # 前置风扇（隔着网孔看到灯环）
    if not open_frame:
        for k in range(3): fan(a, 0, -D / 2 + .022, H * .2 + k * H * .25, .12, 'Y', ring_mat=fan_ring)
    if logo: text(a, M['silver_logo'], logo, .016, 0, -D / 2 - .001, H * .06, rot=(math.pi / 2, 0, 0))
    return a.finish()

def rog_z13():
    """ROG Flow Z13：13 寸平板 + 支架 + 背面透明窗与 RGB 灯条 + 前面键盘"""
    a = Asset('rog_z13'); W, Ht, T = .302, .204, .014
    tilt = math.radians(18)
    def put(bm):
        bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(-tilt, 3, 'X'))
        bmesh.ops.translate(bm, verts=bm.verts, vec=(0, .02, Ht / 2 * math.cos(tilt) + .004)); return bm
    a.add(M['space_black'], put(box(W, T, Ht, 0, 0, 0, bev=.004, seg=3)))
    a.add(M['screen'], put(box(W * .94, .001, Ht * .9, 0, -T / 2 - .0006, 0)))
    a.add(M['tint_glass'], put(box(W * .16, .002, Ht * .3, W * .2, T / 2 + .0008, Ht * .1)))
    a.add(M['rgb_magenta'], put(box(W * .5, .002, .003, 0, T / 2 + .001, -Ht * .35)))
    a.add(M['rgb_red'], put(box(.02, .002, .02, -W * .25, T / 2 + .001, Ht * .2)))
    bm = box(W * .7, .004, Ht * .55, 0, 0, 0)                                             # 支架
    bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(math.radians(45), 3, 'X'))
    bmesh.ops.translate(bm, verts=bm.verts, vec=(0, .085, .06)); a.add(M['space_black'], bm)
    a.add(M['matte_black'], box(W, .11, .006, 0, -.08, .003, bev=.002))                   # 键盘
    a.add(M['keys'], box(W * .92, .07, .001, 0, -.07, .0065))
    a.add(M['matte_black'], box(W * .32, .03, .0012, 0, -.122, .0066))
    status_strip(a, W * .12, .002, W * .38, -.0, .004)
    return a.finish()

def mac_mini():
    a = Asset('mac_mini'); W, H = .197, .036
    a.add(M['alu'], box(W, W, H, 0, 0, H / 2 + .003, bev=.018, seg=8))
    a.add(M['rubber'], cyl(W * .42, .004, 0, 0, .002, 'Z', 64))
    a.add(M['matte_black'], box(W * .7, .002, .008, 0, W / 2 + .0005, H * .45))
    status_strip(a, .003, .003, -W * .4, -W / 2 - .0008, H * .5)
    a.add(M['silver_logo'], cyl(.012, .0006, 0, 0, H + .0034, 'Z', 40))
    return a.finish()

def macbook():
    """中央本机：MacBook Pro 14 寸深空黑，屏幕打开 112°"""
    a = Asset('macbook_pro'); W, D, T = .312, .221, .0155
    a.add(M['space_black'], box(W, D, T, 0, 0, T / 2, bev=.005, seg=5))
    a.add(M['keys'], box(W * .82, D * .42, .0008, 0, D * .14, T + .0002))
    a.add(M['matte_black'], box(W * .42, D * .3, .0005, 0, -D * .26, T + .0001))         # 触控板
    ang = math.radians(112)
    def lid(bm):
        bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(-(math.pi - ang), 3, 'X'))
        bmesh.ops.translate(bm, verts=bm.verts, vec=(0, D / 2, T)); return bm
    a.add(M['space_black'], lid(box(W, .006, D, 0, 0, D / 2, bev=.004, seg=4)))
    a.add(M['matte_black'], lid(box(W * .975, .0008, D * .965, 0, -.0034, D / 2)))
    a.add(M['screen'], lid(box(W * .93, .0008, D * .86, 0, -.0039, D * .52)))
    a.add(M['silver_logo'], lid(cyl(.016, .0008, 0, .0034, D / 2, 'Y', 40)))
    status_strip(a, W * .2, .0015, 0, -D / 2 - .0004, T * .5)
    return a.finish()

def cloud_blade():
    """云电脑：开放机架上的一台 1U 刀片，青色灯"""
    a = Asset('cloud_blade'); W, D = .44, .5
    for x in (-W / 2 - .02, W / 2 + .02):
        a.add(M['black_metal'], box(.02, .02, .25, x, -D / 2, .125, bev=.002)); a.add(M['black_metal'], box(.02, .02, .25, x, D / 2, .125, bev=.002))
    a.add(M['graphite'], box(W, D, .044, 0, 0, .1, bev=.003))
    a.add(M['holes'], box(W * .9, .003, .03, 0, -D / 2 - .001, .1))
    a.add(M['rgb_cyan'], box(W * .9, .002, .003, 0, -D / 2 - .003, .082))
    status_strip(a, .04, .006, W * .38, -D / 2 - .004, .112)
    a.add(M['black_metal'], box(W, D, .044, 0, 0, .16, bev=.003)); a.add(M['hex_dark'], box(W * .9, .003, .03, 0, -D / 2 - .001, .16))
    text(a, M['silver_logo'], 'CLOUD', .014, -W * .3, -D / 2 - .003, .112, rot=(math.pi / 2, 0, 0))
    return a.finish()

# ---------------------------------------------------------------- 组装
roots = [
    gb10('spark_asus', M['titanium'], M['hex'], None, 'ASUS'),
    gb10('spark_msi', M['matte_black'], M['slats'], M['red_accent'], 'msi', M['red_accent']),
    gb10('spark_dell', M['graphite'], M['holes'], M['alu'], 'DELL'),
    server_a100(),
    tower('tower_white_4060', M['white_case'], M['holes'], [dict(mat=M['black_metal'], len=.2, fans=2, h=.11, ring=M['rgb_cyan'], logo_mat=M['rgb_cyan'], label='RTX 4060')], M['rgb_cyan'], M['rgb_cyan'], logo='ASUS'),
    tower('tower_dual_2080', M['black_metal'], M['hex_dark'], [dict(mat=M['titanium'], len=.27, fans=1, h=.11, nvlink=True, logo_mat=M['nv_green'], label='RTX 2080 Ti'), dict(mat=M['titanium'], len=.27, fans=1, h=.11, logo_mat=M['nv_green'])], M['rgb_white'], M['rgb_white'], H=.52, D=.5),
    tower('tower_4080', M['black_metal'], M['hex'], [dict(mat=M['alu'], len=.31, fans=2, h=.14, thick=.06, label='RTX 4080', logo_mat=M['rgb_white'])], M['rgb_magenta'], M['rgb_magenta']),
    tower('tower_titan', M['graphite'], M['holes'], [dict(mat=M['gold'], len=.27, fans=1, h=.11, label='TITAN V', logo_mat=M['rgb_white']), dict(mat=M['black_metal'], len=.22, fans=2, h=.1, logo_mat=M['rgb_white'])], M['rgb_white'], M['rgb_white']),
    tower('tower_3090ti', M['matte_black'], M['slats'], [dict(mat=M['black_metal'], len=.31, fans=2, h=.14, thick=.06, label='RTX 3090 Ti', logo_mat=M['alu'])], M['rgb_red'], M['rgb_red']),
    tower('bench_dual_2080', M['alu'], M['alu'], [dict(mat=M['titanium'], len=.27, fans=1, h=.11, nvlink=True, logo_mat=M['nv_green']), dict(mat=M['titanium'], len=.27, fans=1, h=.11, logo_mat=M['nv_green'])], M['rgb_cyan'], None, H=.34, open_frame=True),
    rog_z13(), mac_mini(), macbook(), cloud_blade(),
]
# 摆成一排方便预览；网页按名字取根节点，位置不用这里的
for i, r in enumerate(roots): r.location = ((i % 7) * .62 - 1.86, (i // 7) * .9, 0)

glb = os.path.join(OUT, 'fleet_assets.glb')
bpy.ops.export_scene.gltf(filepath=glb, export_format='GLB', use_selection=False, export_apply=True, export_yup=True,
                          export_image_format='AUTO', export_materials='EXPORT', export_extras=False)
print('EXPORTED', glb, os.path.getsize(glb))

if RENDER:   # 预览：影棚光 + Cycles，看建模和材质
    SCN.render.engine = 'CYCLES'
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences; prefs.compute_device_type = 'HIP'; prefs.get_devices()
        for d in prefs.devices: d.use = True
        SCN.cycles.device = 'GPU'
    except Exception as e: print('GPU 设置失败，用 CPU', e)
    SCN.cycles.samples = 96; SCN.cycles.use_denoising = True
    SCN.render.resolution_x, SCN.render.resolution_y = 2400, 1100
    world = bpy.data.worlds.new('w'); SCN.world = world; world.use_nodes = True
    bg = world.node_tree.nodes['Background']; bg.inputs['Color'].default_value = (.012, .016, .022, 1); bg.inputs['Strength'].default_value = 1
    for (loc, en, sz, col) in [((2.5, -3, 3.5), 900, 3, (1, .97, .94)), ((-3, -2, 2), 400, 3, (.6, .8, 1)), ((0, 3, 2.5), 600, 3, (.5, .9, 1))]:
        L = bpy.data.lights.new('l', 'AREA'); L.energy = en; L.size = sz; L.color = col
        o = bpy.data.objects.new('l', L); o.location = loc; SCN.collection.objects.link(o)
        o.rotation_euler = (Vector((0, 0, .2)) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    floor = bpy.data.meshes.new('floor'); bm = box(12, 12, .01, 0, 0, -.005); bm.to_mesh(floor); bm.free()
    fo = bpy.data.objects.new('floor', floor); SCN.collection.objects.link(fo); fo.data.materials.append(mat('floor', (.02, .025, .03), .3, .45))
    cam = bpy.data.cameras.new('c'); cam.lens = 50; co = bpy.data.objects.new('c', cam); SCN.collection.objects.link(co); SCN.camera = co
    co.location = (0, -4.6, 2.3); co.rotation_euler = (Vector((0, .4, .1)) - co.location).to_track_quat('-Z', 'Y').to_euler()
    SCN.render.filepath = os.path.join(OUT, 'preview.png'); bpy.ops.render.render(write_still=True)
    print('RENDERED', SCN.render.filepath)
