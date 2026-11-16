// DASH v2 · 页面逻辑：状态页（3D 机库 + 大数字 + 注意栏 + 详情抽屉）、模型页（切换台 + 长按确认 + 进度时间线）
import { connect } from './data.js?v=__BUILD__';
import { createScene, statusOf, STATUS_COLOR } from './scene.js?v=__BUILD__';
import { CATS, catOf, catName, icon, iconG } from './icons.js?v=__BUILD__';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => (v == null || !Number.isFinite(+v) ? '—' : Math.round(+v));
const age = (s) => (s == null ? '' : s < 60 ? `${Math.round(s)} 秒` : s < 3600 ? `${Math.floor(s / 60)} 分` : s < 86400 ? `${Math.floor(s / 3600)} 时` : `${Math.floor(s / 86400)} 天`);
const STATUS_WORD = { normal: '正常', busy: '在干活', warm: '偏热', hot: '过热', asleep: '睡眠', offline: '离线' };
let KEEP = [];   // 可切换的卡：快照里 switchable 为真的那些，每次收到快照重算
const IN_FLIGHT = new Set(['queued', 'dispatched', 'running']);

let state = null, actions = [], client = null, scene = null, demo = false;
let view = 'status', picked = null, drawerId = null, lastUpdate = Date.now();

