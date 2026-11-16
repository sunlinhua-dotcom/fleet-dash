/* Runtime state adapter. Only public snapshot fields reach the browser. */
const IN_FLIGHT = new Set(['queued', 'dispatched', 'running']);
const copy = (value) => JSON.parse(JSON.stringify(value));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export async function connect({ onState = () => {}, onActions = () => {}, onMode = () => {} } = {}) {
  let disposed = false;
  let demo = new URLSearchParams(location.search).get('mock') === '1';
  let snapshot;
  let source;
  let interval;
  let tick = 0;
  let actionSequence = 0;
  let actions = [];
  const timeouts = new Set();
  const controller = new AbortController();
  const emit = () => { if (!disposed && snapshot) onState(copy(snapshot)); };
  const mergeActions = (incoming) => {
    if (!Array.isArray(incoming)) return;
    for (const action of incoming) {
      if (!action || typeof action.aid !== 'string') continue;
      const at = actions.findIndex((existing) => existing.aid === action.aid);
      if (at < 0) actions.unshift(action);
      else actions[at] = { ...actions[at], ...action };
    }
    actions = actions.slice(0, 100);
    if (!disposed) onActions(copy(actions));
  };
  const accept = (payload) => {
    const data = Object.prototype.hasOwnProperty.call(payload || {}, 'snap') ? payload.snap : payload;
    if (!data || !Array.isArray(data.machines)) throw new Error('快照尚未就绪');
    const received = [payload.received_at, data.received_at, payload.ts, data.ts]
      .find((value) => Number.isFinite(value) && value > 0) || Date.now();
    const serverAge = payload.stale_s ?? data.stale_s;
    snapshot = {
      ...data,
      local_ai: Array.isArray(data.local_ai) ? data.local_ai : [],
      switch_options: Array.isArray(data.switch_options) ? data.switch_options : [],
      received_at: received,
      stale_s: Number.isFinite(serverAge) ? Math.max(0, serverAge) : Math.max(0, Math.floor((Date.now() - received) / 1000)),
    };
    mergeActions(payload.actions || []);
    emit();
  };
  const later = (fn, delay) => {
    const timer = setTimeout(() => { timeouts.delete(timer); if (!disposed) fn(); }, delay);
    timeouts.add(timer);
  };

  if (!demo) {
    const deadline = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch('/api/state', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('采集端暂时不可用');
      accept(await response.json());
    } catch {
      demo = true;
    } finally {
      clearTimeout(deadline);
    }
  }
  onMode(demo);

  if (demo) {
    const response = await fetch('./mock/state.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('演示数据加载失败');
    const data = await response.json();
    data.ts = Date.now();
    data.machines.forEach((machine) => { if (machine.online) machine.updated = data.ts; });
    accept({ snap: data, received_at: data.ts, stale_s: 0 });
    const baseline = copy(snapshot);
    interval = setInterval(() => {
      if (disposed) return;
      tick += 1;
      const now = Date.now();
      snapshot.ts = now;
      snapshot.received_at = now;
      snapshot.stale_s = 0;
      for (let i = 0; i < snapshot.machines.length; i += 1) {
        const machine = snapshot.machines[i];
        const base = baseline.machines[i];
        if (!machine.online) continue;
        const jitter = Math.sin(tick * 0.61 + i * 1.7);
        machine.temp_c = base.temp_c == null ? null : Math.round(clamp(base.temp_c + jitter * 1.2, 20, 95));
        for (const key of ['cpu_pct', 'mem_pct', 'gpu_pct']) {
          machine[key] = base[key] == null ? null : Math.round(clamp(base[key] + jitter * (key === 'mem_pct' ? 0.8 : 2.1), 0, 100));
        }
        machine.flow = clamp(base.flow + jitter * 0.025, 0, 1);
        machine.uptime_s = base.uptime_s + tick * 2;
        machine.updated = now;
        machine.gpus.forEach((gpu, index) => {
          gpu.temp_c = machine.temp_c - index * 2;
          gpu.util = clamp((machine.gpu_pct || 0) - index * 2, 0, 100);
        });
        if (tick % 30 === 0) machine.temp_hist = [...machine.temp_hist.slice(-44), machine.temp_c];
      }
      snapshot.hub.cpu_pct = Math.round(baseline.hub.cpu_pct + Math.sin(tick * 0.44) * 3);
      snapshot.hub.temp_c = Math.round(baseline.hub.temp_c + Math.sin(tick * 0.2));
      if (snapshot.headline) snapshot.headline.age_s = baseline.headline.age_s + tick * 2;
      emit();
    }, 2000);
  } else {
    let lastPush = 0;
    source = new EventSource('/api/stream');
    // EventSource owns its retry/backoff and resumes after transport interruptions.
    source.addEventListener('state', (event) => {
      lastPush = Date.now();
      try { accept(JSON.parse(event.data)); } catch { /* Keep the last valid snapshot. */ }
    });
    source.addEventListener('action', (event) => {
      lastPush = Date.now();
      try { mergeActions(JSON.parse(event.data)); } catch { /* Ignore malformed events. */ }
    });
    // 部署了新版本就自动刷新（挂在墙上 / 副屏的页面不用手动刷）
    setInterval(async () => {
      try {
        const b = await (await fetch('/build.json', { cache: 'no-store' })).json();
        if (b?.v && window.__build && b.v !== window.__build) location.reload();
      } catch { /* 忽略 */ }
    }, 60000);
    // 公网反向代理（多层 Caddy / CDN）可能把 SSE 正文缓冲住：推送 8 秒没动静就每 4 秒拉一次快照。
    let polling = false;
    interval = setInterval(async () => {
      if (disposed || polling || document.hidden || Date.now() - lastPush < 8000) return;
      polling = true;
      try {
        const response = await fetch('/api/state', { cache: 'no-store', redirect: 'manual' });
        if (response.type === 'opaqueredirect' || response.status === 401) { location.reload(); return; }
        if (response.ok) accept(await response.json());
      } catch { /* 下一轮再试 */ } finally { polling = false; }
    }, 4000);
    // The UI advances age locally. Emit only when a fresh snapshot arrives so
    // a timer cannot make unchanged collection data appear newly synchronized.
  }

  async function submit(optionId) {
    if (disposed) throw new Error('页面连接已关闭');
    const option = snapshot.switch_options.find((item) => item.id === optionId);
    if (!option) { const error = new Error('这个切换项不存在或已过期，刷新后再试'); error.status = 400; throw error; }
    if (demo) {
      if (actions.some((action) => action.machine === option.machine && IN_FLIGHT.has(action.status))) {
        const error = new Error(`${option.machine} 上一个切换还没完成`); error.status = 429; throw error;
      }
      const now = Date.now();
      const action = { aid: `mock-${now}-${++actionSequence}`, option: optionId, label: option.label, machine: option.machine, status: 'queued', created: now, updated: now, message: '等待派发' };
      const advance = (status, message) => {
        action.status = status;
        action.updated = Date.now();
        action.message = message;
        mergeActions([{ ...action }]);
      };
      mergeActions([{ ...action }]);
      later(() => advance('dispatched', '已派发到机器'), 2000);
      later(() => advance('running', '正在切换模型'), 2200);
      later(() => {
        const card = snapshot.local_ai.find((item) => item.machine === option.machine && Array.isArray(item.models) && item.models.some((model) => model.option === optionId || `${item.slot}:${model.id}` === optionId));
        if (card) {
          for (const model of card.models) {
            if (model.state === 'locked' || model.state === 'busy') continue;
            const ownOption = snapshot.switch_options.find((item) => item.id === `${card.slot}:${model.id}` || item.id === `${card.slot}:free`);
            const selected = model.option === optionId || `${card.slot}:${model.id}` === optionId;
            model.state = selected && !optionId.endsWith(':free') ? 'running' : 'idle';
            model.option = model.state === 'running' ? null : ownOption?.id || null;
          }
        }
        advance('done', optionId.endsWith(':free') ? '显存已释放' : '模型切换完成');
        emit();
      }, 6200);
      return { ...action };
    }
    const response = await fetch('/api/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ option: optionId, confirm: true }),
    });
    let result;
    try { result = await response.json(); } catch { result = {}; }
    if (response.status !== 202) {
      const error = new Error(result.error || `请求失败（${response.status}）`);
      error.status = response.status;
      throw error;
    }
    // The relay returns the public action directly; also accept an envelope.
    const accepted = result.action || result;
    mergeActions([accepted]);
    return accepted;
  }

  return {
    submit,
    dispose() {
      disposed = true;
      controller.abort();
      source?.close();
      clearInterval(interval);
      timeouts.forEach((timer) => clearTimeout(timer));
      timeouts.clear();
    },
  };
}
