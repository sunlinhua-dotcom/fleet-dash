// DASH v3 · 3D 机库
// 真模型（Blender 程序化建模、PBR 材质，见 assets3d/）立在各站点的岛上；每台机器引出一束发光光流（几十根细丝，中段散开、两端收拢）
// 汇入中央的「宇宙中心」；外圈是每台机器 45 分钟温度的刻度尖刺环。环境反射 + 软阴影 + 辉光。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export const STATUS_COLOR = { normal: '#8fcfff', busy: '#3df2a4', warm: '#ffb547', hot: '#ff4d5e', asleep: '#3b4652', offline: '#2d353e' };
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (t) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => (v == null || !Number.isFinite(+v) ? '—' : Math.round(+v));
export const statusOf = (m) => (!m || m.online === false ? 'offline' : STATUS_COLOR[m.status] ? m.status : 'normal');
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const mulberry = (seed) => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const rank = (s) => ({ hot: 5, warm: 4, busy: 3, normal: 2, asleep: 1, offline: 0 }[s] ?? 0);

// 机器 → 模型
const ASSET = {};   // 机器 id → 模型名（可选）。更简单：在快照里给每台机器写 model 字段，见 docs/data-contract.md
const BY_KIND = { gb10: 'spark_dell', server: 'server_a100', windows: 'tower_4080', linux: 'tower_dual_2080', mac: 'mac_mini' };
const scaleOf = (name) => (name.startsWith('spark_') ? 3.3 : name === 'macbook_pro' ? 3.0 : name === 'rog_z13' || name === 'mac_mini' ? 2.7 : name.startsWith('bench_') ? 2.3 : 2.05);
const SITE_POS = { home: [-6.4, -.3], campus: [5.6, -3.4], cloud: [6.6, 2.6], partner: [-.4, 5.9] };
const SITE_SPARE = [[-1.2, -5.2], [-7, 6], [8, -1]];
// 手机竖屏：同一方位角，把站点沿屏幕纵向排开（家里在上、外部在下）
const SITE_POS_M = { home: [-2.75, -4.19], campus: [3.72, .19], cloud: [-2.02, 2.77], partner: [.52, 5.17] };
const HUB_R = 1.35;