// ---------------- 路由 / 顶栏 ----------------
function go(next, opts = {}) {
  view = next === 'models' || next === 'projects' ? next : 'status';
  document.body.dataset.view = view;
  document.querySelectorAll('.tabs button').forEach((b) => (b.dataset.go === view ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  moveInk();
  if (history.replaceState) history.replaceState(null, '', `#${view}${location.search ? '' : ''}`);
  scene?.setView(view === 'status' ? 'status' : 'models'); requestAnimationFrame(() => updateInsets());   // 项目页沿用模型页的虚化宇宙中心背景
  if (view === 'models') { closeDrawer(); renderModels(); if (opts.flash) flashSlot(opts.flash); }
  if (view === 'projects') { closeDrawer(); renderProjects(true); }
  hideHover();
}
function moveInk() {
  const btn = document.querySelector('.tabs button[aria-current="page"]'), ink = document.querySelector('.tab-ink');
  if (!btn || !ink) return;
  ink.style.width = `${btn.offsetWidth}px`; ink.style.transform = `translateX(${btn.offsetLeft}px)`;
}
document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));
addEventListener('keydown', (e) => {
  if (e.target.closest('input,textarea')) return;
  if (e.key === '1') go('status'); else if (e.key === '2') go('models'); else if (e.key === '3') go('projects');
  else if (e.key === 'Escape') { if (picked) closeConfirm(); else closeDrawer(); }
  else if (drawerId && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) step(e.key === 'ArrowRight' ? 1 : -1);
});
addEventListener('resize', moveInk);
setInterval(() => {
  const now = new Date(Date.now() + (8 * 60 + new Date().getTimezoneOffset()) * 60000);   // 新加坡时间
  $('clock').innerHTML = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}<small>${String(now.getSeconds()).padStart(2, '0')}</small>`;
  if (!state) return;
  const stale = (state.stale_s || 0) + Math.floor((Date.now() - lastUpdate) / 1000);
  $('sync').className = `live${stale > 30 ? ' is-stale' : ''}`;
  $('sync').innerHTML = `<i></i>${demo ? '演示数据 · ' : ''}${stale <= 2 ? '实时' : `${stale} 秒前`}`;
  $('stale').hidden = !(stale > 30 && !demo);
  $('stale').textContent = `采集端 ${stale} 秒没更新，数据可能过时`;
}, 1000);

// 3D 取景的留白：避开左上大数字、右栏 / 抽屉、底部图例
function updateInsets(ms = 0) {
  if (!scene) return;
  const st = $('stage').getBoundingClientRect(), W = st.width;
  if (W < 760) {
    // 手机详情：3D 占满整屏，机器放在底部详情卡上方的区域里
    if (drawerId && document.body.classList.contains('is-detail')) scene.setInsets({ t: 64, r: 14, b: $('drawer').offsetHeight + 10, l: 14 }, ms);
    else if (!document.body.classList.contains('is-detail')) scene.setInsets({ t: 16, r: 10, b: 10, l: 10 }, ms);
    return;
  }
  if (view !== 'status') { scene.setInsets({ t: 0, r: 0, b: 0, l: 0 }, ms); return; }   // 模型页：宇宙中心虚化成整屏背景
  const k = $('kpis').getBoundingClientRect();
  const left = drawerId ? st.right - 20 - $('drawer').offsetWidth : $('rail').getBoundingClientRect().left;
  scene.setInsets({ t: drawerId ? 84 : Math.max(96, k.bottom - st.top + 58), r: Math.max(24, st.right - left + 24), b: drawerId ? 40 : 52, l: 28 }, ms);
}
addEventListener('resize', () => requestAnimationFrame(() => updateInsets()));

// ---------------- 状态页 ----------------
const machinesOf = () => state?.machines || [];
const runningOf = (id) => {
  const out = [];
  for (const c of state?.local_ai || []) for (const x of c.models || []) if (x.state === 'running') {
    if (c.slot === 'spark' ? machinesOf().find((m) => m.id === id)?.kind === 'gb10' : c.machine === id) out.push(x.name);
  }
  return out;
};
function renderKpis() {
  const ms = machinesOf(), on = ms.filter((m) => m.online), temps = on.filter((m) => m.temp_c != null);
  const peak = temps.reduce((a, m) => (!a || m.temp_c > a.temp_c ? m : a), null);
  const working = on.filter((m) => (m.gpu_pct ?? 0) >= 40 || m.status === 'busy').length;
  const load = on.length ? on.reduce((s, m) => s + Math.max(m.gpu_pct ?? 0, m.cpu_pct ?? 0), 0) / on.length : 0;
  const ses = state.claude?.sessions || [], busy = ses.filter((s) => s.status === 'busy').length;
  const wan = (state.sites || []).find((s) => s.wan && s.wan.down_mbps != null)?.wan;
  const pst = peak ? statusOf(peak) : 'normal';
  $('kpis').innerHTML = [
    `<div class="kpi"><span class="kpi-k">在线</span><span class="kpi-v">${on.length}<small>/${ms.length}</small></span><span class="kpi-s">${ms.length - on.length ? `${ms.length - on.length} 台离线` : '全部在线'}</span></div>`,
    `<div class="kpi is-${pst === 'hot' || pst === 'warm' ? pst : ''}"><span class="kpi-k">峰值温度</span><span class="kpi-v">${peak ? num(peak.temp_c) : '—'}<small>°C</small></span><span class="kpi-s">${esc(peak?.name || '')}</span></div>`,
    `<div class="kpi ${working ? 'is-busy' : ''}"><span class="kpi-k">在干活</span><span class="kpi-v">${working}<small>台</small></span><span class="kpi-s">机队负载 ${num(load)}%</span></div>`,
    `<div class="kpi"><span class="kpi-k">CLAUDE</span><span class="kpi-v">${busy}<small>/${ses.length}</small></span><span class="kpi-s">正在跑 / 会话</span></div>`,
    wan ? `<div class="kpi"><span class="kpi-k">外网</span><span class="kpi-v">${num(wan.down_mbps)}<small>Mbps</small></span><span class="kpi-s">↑ ${num(wan.up_mbps)} Mbps</span></div>` : '',
  ].join('');
}
function attention() {
  const out = [], ms = machinesOf();
  for (const m of ms) {
    const st = statusOf(m);
    if (st === 'hot') out.push({ sev: 5, c: STATUS_COLOR.hot, id: m.id, t: `${m.name} 过热`, s: `${num(m.temp_c)}°C · 已经超过 85°`, e: '' });
    else if (st === 'warm') out.push({ sev: 4, c: STATUS_COLOR.warm, id: m.id, t: `${m.name} 偏热`, s: `${num(m.temp_c)}°C`, e: '' });
    else if (st === 'offline') out.push({ sev: 3, c: '#7d8a97', id: m.id, t: `${m.name} 连不上`, s: (m.error || '探针没回应').slice(0, 40), e: '' });
    if (m.online && (m.disk_pct ?? 0) >= 92) out.push({ sev: 3, c: STATUS_COLOR.warm, id: m.id, t: `${m.name} 磁盘快满`, s: `已用 ${num(m.disk_pct)}%`, e: '' });
  }
  for (const c of state.local_ai || []) for (const x of c.models || []) if (x.state === 'locked' && x.up === false) {
    const m = ms.find((y) => y.id === c.machine);
    out.push({ sev: 4, c: STATUS_COLOR.warm, id: c.machine, t: `${m?.name || c.machine} · ${x.name} 没在跑`, s: '受保护的服务，只提醒不动它', e: '' });
  }
  return out.sort((a, b) => b.sev - a.sev);
}
function renderRail() {
  const att = attention(), ses = [...(state.claude?.sessions || [])].sort((a, b) => (a.status === 'busy' ? 0 : 1) - (b.status === 'busy' ? 0 : 1));
  const tasks = state.claude?.tasks || [], queue = state.queue || [];
  const maxAtt = innerHeight < 820 ? 3 : 5, maxSes = innerHeight < 820 ? 3 : 5;
  $('rail').innerHTML = `
    <section><h3>需要你注意<b>${att.length || ''}</b></h3>${att.length ? att.slice(0, maxAtt).map((a) => `<div class="att" data-open="${esc(a.id)}" style="--c:${a.c}"><i></i><div><strong>${esc(a.t)}</strong><span>${esc(a.s)}</span></div><em>${esc(a.e)}</em></div>`).join('') + (att.length > maxAtt ? `<div class="mini"><i></i><span>还有 ${att.length - maxAtt} 条</span></div>` : '') : '<div class="all-good">一切正常，没有要你处理的</div>'}</section>
    <section class="grow"><h3>CLAUDE 在做<b>${ses.filter((s) => s.status === 'busy').length} 个在跑 · 后台 ${tasks.length}</b></h3>${ses.slice(0, maxSes).map((s) => `<div class="mini ${s.status === 'busy' ? 'is-busy' : ''}"><i></i><div>${esc(s.title)}<small>${esc(s.project || '')}</small></div><em>${age(s.age_s)}</em></div>`).join('') || '<div class="mini"><i></i><span>没有会话</span></div>'}${tasks.slice(0, 2).map((s) => `<div class="mini is-busy"><i></i><div>${esc(s.title)}<small>后台任务</small></div><em>${age(s.age_s)}</em></div>`).join('')}</section>
    <section><h3>队列 · 等你定<b>${queue.length} · ${num(state.decide_pending ?? 0)}</b></h3>${queue.slice(0, 3).map((q) => `<div class="mini ${q.state === 'running' ? 'is-busy' : ''}"><i></i><div>${esc(q.title)}</div><em>${age(q.age_s)}</em></div>`).join('') || '<div class="mini"><i></i><span>队列是空的</span></div>'}</section>`;
}
$('rail').addEventListener('click', (e) => { const a = e.target.closest('[data-open]'); if (a) openDrawer(a.dataset.open); });

// 悬停卡
function showHover(id) {
  const m = machinesOf().find((x) => x.id === id), tag = document.querySelector(`.tag[data-id="${CSS.escape(id || '')}"]`);
  if (!m || !tag || view !== 'status' || drawerId) return hideHover();
  const r = tag.getBoundingClientRect(), host = $('dashboard').getBoundingClientRect(), hc = $('hovercard');
  const run = runningOf(id);
  hc.innerHTML = `<h4>${esc(m.name)} · <span style="color:${STATUS_COLOR[statusOf(m)]}">${STATUS_WORD[statusOf(m)]}</span></h4>${bars(m)}${run.length ? `<div class="chips" style="margin-top:8px">${run.map((x) => `<span class="chip on">${esc(x)}</span>`).join('')}</div>` : ''}${hoverProcs(m)}`;
  hc.hidden = false;
  const w = hc.offsetWidth, h = hc.offsetHeight;
  let x = r.right - host.left + 12, y = r.top - host.top - 4;
  if (x + w > host.width - 12) x = r.left - host.left - w - 12;
  y = Math.max(70, Math.min(host.height - h - 12, y));
  hc.style.left = `${x}px`; hc.style.top = `${y}px`;
  dimUnder(hc, tag);
}
// 悬停卡底下压着的名牌先淡掉（只改透明度、不改排布，免得名牌挪走触发新的悬停）
function dimUnder(hc, keep) {
  const c = hc.getBoundingClientRect();
  for (const el of document.querySelectorAll('.scene-labels > *')) {
    if (el === keep) { el.classList.remove('is-under'); continue; }
    const r = el.getBoundingClientRect();
    el.classList.toggle('is-under', r.width > 0 && r.left < c.right + 6 && r.right > c.left - 6 && r.top < c.bottom + 6 && r.bottom > c.top - 6);
  }
}
function hoverProcs(m) {
  const { other, amt } = procInfo(m); if (!other.length) return '';
  return `<div class="hc-pr"><h6>占用前 3（不含模型）</h6>${other.map((p) => `<p><span>${pname(p)}</span><em>${amt(p)}</em></p>`).join('')}</div>`;
}
function hideHover() { $('hovercard').hidden = true; for (const el of document.querySelectorAll('.scene-labels > .is-under')) el.classList.remove('is-under'); }
// 占内存 / 显存最多的进程（hub 按进程名汇总；模型进程单独算，不进前 3）
const gbs = (v) => (v == null ? '' : v >= 10 ? `${Math.round(v)} GB` : `${v.toFixed(1)} GB`);
function procInfo(m) {
  const ps = m.procs || [], unified = m.kind === 'gb10';
  const vt = (m.gpus || []).reduce((a, g) => a + (g.vram_gb || 0), 0), mt = m.mem_total_gb || 0;
  const amt = (p) => (unified ? gbs(Math.max(p.ram_gb || 0, p.vram_gb || 0)) : [p.ram_gb >= 0.05 ? `内存 ${gbs(p.ram_gb)}` : '', p.vram_gb ? `显存 ${gbs(p.vram_gb)}` : ''].filter(Boolean).join(' · '));
  const share = (p) => Math.min(100, 100 * Math.max(unified ? Math.max(p.ram_gb || 0, p.vram_gb || 0) / (mt || 1) : (p.ram_gb || 0) / (mt || 1), !unified && vt ? (p.vram_gb || 0) / vt : 0));
  return { other: ps.filter((p) => !p.model).slice(0, 3), mod: ps.filter((p) => p.model), amt, share };
}
const pname = (p) => `${esc(p.name)}${p.n > 1 ? `<em> ×${p.n}</em>` : ''}`;
function procSec(m) {
  const { other, mod, amt, share } = procInfo(m); if (!other.length && !mod.length) return '';
  const sumMod = { ram_gb: mod.reduce((a, p) => a + (p.ram_gb || 0), 0), vram_gb: mod.reduce((a, p) => a + (p.vram_gb || 0), 0) || null };
  return `<div class="dr-sec"><h5>占用最多的进程 · 前 3（不含模型）</h5>
    ${other.map((p) => `<div class="pr-row"><b>${pname(p)}</b><span>${amt(p)}</span><i><b style="width:${Math.max(1.5, share(p)).toFixed(1)}%"></b></i></div>`).join('') || '<p class="pr-none">除了模型没有别的大进程</p>'}
    ${mod.length ? `<p class="pr-mod"><b>模型进程</b>${mod.map((p) => pname(p)).join('、')} · 共 ${amt(sumMod)}</p>` : ''}</div>`;
}
function bars(m) {
  const row = (k, v) => `<span>${k}</span><i><b style="width:${Math.max(0, Math.min(100, v ?? 0))}%"></b></i><span>${num(v)}%</span>`;
  return `<div class="bars">${row('CPU', m.cpu_pct)}${row('内存', m.mem_pct)}${m.gpu_pct != null ? row('GPU', m.gpu_pct) : ''}${row('磁盘', m.disk_pct)}</div>`;
}

// 详情：点任一台 → 镜头无缝推近成大 3D（手机上整屏），底部 / 右侧是详情卡；可拖动旋转、左右切换
let detailRect = null;
function openDrawer(id) {
  const m = machinesOf().find((x) => x.id === id); if (!m) return;
  const first = !drawerId;
  drawerId = id; hideHover();
  renderDrawer();
  $('drawer').hidden = false;
  if (first) enterDetail();
  scene?.focus(id);
  requestAnimationFrame(() => updateInsets(first ? 900 : 500));
}
// 显卡：每张一行；同型号多卡只在标题写一次型号，行里写 GPU0 / GPU1
function gpuSec(m) {
  const gs = m.gpus || []; if (!gs.length) return '';
  const same = gs.length > 1 && gs.every((g) => g.name === gs[0].name);
  return `<div class="dr-sec"><h5>显卡${same ? ` · ${gs.length} × ${esc(gs[0].name)}${gs[0].vram_gb ? ` ${gs[0].vram_gb} GB` : ''}` : ''}</h5>${gs.map((g) => `<div class="gpu-row c"><b>${same ? `GPU${g.idx}` : esc(g.name)}</b><span>${num(g.temp_c)}° · ${num(g.power_w)} W · 利用率 ${num(g.util)}% · 显存 ${num(g.mem_pct)}%${!same && g.vram_gb ? ` / ${g.vram_gb} GB` : ''}</span></div>`).join('')}</div>`;
}
function renderDrawer() {
  const id = drawerId, m = machinesOf().find((x) => x.id === id); if (!m) return;
  const st = statusOf(m), run = runningOf(id), hist = (m.temp_hist || []).filter((v) => v != null);
  const slot = m.kind === 'gb10' ? 'spark' : KEEP.includes(id) ? id : null;
  let spark = '';
  if (hist.length > 1) {
    const lo = Math.min(...hist) - 2, hi = Math.max(...hist) + 2, W = 340, H = 44;
    const pts = hist.map((v, i) => `${(i / (hist.length - 1) * W).toFixed(1)},${(H - (v - lo) / (hi - lo || 1) * (H - 8) - 4).toFixed(1)}`).join(' ');
    spark = `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${STATUS_COLOR[st]}" stroke-width="1.6"/></svg><div class="dr-role">${hist.length} 分钟 · ${Math.round(Math.min(...hist))}° ~ ${Math.round(Math.max(...hist))}°</div>`;
  }
  const list = machinesOf(), idx = list.findIndex((x) => x.id === id), dr = $('drawer'), keep = dr.scrollTop;
  dr.innerHTML = `<i class="dr-grab" data-grab aria-hidden="true"></i>
    <div class="dr-nav"><button type="button" data-step="-1" aria-label="上一台">‹</button><span>${idx + 1} / ${list.length}</span><button type="button" data-step="1" aria-label="下一台">›</button></div>
    <button class="dr-x" type="button" aria-label="关闭" data-close>×</button>
    <p class="dr-k">${esc((state.sites || []).find((s) => s.id === m.site)?.name || '')} · ${esc(STATUS_WORD[st])}</p>
    <h2 class="dr-name">${esc(m.name)}</h2><p class="dr-role">${esc(m.role || '')}${m.uptime_s ? ` · 已运行 ${age(m.uptime_s)}` : ''}</p>
    <div class="dr-top${m.online ? '' : ' is-off'}"><div class="dr-temp" style="--c:${STATUS_COLOR[st]}"><b>${m.online ? num(m.temp_c) : '—'}°</b><span>${m.online ? '当前最高温度' : esc(m.error || '连不上')}</span></div>${m.online ? bars(m) : ''}</div>
    <div class="dr-sec"><h5>正在跑</h5><div class="chips">${run.length ? run.map((x) => `<span class="chip on">${esc(x)}</span>`).join('') : '<span class="chip">没有登记的模型服务</span>'}</div></div>
    ${m.online ? procSec(m) : ''}
    ${gpuSec(m)}
    ${spark ? `<div class="dr-sec dr-spark-sec"><h5>最近温度</h5>${spark}</div>` : ''}
    ${slot ? `<button class="go-models" type="button" data-goslot="${slot}">去模型页切换 →</button>` : ''}`;
  dr.scrollTop = keep;
}
function step(d) {
  const list = machinesOf(); if (!list.length || !drawerId) return;
  const i = list.findIndex((m) => m.id === drawerId);
  openDrawer(list[(i + d + list.length) % list.length].id);
}
const PH = () => innerWidth < 760;
function showHint(text, key = 'dashHint') {
  const h = $('detail-hint'); if (!h || +sessionStorage[key] > 2) return;
  sessionStorage[key] = (+sessionStorage[key] || 0) + 1;
  h.textContent = text || (PH() ? '拖动旋转 · 双指缩放 · 左右滑卡片换一台' : '拖动旋转 · 滚轮缩放 · ← → 换一台');
  h.classList.add('is-on'); clearTimeout(showHint.tm); showHint.tm = setTimeout(() => h.classList.remove('is-on'), 3600);
}
function enterDetail() {
  const b = document.body, st = $('stage');
  b.classList.add('is-focus'); clearTimeout(exitDetail.tm); $('drawer').classList.remove('is-leaving');
  showHint();
  if (innerWidth >= 760 || view !== 'status') return;
  if (b.classList.contains('is-detail')) { st.style.clipPath = 'inset(0px 0px 0px 0px)'; return; }
  // 从原来 3D 区的位置展开到整屏：先按原位置裁切、按原取景渲染，再放开裁切 —— 没有跳变
  const r = st.getBoundingClientRect(), H = innerHeight;
  detailRect = { t: Math.max(0, Math.round(r.top)), b: Math.max(0, Math.round(H - r.bottom)) };
  st.style.transition = 'none';
  st.style.clipPath = `inset(${detailRect.t}px 0px ${detailRect.b}px 0px)`;
  b.classList.add('is-detail');
  scene?.setInsets({ t: detailRect.t + 16, r: 10, b: detailRect.b + 10, l: 10 });
  scene?.resize();
  void st.offsetWidth; st.style.transition = '';
  requestAnimationFrame(() => { st.style.clipPath = 'inset(0px 0px 0px 0px)'; });
}
function exitDetail() {
  const b = document.body, dr = $('drawer'), st = $('stage');
  b.classList.remove('is-focus'); dr.classList.remove('is-tall');
  if (!b.classList.contains('is-detail')) { dr.hidden = true; requestAnimationFrame(() => updateInsets(800)); return; }
  dr.classList.add('is-leaving');
  const r = detailRect || { t: 0, b: 0 };
  st.style.clipPath = `inset(${r.t}px 0px ${r.b}px 0px)`;
  scene?.setInsets({ t: r.t + 16, r: 10, b: r.b + 10, l: 10 }, 800);
  clearTimeout(exitDetail.tm);
  exitDetail.tm = setTimeout(() => {
    if (drawerId) return;
    dr.hidden = true; dr.classList.remove('is-leaving');
    st.style.transition = 'none'; st.style.clipPath = '';
    b.classList.remove('is-detail');
    scene?.setInsets({ t: 16, r: 10, b: 10, l: 10 }); scene?.resize();
    void st.offsetWidth; st.style.transition = '';
  }, 820);
}
function closeDrawer() { if (!drawerId) return; drawerId = null; scene?.focus(null); exitDetail(); }
$('drawer').addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) return closeDrawer();
  const sb = e.target.closest('[data-step]'); if (sb) return step(+sb.dataset.step);
  if (e.target.closest('[data-grab]')) return $('drawer').classList.toggle('is-tall');
  const g = e.target.closest('[data-goslot]'); if (g) go('models', { flash: g.dataset.goslot });
});
// 详情卡上左右滑 = 换一台
let swipe = null;
$('drawer').addEventListener('pointerdown', (e) => { swipe = { x: e.clientX, y: e.clientY }; });
$('drawer').addEventListener('pointerup', (e) => {
  if (!swipe) return; const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y; swipe = null;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.6) step(dx < 0 ? 1 : -1);
});
new ResizeObserver(() => { if (drawerId) updateInsets(500); }).observe($('drawer'));
{
  const back = document.createElement('button'); back.type = 'button'; back.className = 'detail-back'; back.innerHTML = '<span aria-hidden="true">‹</span>机库';
  back.addEventListener('click', () => closeDrawer());
  const hint = document.createElement('div'); hint.id = 'detail-hint'; hint.className = 'detail-hint';
  const reset = document.createElement('button'); reset.type = 'button'; reset.id = 'view-reset'; reset.className = 'view-reset'; reset.hidden = true;
  reset.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 10a5.5 5.5 0 1 0 1.7-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M4 3.2v3.6h3.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>复位视角';
  reset.addEventListener('click', () => scene?.resetView());
  $('dashboard').append(back, hint); $('stage').append(reset);
}

