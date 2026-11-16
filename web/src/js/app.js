// DASH v2 · 页面逻辑：状态页（3D 机库 + 大数字 + 注意栏 + 详情抽屉）、模型页（切换台 + 长按确认 + 进度时间线）
import { connect } from './data.js?v=__BUILD__';
import { createScene, statusOf, STATUS_COLOR } from './scene.js?v=__BUILD__';

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
  view = next === 'models' ? 'models' : 'status';
  document.body.dataset.view = view;
  document.querySelectorAll('.tabs button').forEach((b) => (b.dataset.go === view ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  moveInk();
  if (history.replaceState) history.replaceState(null, '', `#${view}${location.search ? '' : ''}`);
  scene?.setView(view); requestAnimationFrame(() => updateInsets());
  if (view === 'models') { closeDrawer(); renderModels(); if (opts.flash) flashSlot(opts.flash); }
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
  if (e.key === '1') go('status'); else if (e.key === '2') go('models');
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
  if (view === 'models') { scene.setInsets({ t: 0, r: 0, b: 0, l: 0 }, ms); return; }   // 模型页：宇宙中心虚化成整屏背景
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
  hc.innerHTML = `<h4>${esc(m.name)} · <span style="color:${STATUS_COLOR[statusOf(m)]}">${STATUS_WORD[statusOf(m)]}</span></h4>${bars(m)}${run.length ? `<div class="chips" style="margin-top:8px">${run.map((x) => `<span class="chip on">${esc(x)}</span>`).join('')}</div>` : ''}`;
  hc.hidden = false;
  const w = hc.offsetWidth, h = hc.offsetHeight;
  let x = r.right - host.left + 12, y = r.top - host.top - 4;
  if (x + w > host.width - 12) x = r.left - host.left - w - 12;
  y = Math.max(70, Math.min(host.height - h - 12, y));
  hc.style.left = `${x}px`; hc.style.top = `${y}px`;
}
function hideHover() { $('hovercard').hidden = true; }
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
function renderDrawer() {
  const id = drawerId, m = machinesOf().find((x) => x.id === id); if (!m) return;
  const st = statusOf(m), run = runningOf(id), hist = (m.temp_hist || []).filter((v) => v != null);
  const slot = m.kind === 'gb10' ? 'spark' : KEEP.includes(id) ? id : null;
  let spark = '';
  if (hist.length > 1) {
    const lo = Math.min(...hist) - 2, hi = Math.max(...hist) + 2, W = 340, H = 64;
    const pts = hist.map((v, i) => `${(i / (hist.length - 1) * W).toFixed(1)},${(H - (v - lo) / (hi - lo || 1) * (H - 8) - 4).toFixed(1)}`).join(' ');
    spark = `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${STATUS_COLOR[st]}" stroke-width="1.6"/></svg><div class="dr-role">${hist.length} 分钟 · ${Math.round(Math.min(...hist))}° ~ ${Math.round(Math.max(...hist))}°</div>`;
  }
  const list = machinesOf(), idx = list.findIndex((x) => x.id === id), dr = $('drawer'), keep = dr.scrollTop;
  dr.innerHTML = `<i class="dr-grab" data-grab aria-hidden="true"></i>
    <div class="dr-nav"><button type="button" data-step="-1" aria-label="上一台">‹</button><span>${idx + 1} / ${list.length}</span><button type="button" data-step="1" aria-label="下一台">›</button></div>
    <button class="dr-x" type="button" aria-label="关闭" data-close>×</button>
    <p class="dr-k">${esc((state.sites || []).find((s) => s.id === m.site)?.name || '')} · ${esc(STATUS_WORD[st])}</p>
    <h2 class="dr-name">${esc(m.name)}</h2><p class="dr-role">${esc(m.role || '')}${m.uptime_s ? ` · 已运行 ${age(m.uptime_s)}` : ''}</p>
    <div class="dr-temp" style="--c:${STATUS_COLOR[st]}"><b>${m.online ? num(m.temp_c) : '—'}°</b><span>${m.online ? '当前最高温度' : esc(m.error || '连不上')}</span></div>
    ${m.online ? bars(m) : ''}
    ${(m.gpus || []).length ? `<div class="dr-sec"><h5>显卡</h5>${m.gpus.map((g) => `<div class="gpu-row"><b>${esc(g.name)}</b><span>${num(g.temp_c)}° · ${num(g.power_w)} W</span><span>利用率 ${num(g.util)}% · 显存 ${num(g.mem_pct)}%</span><span>${g.vram_gb ? `${g.vram_gb} GB` : ''}</span></div>`).join('')}</div>` : ''}
    ${spark ? `<div class="dr-sec"><h5>最近温度</h5>${spark}</div>` : ''}
    <div class="dr-sec"><h5>正在跑</h5><div class="chips">${run.length ? run.map((x) => `<span class="chip on">${esc(x)}</span>`).join('') : '<span class="chip">没有登记的模型服务</span>'}</div></div>
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

// ---------------- 启动 ----------------
function paint(next) {
  state = next; lastUpdate = Date.now();
  KEEP = (state.local_ai || []).filter((c) => c.switchable).map((c) => c.slot);
  scene?.update(state);
  renderKpis(); renderRail();
  if (!paint.inited) { paint.inited = true; requestAnimationFrame(() => updateInsets()); }
  if (view === 'models' && !holdRaf) renderModels();
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
  const initial = location.hash === '#models' || new URLSearchParams(location.search).get('view') === 'models' ? 'models' : 'status';
  go(initial); moveInk();
  if (initial === 'status') setTimeout(() => showHint(PH() ? '单指拖动 360° 旋转 · 双指缩放平移 · 点机器看详情' : '拖动 360° 旋转 · 滚轮缩放 · 右键拖平移 · 双击复位', 'dashHint0'), 1800);
  window.__dash = { go, openDrawer, closeDrawer, step, screenOf: (id) => scene?.screenOf(id) };   // 截图验收用
  setInterval(() => { if (view === 'models' && actions.some((a) => a.status === 'running') && !holdRaf) renderModels(); }, 1000);
})();