function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(.35, 'rgba(255,255,255,.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export async function createScene(host, { onHover = () => {}, onSelect = () => {}, onEmpty = () => {}, onViewChange = () => {}, onProgress = () => {} } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  const pxU = { value: Math.min(devicePixelRatio || 1, 2) };   // 点精灵按后期链的像素密度算大小
  renderer.setClearColor(0x03070b, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
  renderer.domElement.className = 'scene-canvas'; host.append(renderer.domElement);
  const gl = renderer.getContext(), dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const software = /swiftshader|llvmpipe|software|basic render/i.test(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '');
  const small = () => host.clientWidth < 760;
  const PHONE = host.clientWidth < 760;
  const rich = !software;
  renderer.shadowMap.enabled = rich && !/[?&]noshadow/.test(location.search); renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const labels = document.createElement('div'); labels.className = 'scene-labels'; host.append(labels);
  const hubTag = document.createElement('div'); hubTag.className = 'tag-hub'; labels.append(hubTag);
  const hubBox = {};
  const setHTML = (o, el, html) => { if (o.html !== html) { o.html = html; el.innerHTML = html; o.dirty = true; } };

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), .04).texture;
  scene.environmentIntensity = .55;
  const camera = new THREE.OrthographicCamera(-10, 10, 6, -6, .1, 300);
  const DIR = new THREE.Vector3(1.05, PHONE ? 2.44 : 1.22, 1.6).normalize();
  // 镜头状态：yaw / pitch 是用户转的方位与俯仰（可 360°），zoom / pan 是全景缩放平移；
  // f：0 = 全景，1 = 对准某台机器（box 是它的包围盒），dz 是对准时的缩放；cen：0 = 机队中心，1 = 宇宙中心（模型页背景）
  const AZ0 = Math.atan2(DIR.x, DIR.z), EL0 = Math.asin(DIR.y), EL_MIN = .14, EL_MAX = 1.5;
  const view = { zoom: 1, dz: 1, yaw: 0, pitch: 0, auto: 0, panA: 0, panB: 0, cen: 0, f: 0, box: new THREE.Box3(new THREE.Vector3(-.5, 0, -.5), new THREE.Vector3(.5, 1, .5)) };
  const vel = { yaw: 0, pitch: 0 };   // 惯性角速度（弧度 / 秒）
  // 输入只改目标，镜头每帧平滑跟过去：鼠标事件和屏幕刷新对不齐时不会一帧动一帧停
  const goal = { yaw: 0, pitch: 0, zoom: 1, dz: 1, panA: 0, panB: 0 }, SMK = Object.keys(goal);
  let tween = null, itw = null, autoTurn = false, focusT0 = 0;
  const clampPitch = (p) => clamp(p, EL_MIN - EL0, EL_MAX - EL0);

  // 光：主光带软阴影 + 冷色补光 + 青色轮廓光
  const key = new THREE.DirectionalLight(0xfff3e6, 2.2); key.position.set(7, 14, 9); scene.add(key); scene.add(key.target);
  key.castShadow = rich; key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -.0004; key.shadow.normalBias = .02; key.shadow.radius = 4;
  Object.assign(key.shadow.camera, { left: -13, right: 13, top: 13, bottom: -13, near: 1, far: 50 });
  const fill = new THREE.DirectionalLight(0x8fb8ff, .55); fill.position.set(-9, 6, 4); scene.add(fill);
  const rim = new THREE.DirectionalLight(0x37d8ff, 1.1); rim.position.set(-4, 5, -12); scene.add(rim);
  scene.add(new THREE.HemisphereLight(0x6f9fd8, 0x05070a, .18));

  // 地面：深色细网格，中心微光
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    vertexShader: 'varying vec2 vP;void main(){vP=position.xy;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: `varying vec2 vP;
      float line(vec2 p,float w){vec2 g=abs(fract(p-.5)-.5)/fwidth(p);return 1.-min(min(g.x,g.y)/w,1.);}
      void main(){float r=length(vP);float fade=smoothstep(30.,5.,r);
        float minor=line(vP*2.,1.)*.05, major=line(vP/2.,1.2)*.14;
        float glow=exp(-r*r/60.)*.12;
        vec3 c=vec3(.12,.34,.5)*(minor+major)*fade+vec3(.03,.16,.22)*glow;
        gl_FragColor=vec4(c,(minor+major)*fade+glow);}`,
  }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -.005; floor.renderOrder = -1; scene.add(floor);
  const shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: .55 }));
  shadowCatcher.rotation.x = -Math.PI / 2; shadowCatcher.position.y = .001; shadowCatcher.receiveShadow = true; scene.add(shadowCatcher);

  const glowTex = glowTexture();
  const world = new THREE.Group(); scene.add(world);

  // ---------- 读模型 ----------
  const gltf = await new Promise((ok, no) => new GLTFLoader().load(`/assets/models/fleet_assets.glb?v=${window.__build || ''}`, ok,
    (e) => { if (e.total) onProgress(e.loaded / e.total); }, no));
  const proto = new Map();
  for (const n of gltf.scene.children) proto.set(n.name, n);
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  gltf.scene.traverse((o) => { if (o.isMesh) { o.castShadow = rich; o.receiveShadow = rich; const m = o.material; if (m && m.name === 'glass') { m.depthWrite = false; m.transparent = true; }
    for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) if (m?.[k]) { m[k].anisotropy = aniso; m[k].needsUpdate = true; } } });   // 各向异性过滤：斜看的格栅纹理不闪
  function instance(name) {
    const src = proto.get(name) || proto.get('tower_4080');
    const g = src.clone(true); g.position.set(0, 0, 0);
    const status = [];
    g.traverse((o) => { if (o.isMesh && o.material?.name === 'STATUS') { o.material = o.material.clone(); status.push(o.material); } });
    const s = scaleOf(name); g.scale.setScalar(s);
    const box = new THREE.Box3().setFromObject(g); const size = box.getSize(new THREE.Vector3());
    g.position.y -= box.min.y;
    return { g, status, size };
  }

  // ---------- 中央：宇宙中心（类星体）——暗核 + 光子环 + 差速旋转的吸积盘 + 上冲喷流 + 旋转星尘 ----------
  const NOISE = `float h21(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
    float vn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h21(i),h21(i+vec2(1.,0.)),f.x),mix(h21(i+vec2(0.,1.)),h21(i+vec2(1.,1.)),f.x),f.y);}
    float fbm(vec2 p){float a=.5,s=0.;for(int i=0;i<4;i++){s+=a*vn(p);p=p*2.03+vec2(1.7,9.2);a*=.5;}return s;}`;
  const core = { spin: { value: .6 }, time: { value: 0 }, dim: { value: 1 } };
  const hub = new THREE.Group(); scene.add(hub);
  const CORE_Y = .42, DISK_Y = .17, DISK_IN = .36, DISK_OUT = HUB_R * 1.1;
  // 深色镜面底盘，承托吸积盘
  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(HUB_R * 1.08, HUB_R * 1.13, .12, 128), new THREE.MeshStandardMaterial({ color: 0x03070a, metalness: .92, roughness: .2 }));
  plinth.position.y = .06; plinth.receiveShadow = rich; hub.add(plinth);
  const plinthRim = new THREE.Mesh(new THREE.TorusGeometry(HUB_R * 1.08, .01, 8, 220), new THREE.MeshBasicMaterial({ color: 0x1d8f6c }));
  plinthRim.rotation.x = Math.PI / 2; plinthRim.position.y = .122; hub.add(plinthRim);
  // 吸积盘：对数螺旋臂 + 两层噪声条纹，内快外慢（开普勒差速），内缘一圈白热边，外缘沉到深青与紫
  const diskMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { time: core.time, spin: core.spin, dim: core.dim, rin: { value: DISK_IN }, rout: { value: DISK_OUT } },
    vertexShader: 'varying vec2 vW;void main(){vec4 w=modelMatrix*vec4(position,1.);vW=w.xz;gl_Position=projectionMatrix*viewMatrix*w;}',
    fragmentShader: `uniform float time,spin,dim,rin,rout;varying vec2 vW;${NOISE}
      void main(){
        float r=length(vW),th=atan(vW.y,vW.x),rn=clamp((r-rin)/(rout-rin),0.,1.);
        float om=spin*.9/pow(max(r,.25),1.5),a=th-time*om;
        vec2 p=vec2(cos(a),sin(a))*r;
        float arms=.5+.5*sin(a*2.-log(r)*5.5);
        float n=fbm(p*3.4+vec2(0.,time*.04)),n2=fbm(p*10.-3.);
        float streak=smoothstep(.28,.95,.55*n+.28*arms+.25*n2);
        float edge=smoothstep(0.,.05,rn)*smoothstep(1.,.6,rn);
        float rq=(rn-.03)/.028;float rim=exp(-rq*rq)*1.7;
        float fall=pow(1.-rn,1.5);
        vec3 c=mix(vec3(.88,1.,.95),vec3(.08,.92,.6),smoothstep(0.,.22,rn));
        c=mix(c,vec3(.02,.36,.4),smoothstep(.22,.68,rn));
        c=mix(c,vec3(.2,.13,.46),smoothstep(.68,1.,rn));
        float I=(edge*(.1+1.15*streak*fall+.22*fall)+rim)*(.92+.08*sin(time*1.7));
        gl_FragColor=vec4(c,clamp(I*dim,0.,1.6));}`,
  });
  const disk = new THREE.Mesh(new THREE.RingGeometry(DISK_IN, DISK_OUT, 256, 8), diskMat);
  disk.rotation.x = -Math.PI / 2; disk.position.y = DISK_Y; disk.renderOrder = 1; hub.add(disk);
  // 暗核：几乎全黑，只有边缘一圈菲涅耳辉光 —— 深邃感来自这块「吞光」的黑
  const coreBall = new THREE.Mesh(new THREE.SphereGeometry(.31, 64, 48), new THREE.ShaderMaterial({
    uniforms: { time: core.time },
    vertexShader: 'varying vec3 vN;void main(){vN=normalize(normalMatrix*normal);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: 'uniform float time;varying vec3 vN;void main(){float f=1.-clamp(vN.z,0.,1.);vec3 c=vec3(0.,.008,.012)+vec3(.08,.9,.6)*pow(f,3.2)*(.8+.2*sin(time*2.3))+vec3(.8,1.,.93)*pow(f,10.)*1.8;gl_FragColor=vec4(c,1.);}',
  }));
  coreBall.position.y = CORE_Y; hub.add(coreBall);
  // 光子环 + 引力透镜弧（贴图精灵，永远朝镜头）
  function ringTexture(arcs) {
    const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d'); g.translate(128, 128);
    if (!arcs) {
      const gr = g.createRadialGradient(0, 0, 70, 0, 0, 128);
      gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(.55, 'rgba(255,255,255,.0)'); gr.addColorStop(.74, 'rgba(255,255,255,1)'); gr.addColorStop(.8, 'rgba(255,255,255,.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(-128, -128, 256, 256);
    } else {
      g.lineCap = 'round';
      for (let i = 0; i < 9; i++) { const a0 = i * .9 + (i % 3) * .3, r = 92 + (i % 4) * 7; g.strokeStyle = `rgba(255,255,255,${.18 + (i % 3) * .14})`; g.lineWidth = 1.5 + (i % 2) * 1.5; g.beginPath(); g.arc(0, 0, r, a0, a0 + .6 + (i % 4) * .35); g.stroke(); }
    }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  }
  const spriteOf = (map, color, op, size) => { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map, color, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false })); s.scale.setScalar(size); s.position.y = CORE_Y; hub.add(s); return s; };
  const photon = spriteOf(ringTexture(false), 0xc9ffe8, .95, .98);
  const lens = spriteOf(ringTexture(true), 0x7fffd0, .55, 1.7);
  const coreGlow = spriteOf(glowTex, 0x16c98a, .26, 4.6);
  const coreGlow2 = spriteOf(glowTex, 0x6a5cff, .07, 7.5);
  // 喷流：上冲的空心光锥，噪声沿高度往上流；中轴一根细亮线
  const jetMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, uniforms: { time: core.time, dim: core.dim },
    vertexShader: 'varying vec2 vUv;varying float vF;void main(){vUv=uv;vec3 n=normalize(normalMatrix*normal);vF=1.-abs(n.z);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: `uniform float time,dim;varying vec2 vUv;varying float vF;${NOISE}
      void main(){float h=clamp(vUv.y,0.,1.),ang=vUv.x*6.2832;vec2 q=vec2(cos(ang)*1.4+h*3.,sin(ang)*1.4-h*7.+time*1.7);
        float n=fbm(q);float a=pow(1.-h,1.7)*smoothstep(0.,.04,h)*(.18+.95*n*n)*(.3+.7*vF)*.55*dim;
        gl_FragColor=vec4(mix(vec3(.2,1.,.72),vec3(.6,.75,1.),h)*(1.+n*.6),a);}`,
  });
  const JET_H = 3.6;
  const jet = new THREE.Mesh(new THREE.CylinderGeometry(.62, .07, JET_H, 64, 1, true), jetMat); jet.position.y = CORE_Y + JET_H / 2; jet.renderOrder = 3; hub.add(jet);
  const jetCore = new THREE.Mesh(new THREE.CylinderGeometry(.012, .03, JET_H * .9, 12, 1, true), new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { time: core.time, dim: core.dim },
    vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: 'uniform float time,dim;varying vec2 vUv;void main(){float h=clamp(vUv.y,0.,1.);float p=fract(h*2.5-time*.9);float a=pow(1.-h,2.2)*(.55+.45*smoothstep(.0,.1,p)*smoothstep(.35,.1,p))*dim;gl_FragColor=vec4(vec3(.75,1.,.92),a);}',
  }));
  jetCore.position.y = CORE_Y + JET_H * .45; hub.add(jetCore);
  // 两道斜置的陀螺光环
  const halo = new THREE.Group(); halo.position.y = CORE_Y; hub.add(halo);
  for (const [r, tilt, op] of [[.56, .5, .45], [.72, -.62, .26]]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, .004, 6, 200), new THREE.MeshBasicMaterial({ color: 0x8ff7c9, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false }));
    ring.rotation.x = Math.PI / 2 + tilt; halo.add(ring);
  }
  // 星尘：上千颗点在盘面附近绕中心差速公转，内亮外暗、外圈偏紫
  const dustN = PHONE ? 760 : 2400, dustR = HUB_R * 1.85;
  const dustGeo = new THREE.BufferGeometry();
  { const R = [], TH = [], Y = [], S = [], C = [], rnd = mulberry(7);
    for (let i = 0; i < dustN; i++) {
      const r = DISK_IN * 1.2 + Math.pow(rnd(), 1.7) * (dustR - DISK_IN * 1.2), rn = r / dustR;
      R.push(r); TH.push(rnd() * TAU); Y.push(DISK_Y + (rnd() - .5) * .05 * (1 + r * 1.6) + .02); S.push((.8 + rnd() * 2.2) * (1.25 - rn * .6));
      const c = new THREE.Color().setHSL(.43 - rn * .1 + (rnd() - .5) * .04 + (rn > .7 ? .25 * (rn - .7) * 3 : 0), .75, .62 - rn * .22);
      C.push(c.r, c.g, c.b);
    }
    dustGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Array(dustN * 3).fill(0), 3));
    dustGeo.setAttribute('aR', new THREE.Float32BufferAttribute(R, 1)); dustGeo.setAttribute('aTh', new THREE.Float32BufferAttribute(TH, 1));
    dustGeo.setAttribute('aY', new THREE.Float32BufferAttribute(Y, 1)); dustGeo.setAttribute('aS', new THREE.Float32BufferAttribute(S, 1)); dustGeo.setAttribute('tint', new THREE.Float32BufferAttribute(C, 3)); }
  const dust = new THREE.Points(dustGeo, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { time: core.time, spin: core.spin, dim: core.dim, px: pxU },
    vertexShader: 'attribute float aR,aTh,aY,aS;attribute vec3 tint;uniform float time,spin,px;varying vec3 vT;varying float vA;void main(){float th=aTh+time*spin*.9/pow(max(aR,.25),1.5);vec3 p=vec3(cos(th)*aR,aY,sin(th)*aR);vT=tint;vA=.35+.65*fract(aTh*7.13+time*.3*fract(aR*3.7));gl_PointSize=aS*px;gl_Position=projectionMatrix*viewMatrix*vec4(p,1.);}',
    fragmentShader: 'uniform float dim;varying vec3 vT;varying float vA;void main(){float d=length(gl_PointCoord-.5)*2.;float a=pow(max(0.,1.-d),2.)*vA*dim;gl_FragColor=vec4(vT,a);}',
  }));
  dust.frustumCulled = false; hub.add(dust);
  let spikeRing = null;

  // ---------- 光流材质：丝束（细线，带沿线流动的脉冲和轻微抖动）+ 朝镜头的柔光带（任意角度都对着镜头）----------
  const flowMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { time: { value: 0 }, sel: { value: -1 }, dim: { value: 1 } },
    vertexShader: `attribute vec3 tint,aDir;attribute float alpha,prog,mid,aPh;uniform float time;varying vec3 vT;varying float vA,vP,vM,vPh;
      void main(){vT=tint;vA=alpha;vP=prog;vM=mid;vPh=aPh;vec3 p=position+aDir*sin(time*1.1+prog*9.+aPh*6.2832)*.028*sin(3.14159*prog);
        gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);}`,
    fragmentShader: `uniform float time,sel,dim;varying vec3 vT;varying float vA,vP,vM,vPh;
      void main(){float p=fract(vP*1.6-time*.3+vPh);float pulse=smoothstep(0.,.035,p)*smoothstep(.16,.035,p);
        float f=sel<0.?1.:(abs(vM-sel)<.5?1.7:.25);
        gl_FragColor=vec4(vT*(1.+pulse*.9),vA*(.55+pulse*2.3)*f*dim);}`,
  });
  const beamMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { time: { value: 0 }, sel: { value: -1 }, dim: { value: 1 }, camDir: { value: new THREE.Vector3(0, -1, 0) } },
    vertexShader: `attribute vec3 tint,aTan;attribute float alpha,prog,mid,aSide,aW;uniform vec3 camDir;varying vec3 vT;varying float vA,vP,vM,vS;
      void main(){vT=tint;vA=alpha;vP=prog;vM=mid;vS=aSide;vec3 s=cross(aTan,camDir);float l=length(s);s=l>1e-4?s/l:vec3(1.,0.,0.);
        gl_Position=projectionMatrix*viewMatrix*modelMatrix*vec4(position+s*aSide*aW,1.);}`,
    fragmentShader: `uniform float time,sel,dim;varying vec3 vT;varying float vA,vP,vM,vS;
      void main(){float core=exp(-vS*vS*9.),soft=exp(-vS*vS*2.4);float p=fract(vP*1.3-time*.22+vM*.31);float pulse=smoothstep(0.,.05,p)*smoothstep(.3,.05,p);
        float f=sel<0.?1.:(abs(vM-sel)<.5?1.6:.3);gl_FragColor=vec4(vT*(1.+core*.7),(soft*.5+core*.5)*vA*(.7+pulse*1.)*f*dim);}`,
  });
  const splashMat = new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const dotMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { px: pxU, dim: { value: 1 } },
    vertexShader: 'attribute vec3 tint;attribute float size;varying vec3 vT;uniform float px;void main(){vT=tint;vec4 mv=modelViewMatrix*vec4(position,1.);gl_PointSize=size*px;gl_Position=projectionMatrix*mv;}',
    fragmentShader: 'uniform float dim;varying vec3 vT;void main(){float d=length(gl_PointCoord-.5)*2.;float a=pow(max(0.,1.-d),2.2)*dim;gl_FragColor=vec4(mix(vT,vec3(1.),pow(max(0.,1.-d),6.)*.7),a);}',
  });

  // ---------- 布局 ----------
  let nodes = new Map(), islands = [], clusters = [], flows = null, flowGeo = null, dots = null, dotGeo = null, particles = [], snap = {}, layoutKey = '', beams = null, splashSprites = [], flowPaths = [], snapLoad = .4;
  let hovered = null, selected = null;
  const pickables = [];
  function clearWorld() {
    for (const n of nodes.values()) { n.label?.remove(); n.stemEl?.remove(); }
    for (const c of clusters) c.label?.remove();
    for (const i of islands) i.label?.remove();
    world.traverse((o) => { if (o.geometry && o.userData.own) o.geometry.dispose(); });
    world.clear(); nodes = new Map(); islands = []; clusters = []; pickables.length = 0;
    flows = null; dots = null; beams = null; splashSprites = [];
  }
  function layout(machines, sites) {
    clearWorld();
    const bySite = new Map();
    for (const m of machines) { if (!bySite.has(m.site)) bySite.set(m.site, []); bySite.get(m.site).push(m); }
    let spare = 0;
    for (const [siteId, list] of bySite) {
      const site = sites.find((s) => s.id === siteId) || { id: siteId, name: siteId };
      const [cx, cz] = (PHONE ? SITE_POS_M : SITE_POS)[siteId] || SITE_SPARE[spare++ % SITE_SPARE.length];
      const spark = list.filter((m) => m.kind === 'gb10'), rest = list.filter((m) => m.kind !== 'gb10');
      const hasCluster = spark.length > 1;
      const ringR = hasCluster ? 2.35 : rest.length <= 1 ? 0 : .95 + rest.length * .22;
      const R = Math.max(1.25, ringR + 1.0);
      const island = new THREE.Group(); island.position.set(cx, 0, cz); world.add(island);
      const slab = new THREE.Mesh(new THREE.CylinderGeometry(R, R * 1.03, .14, 96), new THREE.MeshStandardMaterial({ color: 0x070d13, metalness: .7, roughness: .38 }));
      slab.position.y = .07; slab.receiveShadow = rich; slab.userData.own = true; island.add(slab);
      const rimL = new THREE.Mesh(new THREE.TorusGeometry(R, .008, 6, 200), new THREE.MeshBasicMaterial({ color: 0x2f6f96 }));
      rimL.rotation.x = Math.PI / 2; rimL.position.y = .142; rimL.userData.own = true; island.add(rimL);
      const lab = document.createElement('div'); lab.className = 'tag-site'; labels.append(lab);
      islands.push({ site, group: island, r: R, label: lab, members: list, anchor: new THREE.Vector3(cx, .05, cz + R + .15) });
      if (hasCluster) {
        const cr = .9;
        const ring = new THREE.Mesh(new THREE.TorusGeometry(cr, .014, 8, 200), new THREE.MeshBasicMaterial({ color: 0x3df2a4, transparent: true, opacity: .9, blending: THREE.AdditiveBlending, depthWrite: false }));
        ring.rotation.x = Math.PI / 2; ring.position.set(cx, .36, cz); ring.userData.own = true; world.add(ring);
        const pad = new THREE.Mesh(new THREE.CylinderGeometry(1.45, 1.5, .08, 6), new THREE.MeshStandardMaterial({ color: 0x0c1720, metalness: .8, roughness: .3 }));
        pad.position.set(cx, .18, cz); pad.rotation.y = Math.PI / 6; pad.receiveShadow = rich; pad.userData.own = true; world.add(pad);
        const lab2 = document.createElement('div'); lab2.className = 'tag-cluster'; labels.append(lab2);
        clusters.push({ id: 'spark', ring, label: lab2, members: spark.map((m) => m.id), center: new THREE.Vector3(cx, .36, cz) });
        spark.forEach((m, i) => addMachine(m, cx + Math.cos(i / spark.length * TAU + Math.PI / 4) * cr, cz + Math.sin(i / spark.length * TAU + Math.PI / 4) * cr, .22, true));
      } else spark.forEach((m) => addMachine(m, cx, cz, .14, false));
      rest.forEach((m, i) => {
        const a = (hasCluster ? Math.PI * .6 : Math.PI / 2) + (rest.length === 1 ? 0 : (i / rest.length) * (hasCluster ? Math.PI * 1.72 : TAU));
        addMachine(m, cx + Math.cos(a) * ringR, cz + Math.sin(a) * ringR, .14, false);
      });
    }
    buildFlows(); buildSpikes(); fit();
  }
  function addMachine(m, x, z, y0, inCluster) {
    const name = m.model || ASSET[m.id] || BY_KIND[m.kind] || 'tower_4080';
    const { g, status, size } = instance(name);
    const root = new THREE.Group(); root.position.set(x, y0, z); root.add(g); world.add(root);
    g.traverse((o) => { if (o.isMesh) { o.userData.id = m.id; pickables.push(o); } });
    // 底部光晕（按状态上色）
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: .5 }));
    halo.rotation.x = -Math.PI / 2; halo.position.y = .005; halo.scale.set(Math.max(size.x, size.z) * 2.2, Math.max(size.x, size.z) * 2.2, 1); halo.userData.own = true; root.add(halo);
    const label = document.createElement('div'); label.className = 'tag'; label.dataset.id = m.id;
    const stemEl = document.createElement('i'); stemEl.className = 'tag-stem';   // 引线单独一层：长度变化不让芯片重绘
    if (!inCluster) labels.append(stemEl, label);
    label.addEventListener('pointerenter', () => setHover(m.id)); label.addEventListener('pointerleave', () => setHover(null));
    label.addEventListener('click', (e) => onSelect(pick(e, false) || m.id));   // 标签压在别的机身上时，以机身为准
    root.updateMatrixWorld(true); const box = new THREE.Box3().setFromObject(g);
    nodes.set(m.id, { root, status, halo, label, stemEl, size, inCluster, box, top: new THREE.Vector3(x, y0 + size.y, z), base: new THREE.Vector3(x, y0, z) });
  }

  // 光流：每台一束「光缆」——几十根细丝拧成一股，从机器升起，绕中心螺旋下沉，切向汇入吸积盘（与盘同向旋转）
  const SWIRL = 1.25;
  function flowPath(S, out, samples) {
    const r0 = Math.hypot(S.x, S.z), th0 = Math.atan2(S.z, S.x), rE = HUB_R * .92, h = .32 + r0 * .07;
    for (let k = 0; k <= samples; k++) {
      const t = k / samples, r = rE + (r0 - rE) * Math.pow(1 - t, 1.25), th = th0 + SWIRL * Math.pow(t, 2.4);
      const y = S.y + (DISK_Y + .02 - S.y) * Math.pow(t, 1.4) + h * Math.pow(Math.sin(Math.PI * Math.pow(t, .85)), 1.15);
      out.push(new THREE.Vector3(Math.cos(th) * r, y, Math.sin(th) * r));
    }
    return out;
  }
  const bundleW = (t) => Math.pow(Math.sin(Math.PI * t), .7) * (1 - .55 * t) + .015;
  function buildFlows() {
    const machines = snap.machines || [], pos = [], dirs = [], tint = [], alpha = [], prog = [], mid = [], phs = [];
    const bp = [], btan = [], bside = [], bw = [], bt = [], ba = [], bpr = [], bm = [], bi = [], splashes = [];
    const hubCol = new THREE.Color(0x9dffd8), up = new THREE.Vector3(0, 1, 0);
    particles = []; flowPaths = [];
    const samples = PHONE ? 56 : 92;
    machines.forEach((m, idx) => {
      const n = nodes.get(m.id); if (!n) return;
      const st = statusOf(m), dead = st === 'offline' || st === 'asleep', col = new THREE.Color(STATUS_COLOR[st]);
      const flow = dead ? 0 : clamp(m.flow ?? .3, .08, 1), rnd = mulberry(idx * 977 + 13);
      const S = n.box.getCenter(new THREE.Vector3()); S.y = n.base.y + n.size.y * .6;
      const C = flowPath(S, [], samples), T = [], N = [], B = [];
      for (let k = 0; k <= samples; k++) {
        const tg = C[Math.min(samples, k + 1)].clone().sub(C[Math.max(0, k - 1)]).normalize();
        const nn = new THREE.Vector3().crossVectors(tg, up).normalize(); const bb = new THREE.Vector3().crossVectors(nn, tg).normalize();
        T.push(tg); N.push(nn); B.push(bb);
      }
      const W = (dead ? .04 : .07 + flow * .2) * (st === 'hot' ? 1.25 : 1);
      const strong = st === 'hot' ? 1.55 : st === 'busy' ? 1.2 : st === 'warm' ? 1.3 : 1;
      flowPaths.push({ C, N, B, W, samples });
      const strands = dead ? 5 : Math.round((PHONE ? 22 : 56) * (.55 + flow * .7));
      for (let j = 0; j < strands; j++) {
        const rho = Math.sqrt(rnd()), phi = rnd() * TAU, twist = 2.6 + rnd() * .8, ph = rnd(), hero = j % 9 === 0;
        const a0 = dead ? .03 : (hero ? .14 : .032 + flow * .035) * strong * (1 - rho * .45);
        let prev = null, prevD = null, prevT = 0;
        for (let k = 0; k <= samples; k++) {
          const t = k / samples, psi = phi + twist * t, w = W * bundleW(t) * rho;
          const cs = Math.cos(psi), sn = Math.sin(psi);
          const p = C[k].clone().addScaledVector(N[k], cs * w).addScaledVector(B[k], sn * w);
          const d = N[k].clone().multiplyScalar(-sn).addScaledVector(B[k], cs);
          if (prev) {
            const ta = prevT, tb = t, fa = (tt) => a0 * Math.min(1, tt * 10, (1 - tt) * 4 + .25);
            const ca = col.clone().lerp(hubCol, smoothstep(.62, 1, ta) * .65), cb = col.clone().lerp(hubCol, smoothstep(.62, 1, tb) * .65);
            pos.push(prev.x, prev.y, prev.z, p.x, p.y, p.z); dirs.push(prevD.x, prevD.y, prevD.z, d.x, d.y, d.z);
            tint.push(ca.r, ca.g, ca.b, cb.r, cb.g, cb.b); alpha.push(fa(ta), fa(tb)); prog.push(ta, tb); mid.push(idx, idx); phs.push(ph, ph);
          }
          prev = p; prevD = d; prevT = t;
        }
      }
      // 柔光带：沿中线、朝镜头展开（在着色器里算方向，所以怎么转都正对镜头）
      if (!dead) {
        const off = bp.length / 3;
        for (let k = 0; k <= samples; k++) {
          const t = k / samples, c = C[k], wv = W * .95 * bundleW(t) + .015;
          const fade = Math.min(1, t * 7, (1 - t) * 3 + .35) * (.5 + flow * .5) * strong * .26;
          const cc = col.clone().lerp(hubCol, smoothstep(.6, 1, t) * .6);
          for (const s of [-1, 1]) { bp.push(c.x, c.y, c.z); btan.push(T[k].x, T[k].y, T[k].z); bside.push(s); bw.push(wv); bt.push(cc.r, cc.g, cc.b); ba.push(fade); bpr.push(t); bm.push(idx); }
          if (k < samples) { const i0 = off + k * 2; bi.push(i0, i0 + 1, i0 + 2, i0 + 1, i0 + 3, i0 + 2); }
        }
        splashes.push({ p: C[samples].clone(), col: col.clone().lerp(hubCol, .5), size: .45 + flow * .6 });
        const nSpark = PHONE ? 4 : 10;
        for (let q = 0; q < nSpark; q++) particles.push({ path: flowPaths.length - 1, off: rnd(), speed: .045 + flow * .08 + rnd() * .02, rho: Math.sqrt(rnd()) * .8, phi: rnd() * TAU, col: col.clone().lerp(new THREE.Color(1, 1, 1), .35), size: (q % 3 ? 2.6 : 4.6) * (st === 'hot' ? 1.25 : 1) });
      }
    });
    if (flows) { world.remove(flows); flowGeo.dispose(); }
    flowGeo = new THREE.BufferGeometry();
    flowGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); flowGeo.setAttribute('aDir', new THREE.Float32BufferAttribute(dirs, 3));
    flowGeo.setAttribute('tint', new THREE.Float32BufferAttribute(tint, 3)); flowGeo.setAttribute('alpha', new THREE.Float32BufferAttribute(alpha, 1));
    flowGeo.setAttribute('prog', new THREE.Float32BufferAttribute(prog, 1)); flowGeo.setAttribute('mid', new THREE.Float32BufferAttribute(mid, 1)); flowGeo.setAttribute('aPh', new THREE.Float32BufferAttribute(phs, 1));
    flows = new THREE.LineSegments(flowGeo, flowMat); flows.frustumCulled = false; flows.renderOrder = 3; world.add(flows);
    if (beams) { world.remove(beams); beams.geometry.dispose(); }
    { const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(bp, 3)); g.setAttribute('aTan', new THREE.Float32BufferAttribute(btan, 3));
      g.setAttribute('aSide', new THREE.Float32BufferAttribute(bside, 1)); g.setAttribute('aW', new THREE.Float32BufferAttribute(bw, 1));
      g.setAttribute('tint', new THREE.Float32BufferAttribute(bt, 3)); g.setAttribute('alpha', new THREE.Float32BufferAttribute(ba, 1));
      g.setAttribute('prog', new THREE.Float32BufferAttribute(bpr, 1)); g.setAttribute('mid', new THREE.Float32BufferAttribute(bm, 1)); g.setIndex(bi);
      beams = new THREE.Mesh(g, beamMat); beams.frustumCulled = false; beams.renderOrder = 2; world.add(beams); }
    for (const s of splashSprites) world.remove(s); splashSprites = [];
    for (const s of splashes) { const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: splashMat.map, color: s.col, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: .8 })); sp.position.copy(s.p); sp.scale.setScalar(s.size); world.add(sp); splashSprites.push(sp); }
    if (dots) { world.remove(dots); dotGeo.dispose(); }
    dotGeo = new THREE.BufferGeometry();
    dotGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(particles.length * 3), 3));
    dotGeo.setAttribute('tint', new THREE.Float32BufferAttribute(particles.flatMap((p) => [p.col.r, p.col.g, p.col.b]), 3));
    dotGeo.setAttribute('size', new THREE.Float32BufferAttribute(particles.map((p) => p.size), 1));
    dots = new THREE.Points(dotGeo, dotMat); dots.frustumCulled = false; dots.renderOrder = 4; world.add(dots);
  }
  // 光点沿光缆跑：在预先算好的中线 / 法向上插值
  const sp0 = new THREE.Vector3();
  function sparkAt(p, t, out) {
    const fp = flowPaths[p.path]; if (!fp) return out.set(0, -10, 0);
    const x = t * fp.samples, k = Math.min(fp.samples - 1, Math.floor(x)), u = x - k;
    out.lerpVectors(fp.C[k], fp.C[k + 1], u);
    const w = fp.W * bundleW(t) * p.rho, psi = p.phi + 2.8 * t;
    sp0.copy(fp.N[k]).multiplyScalar(Math.cos(psi) * w).addScaledVector(fp.B[k], Math.sin(psi) * w);
    return out.add(sp0);
  }
  // 中央尖刺环：每台机器一段弧，40 根径向刻线，长度 = 最近 45 分钟温度
  function buildSpikes() {
    const machines = snap.machines || [], pos = [], col = [];
    const seg = TAU / Math.max(1, machines.length), per = small() ? 9 : 18, R0 = HUB_R + .26;
    machines.forEach((m, i) => {
      const hist = (m.temp_hist?.length ? m.temp_hist : [m.temp_c ?? 30]).filter((v) => v != null);
      const st = statusOf(m), c = new THREE.Color(STATUS_COLOR[st]).multiplyScalar(st === 'offline' || st === 'asleep' ? .4 : 1);
      for (let j = 0; j < per; j++) {
        const a = i * seg + (j + .5) / per * seg * .88, temp = hist[Math.min(hist.length - 1, Math.floor(j / per * hist.length))] ?? 30;
        const len = .03 + clamp((temp - 25) / 70, 0, 1) * .48;
        pos.push(Math.cos(a) * R0, .17, Math.sin(a) * R0, Math.cos(a) * (R0 + len), .17, Math.sin(a) * (R0 + len));
        col.push(c.r, c.g, c.b, c.r * .4, c.g * .4, c.b * .4);
      }
    });
    for (let k = 0; k < 360; k++) { const a = k / 360 * TAU, r1 = R0 + .78, r2 = r1 + (k % 10 ? .025 : .07); pos.push(Math.cos(a) * r1, .17, Math.sin(a) * r1, Math.cos(a) * r2, .17, Math.sin(a) * r2); col.push(.25, .35, .4, .25, .35, .4); }
    if (spikeRing) { hub.remove(spikeRing); spikeRing.geometry.dispose(); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    spikeRing = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: .9, blending: THREE.AdditiveBlending, depthWrite: false }));
    hub.add(spikeRing);
  }

  // ---------- 数据刷新 ----------
  let flowKey = '', spikeKey = '';
  function refresh() {
    const machines = snap.machines || [];
    const running = new Map();
    for (const c of snap.local_ai || []) for (const x of c.models || []) if (x.state === 'running') {
      const ids = c.slot === 'spark' ? machines.filter((m) => m.kind === 'gb10').map((m) => m.id) : [c.machine];
      for (const id of ids) { if (!running.has(id)) running.set(id, []); running.get(id).push(x.name); }
    }
    for (const m of machines) {
      const n = nodes.get(m.id); if (!n) continue;
      const st = statusOf(m), col = new THREE.Color(STATUS_COLOR[st]), dead = st === 'offline' || st === 'asleep', hot = hovered === m.id || selected === m.id;
      for (const mt of n.status) { mt.emissive.copy(col); mt.emissiveIntensity = dead ? .3 : hot ? 9 : 5; mt.color.copy(col); }
      n.halo.material.color.copy(col); n.halo.material.opacity = dead ? .08 : selected === m.id ? .32 : hot ? .9 : .45;
      const temp = dead ? '—' : num(m.temp_c), run = running.get(m.id);
      n.st = st;
      const cls = `tag is-${st}${hot ? ' is-hover' : ''}${selected === m.id ? ' is-selected' : ''}${n.vis === false ? ' is-crowded' : ''}${n.label.classList.contains('is-under') ? ' is-under' : ''}`;
      if (n.label.className !== cls) { n.label.className = cls; n.dirty = true; }
      const scls = `tag-stem is-${st}${n.vis === false ? ' is-crowded' : ''}${n.off ? ' is-off' : ''}`; if (n.stemEl.className !== scls) n.stemEl.className = scls;
      setHTML(n, n.label, `<i class="tg-dot"></i><span class="tg-name">${esc(m.name)}</span><b class="tg-t">${temp}${temp === '—' ? '' : '<small>°</small>'}</b>${run?.length ? `<span class="tg-run">${esc(run.slice(0, 2).join(' · '))}</span>` : ''}`);
    }
    for (const c of clusters) {
      const ms = machines.filter((m) => c.members.includes(m.id));
      const worst = ms.reduce((a, m) => (rank(statusOf(m)) > rank(statusOf(a)) ? m : a), ms[0]);
      const st = statusOf(worst);
      c.ring.material.color.set(st === 'normal' ? STATUS_COLOR.busy : STATUS_COLOR[st]);
      const card = (snap.local_ai || []).find((x) => x.slot === 'spark'), mode = (card?.models || []).find((x) => x.state === 'running');
      const switching = (card?.models || []).some((x) => x.id === '_switching');
      c.label.className = `tag-cluster is-${st}${c.vis === false ? ' is-crowded' : ''}${c.label.classList.contains('is-under') ? ' is-under' : ''}`;
      setHTML(c, c.label, `<span class="tag-k">SPARK ×${ms.length}</span><b>${esc(switching ? '正在切档…' : mode ? mode.name : '档位未知')}</b><span>${num(Math.max(...ms.map((m) => m.temp_c ?? 0)))}°</span>`);
    }
    for (const i of islands) {
      const on = i.members.filter((m) => (machines.find((x) => x.id === m.id) || m).online).length;
      setHTML(i, i.label, `${esc(i.site.name)}<em>${on}/${i.members.length}</em>`);
    }
    const h = snap.hub || {};
    setHTML(hubBox, hubTag, `<span class="hub-k">${esc(h.name || '本机')} · 中心</span><b>${num(h.cpu_pct)}<i>%</i></b><span>CPU · 内存 ${num(h.mem_pct)}%</span>`);
    // 状态或流量变化明显才重建光流
    // 状态或流量变化明显才重建光流；温度历史变了只重画尖刺环
    const k = machines.map((m) => `${statusOf(m)}${Math.round((m.flow ?? 0) * 5)}`).join('|');
    if (k !== flowKey) { flowKey = k; buildFlows(); }
    const k2 = machines.map((m) => `${statusOf(m)}${(m.temp_hist || []).length}${Math.round(m.temp_c ?? 0)}`).join('|');
    if (k2 !== spikeKey) { spikeKey = k2; buildSpikes(); }
    const on = machines.filter((m) => m.online !== false);
    snapLoad = on.length ? on.reduce((a, m) => a + Math.max(m.gpu_pct ?? 0, m.cpu_pct ?? 0), 0) / on.length / 100 : .3;
  }

  // ---------- 镜头：全景按留白区域取景；可 360° 转、俯仰、缩放、平移；对准一台时按它的包围盒放大 ----------
  let width = 1, height = 1, insets = { t: 0, r: 0, b: 0, l: 0 };
  const base = { bw: 16, bh: 10, cw: new THREE.Vector3(), dA: 0, dB: 0 };
  function basisAt(az, el) {
    const d = new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), d).normalize();
    return { d, right, up: new THREE.Vector3().crossVectors(d, right).normalize() };
  }
  const basis = () => basisAt(AZ0 + view.yaw + view.auto, EL0 + clampPitch(view.pitch));
  function measure() {
    // 取景尺寸按默认角度量一次，转动时不跟着变，避免「呼吸」
    const { right, up } = basisAt(AZ0, EL0), pts = [];
    const add = (x, y, z) => pts.push(new THREE.Vector3(x, y, z));
    for (const i of islands) { const p = i.group.position; for (let k = 0; k < 16; k++) { const a = k / 16 * TAU; add(p.x + Math.cos(a) * i.r, 0, p.z + Math.sin(a) * i.r); } add(p.x, -.8, p.z + i.r + .2); }
    for (const n of nodes.values()) add(n.top.x, n.top.y + 1.1, n.top.z);
    for (let k = 0; k < 12; k++) { const a = k / 12 * TAU; add(Math.cos(a) * (HUB_R + 1.1), 0, Math.sin(a) * (HUB_R + 1.1)); } add(0, 3, 0);
    if (!pts.length) return;
    let a0 = 1e9, a1 = -1e9, b0 = 1e9, b1 = -1e9; const wb = new THREE.Box3();
    for (const p of pts) { const a = p.dot(right), b = p.dot(up); a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b); wb.expandByPoint(p); }
    wb.getCenter(base.cw); base.cw.y = 0;
    base.bw = a1 - a0; base.bh = b1 - b0; base.dA = (a0 + a1) / 2 - base.cw.dot(right); base.dB = (b0 + b1) / 2 - base.cw.dot(up);
  }
  const corner = new THREE.Vector3(), camDirV = new THREE.Vector3();
  let lastS = .01;
  function applyCamera() {
    const { d, right, up } = basis();
    const availW = Math.max(80, width - insets.l - insets.r), availH = Math.max(80, height - insets.t - insets.b);
    let s = Math.max(base.bw / availW, base.bh / availH) * 1.04 / view.zoom;
    const fc = 1 - view.cen;
    let cA = (base.cw.dot(right) + base.dA) * fc + view.panA, cB = (base.cw.dot(up) + base.dB) * fc + view.panB;
    if (view.f > .001) {
      const { min, max } = view.box; let a0 = 1e9, a1 = -1e9, b0 = 1e9, b1 = -1e9;
      for (let i = 0; i < 8; i++) {
        corner.set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z);
        const a = corner.dot(right), b = corner.dot(up); a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b);
      }
      const fill = PHONE ? .8 : .62, k = view.f;
      const s1 = Math.max((a1 - a0) / (availW * fill), (b1 - b0) / (availH * fill)) / view.dz;
      s = Math.exp(Math.log(s) * (1 - k) + Math.log(s1) * k);
      cA += ((a0 + a1) / 2 - cA) * k; cB += ((b0 + b1) / 2 - cB) * k;
    }
    lastS = s;
    const midX = insets.l + availW / 2, midY = insets.t + availH / 2;
    const left = cA - midX * s, top = cB + midY * s;
    camera.left = left; camera.right = left + width * s; camera.top = top; camera.bottom = top - height * s;
    camera.position.copy(d).multiplyScalar(80); camera.up.copy(up); camera.lookAt(0, 0, 0); camera.updateProjectionMatrix();
    camDirV.copy(d).negate();
  }
  function fit() { measure(); applyCamera(); }
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const TW = ['zoom', 'dz', 'f', 'yaw', 'pitch', 'panA', 'panB', 'cen'];
  function flyTo(to = {}, ms = 1000) {
    if (to.box && view.f < .01) view.box.copy(to.box);
    const from = {}; for (const k of TW) from[k] = view[k];
    const dest = {}; for (const k of TW) dest[k] = k in to ? to[k] : view[k];
    vel.yaw = vel.pitch = 0;
    tween = { start: performance.now(), ms, from, to: dest, keys: TW.slice(), b0: view.box.clone(), b1: (to.box || view.box).clone() };
  }
  // 用户一动手，就把这几项从动画里拿出来交给手（其余比如推近 f 照样走完）
  function releaseTween(keys) { if (tween) tween.keys = tween.keys.filter((k) => !keys.includes(k)); }
  function foldAuto() { const d = goal.yaw - view.yaw; view.yaw = wrap(view.yaw + view.auto); goal.yaw = view.yaw + d; view.auto = 0; }
  const isDefaultView = () => Math.abs(wrap(view.yaw)) < .02 && Math.abs(view.pitch) < .02 && Math.abs(view.zoom - 1) < .02 && Math.abs(view.panA) + Math.abs(view.panB) < .05;
  function resetView(ms = 900) { foldAuto(); goal.yaw = view.yaw = wrap(view.yaw); flyTo({ yaw: 0, pitch: 0, zoom: 1, panA: 0, panB: 0, dz: 1 }, ms); }
  let mode = 'status', yawKeep = 0, pitchKeep = 0;

  // ---------- 标签：位置按设备像素取整（转动时文字不再落在不同亚像素上闪烁）；实底芯片 + 引线；互相避让 ----------
  const v = new THREE.Vector3();
  const snapPx = (x) => { const d = Math.min(devicePixelRatio || 1, 3); return Math.round(x * d) / d; };
  const STEM0 = PHONE ? 8 : 12, GAP = 5;
  const toScreen = (p) => { v.copy(p).project(camera); return { x: (v.x * .5 + .5) * width, y: (-v.y * .5 + .5) * height, z: v.z }; };
  const sizeOf = (o, el) => { if (o.dirty !== false) { o.w = el.offsetWidth; o.h = el.offsetHeight; o.dirty = false; } };
  const put = (el, x, y, o) => { const X = snapPx(x), Y = snapPx(y); if (o.X !== X || o.Y !== Y) { o.X = X; o.Y = Y; el.style.transform = `translate3d(${X}px,${Y}px,0)`; } };
  const hit = (a, list) => list.some((b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y);
  const hubAnchor = new THREE.Vector3(0, 3.05, 0), clAnchor = new THREE.Vector3(), cor = new THREE.Vector3();
  function markLabels() { hubBox.dirty = true; for (const n of nodes.values()) n.dirty = true; for (const c of clusters) c.dirty = true; for (const i of islands) i.dirty = true; hudT = 0; }
  // 页面上的固定界面（顶栏、读数、右栏、图例、复位按钮）：标签不压上去
  const AVOID = '.bar, .kpis, .rail, .legend, #view-reset';
  let hud = [], hudT = 0;
  function readHud() {
    const hr = host.getBoundingClientRect(); hud = [];
    for (const el of document.querySelectorAll(AVOID)) {
      if (el.hidden || getComputedStyle(el).visibility === 'hidden') continue;
      const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue;
      const x = r.left - hr.left, y = r.top - hr.top;
      if (x < width && y < height && x + r.width > 0 && y + r.height > 0) hud.push({ x: x - 4, y: y - 4, w: r.width + 8, h: r.height + 8 });
    }
  }
  const M = 6;   // 离画面边的最小距离
  const inView = (x, w, lim) => clamp(x, M, Math.max(M, lim - w - M));
  // 机身在屏幕上的外框（标签别盖住别的机器）
  function bodyRect(n) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; const { min, max } = n.box;
    for (let k = 0; k < 8; k++) {
      cor.set(k & 1 ? max.x : min.x, k & 2 ? max.y : min.y, k & 4 ? max.z : min.z).project(camera);
      const x = (cor.x * .5 + .5) * width, y = (-cor.y * .5 + .5) * height;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  // 显隐带迟滞：放不下立刻隐去（宁缺不叠），要连续几帧都放得下才重新显示，转动时不来回闪
  function settle(o, el, want, instant) {
    if (o.vis === undefined) o.vis = true;
    if (want !== o.vis) { o.crowd = (o.crowd || 0) + 1; if (instant || o.crowd > (want ? 4 : 0)) { o.vis = want; o.crowd = 0; el.classList.toggle('is-crowded', !want); o.stemEl?.classList.toggle('is-crowded', !want); } } else o.crowd = 0;
  }
  function placeLabels(instant, dt = 1 / 60) {
    if (hudT-- <= 0) { readHud(); hudT = 30; }
    const chips = hud.slice();
    // 固定件先放：中心读数、Spark 组牌（贴在组台前沿）、站点名。锚点出了画面就隐去；压到界面或别的牌子就上下挪一格，挪不开先隐去
    const fixedTag = (o, el, p, offs) => {
      let got = null;
      if (o.w && p.x > 0 && p.x < width && p.y > 0 && p.y < height) for (const dy of offs) {
        const x = inView(p.x - o.w / 2, o.w, width), y = p.y + dy;
        if (y < M || y + o.h > height - M) continue;
        const q = { x: x - 2, y: y - 2, w: o.w + 4, h: o.h + 4 };
        if (!hit(q, chips)) { got = { x, y, q }; break; }
      }
      settle(o, el, !!got, instant);
      if (got) { chips.push(got.q); put(el, got.x, got.y, o); }
    };
    sizeOf(hubBox, hubTag); fixedTag(hubBox, hubTag, toScreen(hubAnchor), [-hubBox.h]);
    for (const c of clusters) { sizeOf(c, c.label); clAnchor.copy(c.center); clAnchor.y = .2; clAnchor.z += 1.62; fixedTag(c, c.label, toScreen(clAnchor), PHONE ? [12, 16 + c.h] : [4, 8 + c.h, -4 - c.h]); }
    for (const i of islands) { sizeOf(i, i.label); fixedTag(i, i.label, toScreen(i.anchor), [0, 4 + i.h, -4 - i.h]); }
    // 机器标签：选中 > 悬停 > 状态严重度 > 离镜头近。先找既不压别的标签 / 引线、也不盖别的机身的那一层（最多五层，引线随之拉长）；
    // 找不到就退一步只避开标签和引线；还不行先隐去（有迟滞，不来回闪）。芯片不出画面，引线仍指着机器顶。
    const bodies = new Map();
    for (const [id, n] of nodes) bodies.set(id, bodyRect(n));
    const cand = [];
    for (const [id, n] of nodes) {
      if (n.inCluster) continue;
      sizeOf(n, n.label); const off = !n.w; if (n.off !== off) { n.off = off; n.stemEl.classList.toggle('is-off', off); } if (off) continue;
      v.copy(n.top); v.y += .04; const p = toScreen(v);
      cand.push({ id, n, p, pr: id === selected ? -9 : -rank(n.st || 'normal') });   // 悬停不改排布：否则挤开的名牌落到鼠标下，两块来回抢位置
    }
    cand.sort((a, b) => a.pr - b.pr || a.p.z - b.p.z);
    const stems = [], drawn = [];
    cand.forEach(({ id, n, p }, k) => {
      const others = []; for (const [j, r] of bodies) if (j !== id) others.push(r);
      const onScreen = p.x > -10 && p.x < width + 10 && p.y > 20 && p.y < height + 10;
      const x = inView(p.x - n.w / 2, n.w, width);
      const at = (L) => { const st = STEM0 + L * (n.h + GAP), y = p.y - st - n.h; return y < M ? null : { L, q: { x: x - 3, y: y - 3, w: n.w + 6, h: n.h + 6 }, sr: { x: p.x - 2, y: y + n.h, w: 4, h: st } }; };
      let got = null;
      for (let pass = 0; pass < 2 && !got && onScreen; pass++) {
        const obs = pass ? chips.concat(stems) : chips.concat(stems, others);
        const ok = (r) => r && !hit(r.q, obs) && !hit(r.sr, chips);
        let low = null; for (let L = 0; L < 5 && !low; L++) { const r = at(L); if (!r) break; if (ok(r)) low = r; }
        if (!low) continue;
        // 已经抬高的标签，那一层还空着就先待着，连续空出 0.4 秒再落回去：转动时不上下乱跳
        const cur = n.lvl > low.L ? at(n.lvl) : null;
        if (cur && ok(cur) && (n.downT = (n.downT || 0) + dt) < .4) got = cur; else { got = low; n.downT = 0; }
      }
      const target = STEM0 + (got ? got.L : n.lvl || 0) * (n.h + GAP);
      n.stemV = instant || n.stemV == null ? target : n.stemV + (target - n.stemV) * (1 - Math.exp(-dt * 20));
      // 引线还在缓动时，画出来的位置可能压着别的牌子：这一帧先隐去，等落定再显示
      const dr = { x: x - 2, y: p.y - n.stemV - n.h - 2, w: n.w + 4, h: n.h + 4 };
      if (got && hit(dr, drawn)) got = null;
      settle(n, n.label, !!got, instant);
      if (got) { chips.push(got.q); stems.push(got.sr); n.lvl = got.L; drawn.push(dr); }
      put(n.label, x, p.y - n.stemV - n.h, n);
      const sl = Math.max(0, Math.round(n.stemV)); if (sl !== n.stem) { n.stem = sl; n.stemEl.style.height = `${sl}px`; }
      put(n.stemEl, p.x - 3.5, p.y - n.stemV, n.sp || (n.sp = {}));
      const zi = 10 + cand.length - k; if (n.zi !== zi) { n.zi = zi; n.label.style.zIndex = zi; }
    });
  }
  document.fonts?.ready.then(() => markLabels());

  // ---------- 交互：单指 / 左键拖 = 360° 转与俯仰；双指 = 缩放 + 平移；滚轮 = 以光标为中心缩放；右键或 Shift 拖 = 平移；双击 = 复位 ----------
  const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
  function setHover(id) { if (hovered === id) return; hovered = id; refresh(); onHover(id); host.style.cursor = id ? 'pointer' : ''; flowMat.uniforms.sel.value = beamMat.uniforms.sel.value = id ? (snap.machines || []).findIndex((m) => m.id === id) : -1; }
  const pv = new THREE.Vector3();
  function pick(e, near = true) {
    const r = renderer.domElement.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    mouse.set((px / r.width) * 2 - 1, -(py / r.height) * 2 + 1);
    ray.setFromCamera(mouse, camera);
    const under = new Set(ray.intersectObjects(pickables, false).map((h) => h.object.userData.id));
    // 手指下若压着好几台（前一台挡住后一台的边），取中心离手指最近的那台；没压着就找附近的（手机容差 44px，电脑 18px）
    if (!under.size && !near) return null;
    let best = null, bd = under.size ? Infinity : (e.pointerType === 'touch' || PHONE ? 44 : 18) ** 2;
    for (const [id, n] of nodes) {
      if (under.size && !under.has(id)) continue;
      n.box.getCenter(pv).project(camera);
      const dx = (pv.x * .5 + .5) * r.width - px, dy = (-pv.y * .5 + .5) * r.height - py, d2 = dx * dx + dy * dy;
      if (d2 < bd) { bd = d2; best = id; }
    }
    return best;
  }
  const cv = renderer.domElement;
  const ptrs = new Map();
  let moveRaf = 0, dragging = false, down = null, pinch = null, lastMoveT = 0;
  function rotateBy(dx, dy) {
    goal.yaw -= dx * .0068; goal.pitch = clampPitch(goal.pitch + dy * .0052);
    const now = performance.now(), dtm = clamp(now - lastMoveT, 8, 100); lastMoveT = now;
    vel.yaw = vel.yaw * .4 - dx * .0068 * 600 / dtm; vel.pitch = vel.pitch * .4 + dy * .0052 * 600 / dtm;
  }
  function panBy(dx, dy) { goal.panA -= dx * lastS; goal.panB += dy * lastS; }
  function zoomAt(cx, cy, k) {
    releaseTween(['zoom', 'dz', 'panA', 'panB']);
    if (selected) { goal.dz = clamp(goal.dz * k, .55, 3.2); return; }
    const s0 = lastS * view.zoom / goal.zoom, z0 = goal.zoom; goal.zoom = clamp(goal.zoom * k, .5, 8); const s1 = s0 * z0 / goal.zoom;
    const r = cv.getBoundingClientRect(), availW = Math.max(80, width - insets.l - insets.r), availH = Math.max(80, height - insets.t - insets.b);
    const midX = insets.l + availW / 2, midY = insets.t + availH / 2;
    goal.panA += (cx - r.left - midX) * (s0 - s1); goal.panB -= (cy - r.top - midY) * (s0 - s1);
  }
  const pinchState = () => { const [a, b] = [...ptrs.values()]; return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };
  cv.addEventListener('pointerdown', (e) => {
    try { cv.setPointerCapture(e.pointerId); } catch {}
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    vel.yaw = vel.pitch = 0;
    if (ptrs.size === 1) { down = { x: e.clientX, y: e.clientY, moved: false, pan: e.button === 2 || e.shiftKey || e.ctrlKey || e.metaKey }; lastMoveT = performance.now(); }
    else { if (down) down.moved = true; dragging = true; pinch = pinchState(); }
  });
  cv.addEventListener('pointermove', (e) => {
    const p = ptrs.get(e.pointerId);
    if (!p) {   // 鼠标悬停
      if (e.pointerType === 'touch' || moveRaf) return;
      moveRaf = requestAnimationFrame(() => { moveRaf = 0; setHover(pick(e)); }); return;
    }
    const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
    if (ptrs.size >= 2 && pinch) {
      const q = pinchState();
      if (pinch.d > 10 && q.d > 10) zoomAt(q.x, q.y, q.d / pinch.d);
      if (!selected) { releaseTween(['panA', 'panB']); panBy(q.x - pinch.x, q.y - pinch.y); }
      pinch = q; return;
    }
    if (!down) return;
    if (!down.moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 7) {
      down.moved = true; dragging = true; foldAuto(); autoTurn = false; releaseTween(['yaw', 'pitch', 'panA', 'panB']); host.style.cursor = 'grabbing'; if (hovered) setHover(null);
    }
    if (!down.moved) return;
    if (down.pan && !selected) panBy(dx, dy); else rotateBy(dx, dy);
  });
  const release = (e) => {
    ptrs.delete(e.pointerId);
    if (ptrs.size === 1) { const [q] = ptrs.values(); pinch = null; down = { x: q.x, y: q.y, moved: true, pan: false }; }
    if (ptrs.size === 0) { dragging = false; pinch = null; if (performance.now() - lastMoveT > 90) vel.yaw = vel.pitch = 0; host.style.cursor = ''; }
  };
  cv.addEventListener('pointerup', release); cv.addEventListener('pointercancel', (e) => { release(e); down = null; });
  cv.addEventListener('pointerleave', () => { if (!dragging) setHover(null); });
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  cv.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, Math.exp(-clamp(e.deltaY, -120, 120) * .0016)); }, { passive: false });
  cv.addEventListener('dblclick', (e) => { if (!pick(e, false) && !selected) resetView(); });
  cv.addEventListener('click', (e) => {
    const wasDrag = down?.moved; down = null; if (wasDrag) return;
    const id = pick(e);
    if (id) onSelect(id); else if (selected) onEmpty();
  });

  // ---------- 后期 ----------
  let composer = null, bloom = null;
  // 画质档 [后期链像素密度, 多重采样]：2 倍屏原生 2× + 4× 采样在 M3 Pro 上一帧 30ms+（旋转一抽一抽），
  // 按实测帧时间自动降档（只降不升，免得来回切）；?q=N 钉死某一档
  const DPR0 = Math.min(devicePixelRatio || 1, 2);
  // 高分屏（≥1.75×）像素已经够细，不做多重采样（M3 Pro 上这一项就占掉一半帧时间）；1 倍屏保留 4× 防闪
  const QQ = (DPR0 >= 1.75 ? [[DPR0, 0], [1.5, 0], [1.25, 0], [1, 0]] : [[DPR0, 4], [DPR0, 2], [DPR0, 0], [Math.min(DPR0, 1), 0]])
    .filter((q, i, a) => !a.slice(0, i).some((x) => x[0] === q[0] && x[1] === q[1]));
  const qParam = new URLSearchParams(location.search).get('q');
  let qi = qParam != null ? clamp(+qParam | 0, 0, QQ.length - 1) : 0, qEma = 0, qBad = 0;
  function setupComposer() {
    if (composer) { composer.renderTarget1.dispose(); composer.renderTarget2.dispose(); bloom?.dispose?.(); composer = null; bloom = null; }
    if (!rich || small() || /[?&]nopost/.test(location.search)) { composer = null; pxU.value = DPR0; return; }
    const ov = new URLSearchParams(location.search), pr = ov.has('pr') ? +ov.get('pr') : QQ[qi][0], samples = ov.has('ms') ? +ov.get('ms') : QQ[qi][1];   // ?pr= ?ms= 调试用
    // 多重采样的渲染目标：后期链不丢抗锯齿（1 倍屏上细节边缘会闪）
    composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, samples }));
    composer.setPixelRatio(pr); pxU.value = pr;
    composer.addPass(new RenderPass(scene, camera));
    bloom = new UnrealBloomPass(new THREE.Vector2(host.clientWidth, host.clientHeight), .5, .45, .72);
    // 辉光本来就是糊的：在半分辨率上算，看不出差别，省掉大半耗时
    const bs = +(new URLSearchParams(location.search).get('bs') || .5), bSet = bloom.setSize.bind(bloom); bloom.setSize = (w, h) => bSet(Math.max(2, w * bs), Math.max(2, h * bs));
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
    if (width > 1) composer.setSize(width, height);
    host.dataset.quality = String(qi);
  }
  function governQuality(rawMs, t) {
    if (!composer || qParam != null || fixed || t < 4 || qi >= QQ.length - 1) return;
    qEma = qEma ? qEma * .9 + rawMs * .1 : rawMs;
    if (qEma > 19.5) { if (++qBad > 40) { qi++; qBad = 0; qEma = 0; setupComposer(); } } else qBad = 0;
  }

  // 调试：?hide=disk,dust,jet,core,photon,flows,beams,dots,splash 逐项隐藏，排查画面问题
  const HIDE = (new URLSearchParams(location.search).get('hide') || '').split(',');
  const hideObj = { disk, dust, jet, core: coreBall, photon, lens, glow: coreGlow, glow2: coreGlow2, jetcore: jetCore, halo, plinth };
  for (const k of HIDE) if (hideObj[k]) hideObj[k].visible = false;
  const hideLate = () => { if (flows) flows.visible = !HIDE.includes('flows'); if (beams) beams.visible = !HIDE.includes('beams'); if (dots) dots.visible = !HIDE.includes('dots'); splashSprites.forEach((x) => (x.visible = !HIDE.includes('splash'))); if (spikeRing) spikeRing.visible = !HIDE.includes('spikes'); };
  // ---------- 循环 ----------
  let disposed = false, t0 = performance.now(), dimT = 1, dimV = 1, lastT = 0, lastNow = performance.now(), wasDefault = true, loadV = .4;
  const fixed = /[?&]export/.test(location.search) || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const tmp = new THREE.Vector3();
  function frame(now) {
    const rawMs = now - lastNow, t = (now - t0) / 1000, dt = Math.min(.05, Math.max(0, rawMs / 1000)); lastNow = now; lastT = t;
    if (!document.hidden) governQuality(rawMs, t);
    if (tween) {
      const T = tween, k = ease(clamp((now - T.start) / T.ms, 0, 1));
      for (const key of T.keys) { view[key] = T.from[key] + (T.to[key] - T.from[key]) * k; if (key in goal) goal[key] = view[key]; }
      view.box.min.lerpVectors(T.b0.min, T.b1.min, k); view.box.max.lerpVectors(T.b0.max, T.b1.max, k);
      if (k >= 1) tween = null;
    }
    if (itw) { const k = ease(clamp((now - itw.start) / itw.ms, 0, 1)); for (const key in itw.to) insets[key] = itw.from[key] + (itw.to[key] - itw.from[key]) * k; if (k >= 1) itw = null; }
    // 松手后的惯性（作用在目标上）
    if ((!tween || !tween.keys.includes('yaw')) && !dragging && (Math.abs(vel.yaw) > 1e-4 || Math.abs(vel.pitch) > 1e-4)) {
      goal.yaw += vel.yaw * dt; goal.pitch = clampPitch(goal.pitch + vel.pitch * dt); const dk = Math.exp(-dt * 4.5); vel.yaw *= dk; vel.pitch *= dk;
    }
    if (mode === 'models' && !fixed && !dragging) goal.yaw += dt * .05;   // 模型页背景：星云慢慢转
    // 镜头平滑跟随目标（时间常数约 60ms；缩放按比例插值）
    const kf = fixed ? 1 : 1 - Math.exp(-dt * 16);
    for (const key of SMK) if (!tween || !tween.keys.includes(key)) view[key] = key === 'zoom' || key === 'dz' ? view[key] * Math.pow(goal[key] / view[key], kf) : view[key] + (goal[key] - view[key]) * kf;
    // 详情里的自动转台：左右各摆约 24°，一拖动就交给手
    view.auto = autoTurn && selected && !fixed && !dragging ? Math.sin((t - focusT0) * .42) * .42 * view.f : 0;
    applyCamera();
    const tt = fixed ? 2.4 : t;
    flowMat.uniforms.time.value = tt; beamMat.uniforms.time.value = tt; beamMat.uniforms.camDir.value.copy(camDirV);
    loadV += (snapLoad - loadV) * .02; core.spin.value = .35 + loadV * .9; core.time.value = tt;
    dimV += (dimT - dimV) * (fixed ? 1 : .08);
    beamMat.uniforms.dim.value = dimV; flowMat.uniforms.dim.value = .4 + dimV * .6; dotMat.uniforms.dim.value = .3 + dimV * .7; core.dim.value = .45 + dimV * .55;
    splashSprites.forEach((s, i) => { s.material.opacity = (.55 + Math.sin(tt * 3 + i) * .3) * dimV; });
    photon.material.opacity = .82 + Math.sin(tt * 2.1) * .14; lens.material.rotation = tt * .12; coreGlow.material.opacity = (.22 + Math.sin(tt * 1.3) * .05) * (.5 + dimV * .5);
    halo.children.forEach((r, i) => { r.rotation.z = tt * (.35 + i * .2) * (i % 2 ? -1 : 1); });
    for (const c of clusters) c.ring.material.opacity = (.65 + Math.sin(tt * 2.4) * .25) * (.25 + dimV * .75);
    if (bloom) { bloom.strength = .5 - view.f * .3; bloom.threshold = .72 + view.f * .12; }
    if (dotGeo) { const a = dotGeo.attributes.position; particles.forEach((p, i) => { sparkAt(p, (tt * p.speed + p.off) % 1, tmp); a.setXYZ(i, tmp.x, tmp.y, tmp.z); }); a.needsUpdate = true; }
    if (HIDE.length > 1 || HIDE[0]) hideLate();
    placeLabels(fixed, dt);
    if (composer) composer.render(); else renderer.render(scene, camera);
    host.dataset.ready = '1';
    const def = isDefaultView(); if (def !== wasDefault) { wasDefault = def; onViewChange(!def); }
  }
  function loopOn() { renderer.setAnimationLoop(!disposed && !document.hidden && !fixed ? frame : null); if (fixed) frame(performance.now()); }
  function resize() {
    const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight);
    if (w === width && h === height) return;
    width = w; height = h;
    renderer.setSize(width, height, false); if (composer) composer.setSize(width, height);
    markLabels(); fit(); if (!disposed) frame(performance.now());   // 改尺寸会清画布，立刻补一帧，免得闪黑
  }
  setupComposer();
  const ro = new ResizeObserver(resize); ro.observe(host);
  document.addEventListener('visibilitychange', loopOn);
  resize(); loopOn();

  return {
    software,
    update(next) {
      snap = next || {};
      const machines = snap.machines || [];
      const key = JSON.stringify([machines.map((m) => [m.id, m.site, m.kind]), (snap.sites || []).map((s) => s.id)]);
      if (key !== layoutKey) { layoutKey = key; layout(machines, snap.sites || []); flowKey = ''; }
      refresh(); if (fixed) frame(performance.now());
    },
    setView(next) {
      mode = next; foldAuto(); selected = null; autoTurn = false; dimT = 1; labels.classList.remove('is-focus'); refresh();
      if (next === 'models') { yawKeep = view.yaw; pitchKeep = view.pitch; flyTo({ f: 0, dz: 1, cen: 1, zoom: 2.3, panA: 0, panB: 0, pitch: .12 }, 1300); }   // 模型页：镜头推到宇宙中心当背景
      else { goal.yaw = view.yaw = yawKeep + wrap(view.yaw - yawKeep); flyTo({ f: 0, dz: 1, cen: 0, zoom: 1, panA: 0, panB: 0, yaw: yawKeep, pitch: pitchKeep }, 1100); }
    },
    focus(id) {
      const n = id ? nodes.get(id) : null;
      if ((n ? id : null) === selected) return;            // 数据刷新会反复调用，同一台不重飞
      foldAuto(); selected = n ? id : null; refresh(); dimT = n ? .18 : 1;
      labels.classList.toggle('is-focus', !!n);
      if (n) { autoTurn = true; focusT0 = lastT; flyTo({ f: 1, box: n.box }, view.f > .5 ? 850 : 1100); }
      else { autoTurn = false; flyTo({ f: 0, dz: 1 }, 900); }
    },
    resetView() { resetView(); },
    setInsets(next, ms = 0) {
      const to = { ...insets, ...next };
      if (!ms || fixed) { insets = to; itw = null; applyCamera(); if (fixed) frame(performance.now()); return; }
      itw = { from: { ...insets }, to, start: performance.now(), ms };
    },
    resize,
    screenOf(id) {   // 验收用：某台机器中心在页面上的坐标
      const n = nodes.get(id); if (!n) return null;
      const c = n.box.getCenter(new THREE.Vector3()).project(camera), r = renderer.domElement.getBoundingClientRect();
      return { x: r.left + (c.x * .5 + .5) * r.width, y: r.top + (-c.y * .5 + .5) * r.height };
    },
    dispose() { disposed = true; renderer.setAnimationLoop(null); ro.disconnect(); clearWorld(); renderer.dispose(); renderer.domElement.remove(); labels.remove(); },
  };
}