// ---------------- 模型页 ----------------
function slotsData() {
  const ms = machinesOf(), opts = new Map((state.switch_options || []).map((o) => [o.id, o]));
  return KEEP.map((slot) => {
    const card = (state.local_ai || []).find((c) => c.slot === slot); if (!card) return null;
    let name, hw, st, temp;
    if (slot === 'spark') {
      const sp = ms.filter((m) => m.kind === 'gb10'), worst = sp.reduce((a, m) => (rankOf(m) > rankOf(a) ? m : a), sp[0]);
      name = `Spark ×${sp.length}`; hw = `${sp.length}×GB10 · 统一内存 · 集群`; st = statusOf(worst); temp = Math.max(...sp.filter((m) => m.online).map((m) => m.temp_c ?? 0));
      if (!sp.some((m) => m.online)) st = 'offline';
    } else {
      const m = ms.find((x) => x.id === card.machine) || { name: card.machine, online: false };
      name = m.name; hw = card.label; st = statusOf(m); temp = m.temp_c;
    }
    const cur = (card.models || []).filter((x) => x.state === 'running');
    const cand = (card.models || []).filter((x) => x.state !== 'running' && x.id !== '_switching').map((x) => ({ ...x, opt: x.option ? opts.get(x.option) : null }));
    const freeOpt = (card.models || []).find((x) => x.state === 'running' && x.option);   // 「释放显存」这类选项
    const machine = card.machine;
    const act = actions.find((a) => a.machine === machine);
    return { slot, machine, name, hw, st, temp, cur, cand, freeOpt: freeOpt ? opts.get(freeOpt.option) : null, switching: (card.models || []).some((x) => x.id === '_switching'), act };
  }).filter(Boolean);
}
const rankOf = (m) => ({ hot: 5, warm: 4, busy: 3, normal: 2, asleep: 1, offline: 0 }[statusOf(m)] ?? 0);
function timeline(a) {
  const steps = ['已提交', '已派发', '切换中', '就绪'], idx = { queued: 0, dispatched: 1, running: 2, done: 3, failed: 2 }[a.status] ?? 0;
  const opt = (state.switch_options || []).find((o) => o.id === a.option), eta = opt?.eta_s || 120;
  const el = Math.max(0, (Date.now() - (a.updated || a.created)) / 1000), p = a.status === 'running' ? Math.min(95, el / eta * 100) : 35;
  return `<div class="timeline"><div class="tl-steps">${steps.map((s, i) => `<div class="tl-step ${a.status === 'failed' && i === idx ? 'is-fail' : i < idx || a.status === 'done' ? 'is-done' : i === idx ? 'is-now' : ''}" style="--p:${p}%">${s}</div>`).join('')}</div>
    <p class="tl-msg"><b>${esc(a.label || '')}</b>${a.status === 'running' ? ` · 已 ${age(el)}，预计 ${age(eta)}` : ''}${a.message ? ` · ${esc(a.message)}` : ''}</p></div>`;
}
function renderModels() {
  if (!state) return;
  $('slots').innerHTML = slotsData().map((s) => {
    const inFlight = s.act && IN_FLIGHT.has(s.act.status), recent = s.act && !inFlight && Date.now() - (s.act.updated || 0) < 90000;
    const nowName = s.switching ? '正在切档…' : s.cur.map((x) => x.name).join(' · ') || '没有在跑';
    const right = inFlight || recent ? timeline(s.act)
      : `<div class="opts">${s.cand.map((x) => {
          const can = !!x.opt && s.st !== 'offline' && !s.switching;
          return `<button type="button" class="opt${picked?.id === x.opt?.id && picked ? ' is-picked' : ''}" ${can ? `data-pick="${esc(x.opt.id)}"` : 'disabled'} title="${esc(x.opt?.confirm || (x.state === 'busy' ? '别人正在用' : '这台不在这里切换'))}"><strong>${esc(x.name)}</strong><span>${can ? `约 ${age(x.opt.eta_s)}` : x.state === 'busy' ? '占用中' : '不可切'}</span></button>`;
        }).join('')}${s.freeOpt ? `<button type="button" class="opt" data-pick="${esc(s.freeOpt.id)}"><strong>释放显存</strong><span>卸载当前模型</span></button>` : ''}</div>`;
    return `<article class="slot is-${s.st}" data-slot="${s.slot}" style="--c:${STATUS_COLOR[s.st]}">
      <div><div class="sl-name">${esc(s.name)}</div><div class="sl-hw">${esc(s.hw)}</div><div class="sl-st"><b>${s.st === 'offline' ? '—' : `${num(s.temp)}°`}</b>${STATUS_WORD[s.st]}</div></div>
      <div><div class="now-k">正在跑</div><div class="now-v${s.cur.length ? '' : ' is-none'}">${esc(nowName)}</div><div class="now-s">${inFlight ? '切换进行中，别的机器不受影响' : s.cand.some((x) => x.opt) ? `${s.cand.filter((x) => x.opt).length} 个候选可切` : '这台没有可切的候选'}</div></div>
      <div>${right}</div></article>`;
  }).join('');
  // 只读：共享 GPU 看板（kind: gpus）+ 其它服务
  const ms = machinesOf(), a100 = (state.local_ai || []).find((c) => c.kind === 'gpus');
  const others = (state.local_ai || []).filter((c) => !KEEP.includes(c.slot) && c.kind !== 'gpus');
  $('readonly').innerHTML = `
    <div class="ro"><h3>${esc(a100?.label || '共享 GPU')} · 只看不切</h3><div class="gpus">${(a100?.models || []).map((x) => `<span class="gpu ${x.state === 'busy' ? 'is-busy' : ''}"><b>${esc(x.name)}</b><span>${x.state === 'busy' ? '在跑' : x.state === 'running' ? '就绪' : '空闲'}</span></span>`).join('') || '<span class="gpu">没有数据</span>'}</div></div>
    <div class="ro"><h3>其它机器上的服务 · 只读</h3>${others.map((c) => {
      const m = ms.find((y) => y.id === c.machine) || { name: c.machine };
      const svcs = (c.models || []).filter((x) => x.state === 'running' || x.state === 'locked').map((x) => `<span class="svc ${x.state === 'locked' && x.up === false ? 'down' : 'on'}">${esc(x.name)}${x.state === 'locked' && x.up === false ? ' 未运行' : ''}</span>`).join(' · ');
      return `<p><strong>${esc(m.name)}</strong><span>${svcs || '<span class="svc off">没有在跑的服务</span>'}</span></p>`;
    }).join('')}</div>`;
}
function flashSlot(slot) { requestAnimationFrame(() => { const el = document.querySelector(`.slot[data-slot="${slot}"]`); if (el) { el.classList.add('is-flash'); setTimeout(() => el.classList.remove('is-flash'), 2400); } }); }
$('slots').addEventListener('click', (e) => { const b = e.target.closest('[data-pick]'); if (b) openConfirm(b.dataset.pick); });

// 长按确认
let holdRaf = 0, holdStart = 0, holdP = 0;
function openConfirm(optionId) {
  const o = (state.switch_options || []).find((x) => x.id === optionId); if (!o) return;
  picked = o; renderModels(); closeConfirm(true);
  const bar = document.createElement('div'); bar.className = 'confirm'; bar.id = 'confirm';
  bar.innerHTML = `<div class="cf-text"><strong>${esc(o.label)}</strong><span>${esc(o.confirm || '')}${o.eta_s ? ` · 约 ${age(o.eta_s)}` : ''}</span><span class="cf-err" id="cf-err" hidden></span></div>
    <button type="button" class="cf-cancel" data-cancel>取消</button>
    <button type="button" class="hold" id="hold" aria-label="按住 1 秒确认切换"><svg viewBox="0 0 22 22"><circle class="bg" cx="11" cy="11" r="9"/><circle class="fg" cx="11" cy="11" r="9"/></svg>按住 1 秒切换</button>`;
  $('page-models').append(bar);
  const hold = $('hold');
  const start = (e) => { if (holdRaf || hold.classList.contains('is-done')) return; e.preventDefault(); holdStart = performance.now(); const tick = (now) => { holdP = Math.min(1, (now - holdStart) / 1000); hold.style.setProperty('--p', holdP); if (holdP >= 1) { holdRaf = 0; fire(); } else holdRaf = requestAnimationFrame(tick); }; holdRaf = requestAnimationFrame(tick); };
  const stop = () => { if (!holdRaf) return; cancelAnimationFrame(holdRaf); holdRaf = 0; const from = holdP, t0 = performance.now(); const back = (now) => { holdP = Math.max(0, from * (1 - (now - t0) / 220)); hold.style.setProperty('--p', holdP); if (holdP > 0) requestAnimationFrame(back); }; requestAnimationFrame(back); };
  hold.addEventListener('pointerdown', start); hold.addEventListener('pointerup', stop); hold.addEventListener('pointerleave', stop); hold.addEventListener('pointercancel', stop);
  hold.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) start(e); });
  hold.addEventListener('keyup', (e) => { if (e.key === 'Enter' || e.key === ' ') stop(); });
  bar.querySelector('[data-cancel]').addEventListener('click', () => closeConfirm());
  hold.focus({ preventScroll: true });
}
async function fire() {
  const hold = $('hold'); if (!hold || !picked) return;
  hold.classList.add('is-done'); hold.lastChild.textContent = '已提交';
  try { await client.submit(picked.id); toast(`已提交：${picked.label}`); closeConfirm(); }
  catch (err) { const el = $('cf-err'); el.textContent = err.message || '提交失败'; el.hidden = false; hold.classList.remove('is-done'); hold.lastChild.textContent = '按住 1 秒切换'; hold.style.setProperty('--p', 0); }
}
function closeConfirm(keepPick) { $('confirm')?.remove(); if (!keepPick) { picked = null; renderModels(); } }
function toast(text) { const t = $('toast'); t.textContent = text; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3200); }

// ---------------- 项目页 ----------------
// 数据来自 hub 扫各项目的 progress.md / logs.md：进度 = 待办勾选比例，节奏 = 最近 14 天每天的记录条数。
// 进行中（3 天内有动静或有会话在跑）→ 已完成（3 天内）→ 搁置（3–30 天没动）；完成超过 3 天进归档，30 天没动的收进「更早」。
const PJ_WORD = { active: '进行中', done: '已完成', paused: '搁置', archived: '归档', stale: '更早' };
const pjOpen = new Set();
const ago = (ms) => (ms ? `${age(Math.max(0, (Date.now() - ms) / 1000))}前` : '—');
const FOLDER = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 3.5h4.2l1.5 1.6h7.3v7.4H1.5z" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
const dirBtn = (p) => `<button type="button" class="pj-dir" data-copy="${esc(p.dir || p.path)}" title="点一下复制路径">${FOLDER}<code>${esc(p.dir || p.path)}</code><span>复制</span></button>`;
const intentOf = (p) => (p.intent ? esc(p.intent) : '<span class="pj-none">没写意图（在这个文件夹的 context.md 里补一句「目标：」）</span>');
function pjCard(p) {
  const pct = p.total ? Math.round(100 * p.done / p.total) : null, open = pjOpen.has(p.id);
  const spark = (p.days || []).map((n) => `<i style="--h:${Math.min(1, n / 4)}" class="${n ? 'on' : ''}"></i>`).join('');
  const next = (p.next || []).slice(0, 4).map((t) => `<li>${esc(t)}</li>`).join('');
  return `<article class="pj is-${p.status}${open ? ' is-open' : ''}" data-pj="${esc(p.id)}">
    <header><span class="pj-ic">${icon(catOf(p), 20)}</span><div class="pj-hd"><b>${esc(p.name)}</b><em>${catName(p)}</em></div>${p.live ? `<span class="pj-live${p.live_busy ? ' is-busy' : ''}">${p.live} 个会话${p.live_busy ? ' · 在跑' : ''}</span>` : `<span class="pj-st">${PJ_WORD[p.status]}</span>`}</header>
    <p class="pj-intent">${intentOf(p)}</p>
    ${dirBtn(p)}
    <div class="pj-meta">${pct == null ? '<span class="pj-num is-none">没有待办清单</span>' : `${ring(pct)}<span class="pj-num"><b>${pct}%</b> 完成 · ${p.done}/${p.total} 项</span>`}<em>${ago(p.last)}</em></div>
    ${open && p.milestone ? `<p class="pj-ms"><b>最新</b>${esc(p.milestone)}</p>` : ''}
    ${open && next ? `<ul class="pj-next">${next}</ul>` : ''}
    <div class="pj-spark" aria-label="最近 14 天">${spark}</div><p class="pj-spark-l"><span>14 天前</span><span>每天记录条数</span><span>今天</span></p>
  </article>`;
}
function pjRow(p) {
  return `<div class="pj-row is-${p.status}" data-pjrow="${esc(p.id)}"><p><span class="pj-ic sm" title="${catName(p)}">${icon(catOf(p), 14)}</span><b>${esc(p.name)}</b><time>${ago(p.last)}</time></p><p class="pj-row-i">${intentOf(p)}</p>${dirBtn(p)}</div>`;
}
// ---------- 图形化总览：项目轨道图 + 状态环 + 本周最忙 ----------
const PJC = { active: '#3df2a4', done: '#8fcfff', paused: '#8d9fbd', archived: '#5b6774', stale: '#3a4552' };   // 搁置用安静的灰蓝，不像报警
const ring = (pct, size = 34) => `<svg class="pj-ring" viewBox="0 0 36 36" width="${size}" height="${size}" aria-hidden="true"><circle class="t" cx="18" cy="18" r="15"/><circle class="v" cx="18" cy="18" r="15" pathLength="100" stroke-dasharray="${pct} 100"/></svg>`;
const sum = (a) => (a || []).reduce((x, y) => x + y, 0);
const ORB = [0, 1, 3, 7, 14, 30], ORB_LAB = ['', '1 天', '3 天', '1 周', '2 周', '1 个月'];
// 电脑：宽椭圆轨道；手机：接近正圆、字号放大（viewBox 窄了，字才看得清），只给最活跃的几个标名字
const orbGeo = () => (PH() ? { W: 600, H: 640, CX: 300, CY: 330, R0: 58, R1: 268, SQ: .97, fs: 24, rn0: 16, rnk: 15, maxLab: pjCat ? 6 : 0 }
  : { W: 1000, H: 580, CX: 500, CY: 290, R0: 78, R1: 440, SQ: .5, fs: 14, rn0: 11, rnk: 12, maxLab: 16 });
const ORB_F = [0, .24, .43, .61, .79, 1];   // 每圈占的半径比例：「今天→1 天」给得最宽，进行中的项目不挤成一团
function orbitR(days, G) {   // 离中心的距离：按 0 / 1 / 3 / 7 / 14 / 30 天分段线性，超过 30 天挤在最外圈
  if (days <= 0) return G.R0;
  for (let i = 1; i < ORB.length; i++) if (days <= ORB[i]) return G.R0 + (G.R1 - G.R0) * (ORB_F[i - 1] + (ORB_F[i] - ORB_F[i - 1]) * (days - ORB[i - 1]) / (ORB[i] - ORB[i - 1]));
  return G.R1 + Math.min(G.R1 * .06, (days - 30) / 8);
}
const textW = (t, px) => [...t].reduce((w, ch) => w + (ch.charCodeAt(0) > 255 ? px : px * .58), 0);
function orbitSvg(ps) {
  const G = orbGeo(), { CX, CY, SQ } = G;
  const main = ps.filter((p) => ['active', 'done', 'paused'].includes(p.status)), rest = ps.filter((p) => !main.includes(p));
  const maxA = Math.max(1, ...main.map((p) => sum(p.days)));
  const now = Date.now(), nodes = [];
  const place = (list, small0) => list.forEach((p, i) => {
    const hit = !!pjCat && catOf(p) === pjCat, small = small0 && !hit;   // 筛选时这一类的归档项目也画成带图标的星
    const days = p.last ? (now - p.last) / 864e5 : 60, r = orbitR(days, G), a = (small ? .9 : 0) + i * 2.39996 - Math.PI / 2;   // 黄金角，均匀铺开
    const rn = small ? G.rn0 * .4 : small0 ? G.rn0 * .85 : G.rn0 + G.rnk * Math.sqrt(sum(p.days) / maxA);
    nodes.push({ p, x: CX + r * Math.cos(a), y: CY + r * SQ * Math.sin(a), rn, small, r, dim: !!pjCat && catOf(p) !== pjCat });
  });
  place(main, false); place(rest, true);
  const rings = ORB.slice(1).map((d) => { const r = orbitR(d, G); return `<ellipse cx="${CX}" cy="${CY}" rx="${r}" ry="${r * SQ}" class="orb${d === 3 ? ' is-key' : ''}"/>`; }).join('');
  // 刻度：每圈正上方一块深色小牌，画在最上层，压在星上也读得清
  const rl = ORB.slice(1).map((d, i) => { const r = orbitR(d, G), t = ORB_LAB[i + 1], w = textW(t, G.fs) + G.fs * .9; return { x: CX, y: CY - r * SQ, t, w }; });
  const ringLab = rl.map((l) => `<g class="orb-lg"><rect x="${(l.x - l.w / 2).toFixed(1)}" y="${(l.y - G.fs * .72).toFixed(1)}" width="${l.w.toFixed(1)}" height="${(G.fs * 1.44).toFixed(1)}" rx="${(G.fs * .72).toFixed(1)}"/><text x="${l.x}" y="${(l.y + G.fs * .36).toFixed(1)}" class="orb-l">${l.t}</text></g>`).join('');
  // 标签：右 → 左 → 下 → 上，压到别的标签或星就换位置，四个都不行就只在悬停时显示
  const boxes = nodes.filter((n) => !n.small && !n.dim).map((n) => ({ x: n.x - n.rn - 5, y: n.y - n.rn - 5, w: 2 * n.rn + 10, h: 2 * n.rn + 10 }))
    .concat(rl.map((l) => ({ x: l.x - l.w / 2 - 4, y: l.y - G.fs * .8, w: l.w + 8, h: G.fs * 1.6 })), [{ x: CX - G.fs * 1.6, y: CY - G.fs, w: G.fs * 3.2, h: G.fs * 2 }]);
  const hit = (b) => boxes.some((o) => b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y) || b.x < 4 || b.x + b.w > G.W - 4 || b.y < 4 || b.y + b.h > G.H - 4;
  const labels = [];
  // 只给大星标名字（进行中 / 刚完成优先，再按活跃度），名字写全；其余悬停或点开看
  const pri = (n) => (n.p.status === 'active' ? 2 : n.p.status === 'done' ? 1 : 0) * 1000 + n.rn;
  for (const n of nodes.filter((n) => !n.small && !n.dim).sort((a, b) => pri(b) - pri(a)).slice(0, G.maxLab)) {
    const name = n.p.name.replace(/（.*?）/g, ''), w = textW(name, G.fs) + 4, h = G.fs * 1.25;
    const tries = [[n.x + n.rn + 8, n.y - h / 2, 'start'], [n.x - n.rn - 8 - w, n.y - h / 2, 'end'], [n.x - w / 2, n.y + n.rn + 6, 'mid'], [n.x - w / 2, n.y - n.rn - 6 - h, 'mid']];
    const t = tries.find(([x, y]) => !hit({ x, y, w, h }));
    if (t) { boxes.push({ x: t[0], y: t[1], w, h }); labels.push(`<text x="${t[0] + (t[2] === 'end' ? w : t[2] === 'mid' ? w / 2 : 0)}" y="${t[1] + G.fs * .95}" text-anchor="${t[2] === 'end' ? 'end' : t[2] === 'mid' ? 'middle' : 'start'}" class="orb-n is-${n.p.status}" data-node="${esc(n.p.id)}">${esc(name)}</text>`); }
  }
  const draw = nodes.sort((a, b) => b.r - a.r).map((n) => {
    const c = PJC[n.p.status], pct = n.p.total ? Math.round(100 * n.p.done / n.p.total) : null;
    if (n.small) return `<circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${n.rn}" fill="${c}" class="orb-s${n.dim ? ' is-dim' : ''}" data-node="${esc(n.p.id)}"/>`;
    const s = n.rn * 1.34;
    return `<g transform="translate(${n.x.toFixed(1)} ${n.y.toFixed(1)})" class="orb-g is-${n.p.status}${n.dim ? ' is-dim' : ''}" data-node="${esc(n.p.id)}">
      ${n.p.live ? `<circle r="${n.rn + 4}" class="orb-live" style="--c:${c}"/>` : ''}
      <circle r="${n.rn + 6}" class="orb-t"/>${pct != null ? `<circle r="${n.rn + 6}" class="orb-p" stroke="${c}" pathLength="100" stroke-dasharray="${pct} 100" transform="rotate(-90)"/>` : ''}
      <circle r="${n.rn}" fill="${c}" class="orb-c" style="--c:${c}"/><g transform="translate(${(-s / 2).toFixed(1)} ${(-s / 2).toFixed(1)}) scale(${(s / 24).toFixed(3)})" class="orb-ic">${iconG(catOf(n.p))}</g></g>`;
  }).join('');
  return `<svg viewBox="0 0 ${G.W} ${G.H}" class="pj-orb-svg${PH() ? ' is-ph' : ''}" role="img" aria-label="项目轨道图">
    <defs><radialGradient id="orbCore"><stop offset="0" stop-color="#3df2a4" stop-opacity=".55"/><stop offset="1" stop-color="#3df2a4" stop-opacity="0"/></radialGradient></defs>
    <ellipse cx="${CX}" cy="${CY}" rx="${G.R0 * 1.6}" ry="${G.R0 * 1.6 * SQ}" fill="url(#orbCore)"/>${rings}
    ${draw}${labels.join('')}${ringLab}<text x="${CX}" y="${CY + G.fs * .36}" class="orb-today">今天</text></svg>`;
}
function donutSvg(ps) {
  const seg = ['active', 'done', 'paused', 'archived', 'stale'].map((k) => ({ k, n: ps.filter((p) => p.status === k).length })).filter((s) => s.n);
  const tot = ps.length || 1; let off = 0;
  const arcs = seg.map((s) => { const v = 100 * s.n / tot, a = `<circle cx="60" cy="60" r="46" pathLength="100" stroke="${PJC[s.k]}" stroke-dasharray="${Math.max(0, v - .8)} ${100 - v + .8}" stroke-dashoffset="${-off}" class="dn"/>`; off += v; return a; }).join('');
  return `<div class="pj-donut-in"><svg viewBox="0 0 120 120" class="pj-dn" aria-hidden="true"><g transform="rotate(-90 60 60)">${arcs}</g><text x="60" y="58" class="dn-n">${ps.length}</text><text x="60" y="76" class="dn-l">个项目</text></svg>
    <ul>${seg.map((s) => `<li><i style="background:${PJC[s.k]}"></i>${PJ_WORD[s.k]}<b>${s.n}</b></li>`).join('')}</ul></div>`;
}
function weekBars(ps) {
  const top = ps.filter((p) => sum((p.days || []).slice(7)) > 0).sort((a, b) => sum(b.days.slice(7)) - sum(a.days.slice(7))).slice(0, 7);
  if (!top.length) return '<p class="pj-none">这周还没有项目写日志</p>';
  const mx = Math.max(...top.map((p) => sum(p.days.slice(7))));
  return top.map((p) => { const n = sum(p.days.slice(7)); return `<div class="wk" data-node="${esc(p.id)}"><b><span class="wk-ic" style="color:${PJC[p.status]}">${icon(catOf(p), 15)}</span>${esc(p.name)}</b><span><i style="width:${Math.max(4, 100 * n / mx)}%;background:${PJC[p.status]}"></i></span><em>${n} 条</em></div>`; }).join('');
}
let pjCat = null;   // 类别筛选已取消（11-16 用户：只归类、不展示类别墙），保留变量给轨道图用
let pjKey = '';
function renderProjects(force) {
  const all = state?.projects || [];
  if (pjCat && !all.some((p) => catOf(p) === pjCat)) pjCat = null;
  const ps = pjCat ? all.filter((p) => catOf(p) === pjCat) : all, by = (s) => ps.filter((p) => p.status === s);
  // 数据和展开状态都没变就不重画（每 5 秒一次的快照不该打断点击和滚动）；「几分钟前」按分钟刷新
  const key = JSON.stringify([all, [...pjOpen], pjCat, Math.floor(Date.now() / 60000), PH()]);
  if (!force && key === pjKey && $('pj-body').childElementCount) return;
  pjKey = key;
  const act = by('active'), done = by('done'), paused = by('paused'), arch = by('archived'), stale = by('stale');
  const today = act.concat(done, paused).filter((p) => (p.days || [])[13] > 0).length, live = ps.filter((p) => p.live).length;
  $('pj-sub').innerHTML = all.length ? `${pjCat ? `<b class="pj-sub-cat">${icon(pjCat, 15)}${CATS[pjCat][0]}</b> · ` : ''}进行中 <b>${act.length}</b> · 今天动过 <b>${today}</b> · <b>${live}</b> 个有会话在跑 · <span class="k">完成超过 3 天自动归档</span>` : '等 hub 扫完项目…';
  // 最近动态：各项目 logs.md 里带日期的标题（没有日志就用 progress.md 里带日期的条目），按天倒序
  const order = act.concat(done, paused), rank = new Map(order.map((p, i) => [p.id, i]));
  const evs = order.flatMap((p) => (p.recent || []).map((r, k) => ({ p, d: r.d, t: r.t, k }))).sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : rank.get(a.p.id) - rank.get(b.p.id) || a.k - b.k)).slice(0, 14);
  const dayLab = (ds) => { const n = Math.round((new Date(new Date().toDateString()) - new Date(`${ds}T00:00:00`)) / 864e5); return n <= 0 ? '今天' : n === 1 ? '昨天' : n < 7 ? `${n} 天前` : ds.slice(5).replace('-', '/'); };
  const groups = [];   // 同一天的条目放进一个块，分栏时不被拆开
  for (const e of evs) { const lab = dayLab(e.d); if (!groups.length || groups.at(-1).lab !== lab) groups.push({ lab, items: [] }); groups.at(-1).items.push(e); }
  const feed = groups.map((g) => `<div class="pj-day"><h4>${g.lab}</h4>${g.items.map((e) => `<p class="pj-ev is-${e.p.status}"><i title="${catName(e.p)}">${icon(catOf(e.p), 15)}</i><b>${esc(e.p.name)}</b><span>${esc(e.t)}</span></p>`).join('')}</div>`).join('');
  const rhythm = evs.length ? `<section class="pj-feed"><h3>最近动态<span>各项目日志里最近写下的事，按天倒序</span></h3><div class="pj-evs">${feed}</div></section>` : '';
  const grid = (list) => (list.length ? `<div class="pj-grid">${list.map(pjCard).join('')}</div>` : '');
  const fold = (id, title, list) => (list.length ? `<details class="pj-fold" data-fold="${id}"${pjOpen.has(id) ? ' open' : ''}><summary>${title} · ${list.length}</summary>${list.map(pjRow).join('')}</details>` : '');
  const body = $('pj-body'), sc = $('page-projects'), y = sc.scrollTop;
  const viz = all.length ? `<section class="pj-viz">
    <div class="pj-orbit"><h3>项目轨道<span>中心是今天，越靠近中心越是最近在做；星里的图标是项目类别</span></h3>${orbitSvg(all)}
      <p class="pj-legend"><span><i class="lg-near"></i>离中心越近 = 越近期动过</span><span><i class="lg-big"></i>星越大 = 14 天里日志越多</span><span><i class="lg-arc"></i>粗弧 = 完成比例</span><span><i class="lg-live"></i>向外扩散的光圈 = 有会话在跑</span><span><i class="lg-st" style="background:#3df2a4"></i>进行中</span><span><i class="lg-st" style="background:#8d9fbd"></i>搁置</span><span><i class="lg-st" style="background:#8fcfff"></i>刚完成</span><span><i class="lg-dim"></i>小灰点 = 归档 / 30 天没动</span></p>
      <div class="pj-tip" id="pj-tip" hidden></div></div>
    <div class="pj-side"><div class="pj-box"><h3>状态分布</h3>${donutSvg(ps)}</div>
      <div class="pj-box"><h3>本周最忙<span>最近 7 天日志条数</span></h3>${weekBars(ps)}</div></div></section>` : '';
  body.innerHTML = `${viz}
    ${act.length ? `<h2 class="pj-h">进行中</h2>${grid(act)}` : ''}
    ${done.length ? `<h2 class="pj-h">刚完成 · 3 天后进归档</h2>${grid(done)}` : ''}
    ${paused.length ? `<h2 class="pj-h">搁置 · 3–30 天没动</h2>${grid(paused)}` : ''}
    ${rhythm}
    ${fold('archived', '归档 · 完成超过 3 天', arch)}${fold('stale', '更早 · 30 天以上没动', stale)}`;
  sc.scrollTop = y;
}
document.addEventListener('click', (e) => {
  const cp = e.target.closest('[data-copy]');
  if (cp) {   // 复制文件夹路径；不展开卡片
    e.stopPropagation();
    const t = cp.dataset.copy, done = () => { cp.classList.add('is-copied'); cp.querySelector('span').textContent = '已复制'; setTimeout(() => { cp.classList.remove('is-copied'); cp.querySelector('span').textContent = '复制'; }, 1500); };
    (navigator.clipboard?.writeText(t) || Promise.reject()).then(done, () => { const r = document.createRange(); r.selectNodeContents(cp.querySelector('code')); getSelection().removeAllRanges(); getSelection().addRange(r); });
    return;
  }
  const nd = e.target.closest('[data-node]');
  if (nd) {
    const id = nd.dataset.node, p = (state?.projects || []).find((x) => x.id === id); if (!p) return;
    if (['archived', 'stale'].includes(p.status) && !pjOpen.has(p.status)) { pjOpen.add(p.status); renderProjects(true); }
    const el = document.querySelector(`.pj[data-pj="${CSS.escape(id)}"], .pj-row[data-pjrow="${CSS.escape(id)}"]`);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.remove('is-flash'); void el.offsetWidth; el.classList.add('is-flash'); }
    return;
  }
  const c = e.target.closest('.pj[data-pj]'); if (c) { const id = c.dataset.pj; pjOpen.has(id) ? pjOpen.delete(id) : pjOpen.add(id); renderProjects(true); }
});
document.addEventListener('toggle', (e) => { const f = e.target.closest?.('.pj-fold'); if (f) { f.open ? pjOpen.add(f.dataset.fold) : pjOpen.delete(f.dataset.fold); } }, true);

// ---------------- 启动 ----------------
function paint(next) {
  state = next; lastUpdate = Date.now();
  KEEP = (state.local_ai || []).filter((c) => c.switchable).map((c) => c.slot);
  scene?.update(state);
  renderKpis(); renderRail();
  if (!paint.inited) { paint.inited = true; requestAnimationFrame(() => updateInsets()); }
  if (view === 'models' && !holdRaf) renderModels();
  if (view === 'projects') renderProjects();
  if (drawerId) { if (machinesOf().some((m) => m.id === drawerId)) renderDrawer(); else closeDrawer(); }
  window.__appReady = true;
}
(async () => {
  const ld = document.createElement('div'); ld.className = 'loading'; ld.innerHTML = '<b>正在载入机库</b><span><i></i></span><em>0%</em>'; $('dashboard').append(ld);
  try {
    scene = await createScene($('stage'), { onHover: (id) => (id ? showHover(id) : hideHover()), onSelect: (id) => openDrawer(id), onEmpty: () => closeDrawer(), onViewChange: (moved) => { $('view-reset').hidden = !moved; },
      onProgress: (p) => { ld.querySelector('i').style.width = `${Math.round(p * 100)}%`; ld.querySelector('em').textContent = `${Math.round(p * 100)}%`; } });
  } catch (e) { ld.querySelector('b').textContent = '3D 机库加载失败，只显示数据'; console.warn(e); }
  ld.classList.add('is-done'); setTimeout(() => ld.remove(), 700);
  client = await connect({ onState: paint, onActions: (a) => { actions = a; if (view === 'models' && !holdRaf) renderModels(); }, onMode: (d) => { demo = d; } });
  const qv = location.hash.slice(1) || new URLSearchParams(location.search).get('view');
  const initial = qv === 'models' || qv === 'projects' ? qv : 'status';
  go(initial); moveInk();
  if (initial === 'status') setTimeout(() => showHint(PH() ? '单指拖动 360° 旋转 · 双指缩放平移 · 点机器看详情' : '拖动 360° 旋转 · 滚轮缩放 · 右键拖平移 · 双击复位', 'dashHint0'), 1800);
  window.__dash = { go, openDrawer, closeDrawer, step, screenOf: (id) => scene?.screenOf(id) };   // 截图验收用
  setInterval(() => { if (view === 'models' && actions.some((a) => a.status === 'running') && !holdRaf) renderModels(); }, 1000);
})();

document.addEventListener('mouseover', (e) => {
  const nd = e.target.closest?.('.pj-orbit [data-node]'), tip = $('pj-tip'); if (!tip) return;
  if (!nd) { tip.hidden = true; return; }
  const p = (state?.projects || []).find((x) => x.id === nd.dataset.node); if (!p) return;
  const pct = p.total ? `${Math.round(100 * p.done / p.total)}% · ${p.done}/${p.total} 项` : '没有待办清单';
  tip.innerHTML = `<b><span class="pj-ic sm">${icon(catOf(p), 14)}</span>${esc(p.name)}</b><em>${catName(p)} · ${PJ_WORD[p.status]} · ${ago(p.last)}</em><p>${intentOf(p)}</p><code>${esc(p.dir || p.path)}</code><span>${pct}${p.live ? ` · ${p.live} 个会话` : ''}</span>`;
  const box = nd.closest('.pj-orbit').getBoundingClientRect(), r = nd.getBoundingClientRect();
  tip.hidden = false;
  const x = Math.min(box.width - tip.offsetWidth - 8, Math.max(8, r.left - box.left + r.width / 2 - tip.offsetWidth / 2));
  const y = r.top - box.top - tip.offsetHeight - 12 < 30 ? r.bottom - box.top + 12 : r.top - box.top - tip.offsetHeight - 12;
  tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
});
addEventListener('resize', () => { if (view === 'projects') renderProjects(); });
