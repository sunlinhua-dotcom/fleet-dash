# Data contract & hub config

Three pieces talk to each other:

```
 machines ──ssh / PowerShell──▶ hub (hub/hub.py) ──POST /ingest/snapshot──▶ relay (relay/relay.mjs) ──/api/state + SSE──▶ browser (web/)
                                   ▲                                          │
                                   └──── GET /ingest/actions (long poll) ◀────┘◀── POST /api/action {option, confirm}
```

- The **hub** pushes a snapshot every 5 s (`Authorization: Bearer <HUB_TOKEN>`).
- The **browser** reads `GET /api/state` once, then follows `GET /api/stream` (SSE events `state` and `action`).
- A switch request is `POST /api/action {"option": "<id>", "confirm": true}`. The relay only accepts option ids that the latest snapshot published; the real command lives only in the hub's `fleet.json`.

Timestamps are milliseconds. Percentages are 0–100. Temperatures are °C. Unknown values are `null` (the UI shows "—"); never invent numbers.

## Snapshot

```jsonc
{
  "v": 1,
  "ts": 1794754844371,
  "hub": { "id": "hub", "name": "MacBook Pro", "chip": "M3 Pro", "cpu_pct": 44, "mem_pct": 73, "temp_c": null },
  "headline": { "text": "A100 ×4 · 4×A100 40G", "machine": "a100", "age_s": null },  // the pill at the top; may be null
  "sites": [
    { "id": "home", "name": "家里", "wan": { "down_mbps": 94.8, "up_mbps": 28.6 }, "note": "GB10 集群" }
  ],
  "machines": [
    {
      "id": "spark-a", "name": "Spark A", "site": "home",
      "kind": "gb10",                    // mac | linux | windows | gb10 | server | vps  (GB10s on one site form a cluster ring)
      "model": "spark_asus",             // optional: which 3D model to draw, see "3D models" below
      "role": "GB10 · 集群",              // one line of small text
      "online": true,
      "status": "busy",                  // normal | busy | warm | hot | asleep | offline  (drives the colour)
      "temp_c": 63, "cpu_pct": 20, "mem_pct": 85, "disk_pct": 46, "gpu_pct": 100, "uptime_s": 86400,
      "gpus": [ { "idx": 0, "name": "GB10", "vram_gb": 128, "util": 100, "mem_pct": 85, "temp_c": 63, "power_w": 90 } ],
      "temp_hist": [61, 62, 63],         // last 45 minutes, one point per minute, at most 45
      "flow": 0.8,                       // 0–1, thickness of the light fibre into the centre
      "probe_ms": 420, "updated": 1794754844000, "error": null,
      "mem_total_gb": 128,
      "procs": [                         // up to 8, grouped by readable name, biggest first; model = it's the model service
        { "name": "vLLM :8000", "ram_gb": 1.1, "vram_gb": 103.5, "n": 1, "model": true },
        { "name": "Chrome", "ram_gb": 2.7, "vram_gb": 1.6, "n": 7, "model": false }
      ]
    }
  ],
  "local_ai": [                          // one card per GPU box (or cluster) on the model page
    {
      "machine": "ws-2080", "slot": "ws-2080", "label": "双 RTX 2080 Ti · 44G",
      "switchable": true,                // shown as a switch card; otherwise listed read-only
      "models": [
        { "id": "qwen27b",   "name": "Qwen3.8 27B",        "state": "running", "option": null },
        { "id": "flashnext", "name": "Qwen3.8 Flash-Next", "state": "idle",    "option": "ws-2080:flashnext" }
      ]
    },
    { "machine": "a100", "slot": "a100", "label": "4×A100 · 40G", "kind": "gpus",   // read-only per-GPU board
      "models": [ { "id": "gpu0", "name": "GPU0 · A100", "state": "busy", "option": null } ] }
  ],
  "switch_options": [
    { "id": "ws-2080:flashnext", "machine": "ws-2080", "label": "2080 双卡切到 Flash-Next",
      "confirm": "会停掉正在跑的 27B（约 2 分钟不可用）", "eta_s": 120 }
  ],
  "claude": {                            // optional feeds, see "feeds" below
    "sessions": [ { "title": "DASH · 机队仪表盘", "project": "fleet-dash", "age_s": 60 } ],
    "tasks":    [ { "title": "整理资料", "runner": "a100", "status": "running", "age_s": 300 } ]
  },
  "queue": [ { "title": "视频 · 第 12 镜", "machine": "a100", "kind": "video", "state": "running", "age_s": 120 } ],
  "projects": [                          // optional (hub config "projects"); omit the key to hide the data
    { "id": "1f00", "name": "home-fleet-dash", "path": "~/code/home-fleet-dash", "dir": "~/code/home-fleet-dash",
      "intent": "one line: what this project is for", "cat": "dashboard",   // cat = icon key, see web/src/js/icons.js
      "status": "active",                // active | done | paused | archived | stale
      "last": 1794754800000, "done": 12, "total": 16, "live": 1, "live_busy": 1,
      "milestone": "…", "next": ["…"], "days": [0,1,2,0,0,3,1,0,0,2,1,4,2,3],   // days: 14 counts, oldest → today
      "recent": [ { "d": "2026-11-16", "t": "what was done" } ] }
  ],
  "projects_meta": { "scanned_at": 1794754844000, "roots": ["~/code"], "count": 23 },
  "decide_pending": 0,                   // number of queue items waiting for you
  "alerts": [ { "level": "hot", "machine": "a100", "text": "GPU2 温度 88℃" } ]
}
```

### Colours

- Machine `status`: normal = ice blue, busy = mint, warm = amber, hot = red, asleep / offline = grey.
- Model `state`: `running` (in use), `idle` (can switch to it), `asleep` (service not up but startable), `busy` (taken by someone else, not clickable), `locked` (protected service: shown, never switched).
- A model is clickable only when `option` is set. The UI asks for a 1-second press-and-hold, then sends `{option, confirm: true}`; the action moves through `queued → dispatched → running → done / failed` and comes back over SSE.

## Hub config (`hub/fleet.json`)

Start from `hub/fleet.example.json`.

| key | meaning |
|---|---|
| `hub` | `name`, `chip` shown in the centre; `iface` = network interface for WAN throughput (macOS) |
| `sites[]` | `id`, `name`. Built-in island positions exist for `home`, `campus`, `cloud`, `partner`; other ids get spare slots |
| `machines[]` | `id`, `name`, `site`, `kind`, `role`, `model` (3D model), `probe` (`linux` / `mac` / `win` / `amd`), `cmd` (how to reach it), `every` (seconds), `timeout` |
| `cards[]` | model cards, see below |
| `switch[]` | whitelisted commands: `id`, `card`, `model`, `machine`, `label`, `confirm`, `eta_s`, `run` (argv), optional `kind: "free"` (a "release VRAM" action), optional `exit_reasons` (`{"75": "busy, refused"}`) |
| `feeds` | optional: `sessions`, `tasks`, `queue` = `"claude-code"` (built-in, sessions only) or an argv that prints a JSON array |
| `projects` | optional: `{"roots": ["~/code"], "depth": 4}`. Every folder under the roots with a `progress.md` is a project. Intent comes from `context.md` (`目标：` / `Goal:` line, or the overview section), else README / HANDOFF / CLAUDE.md. Progress = checked / all `- [ ]` todos in progress.md; activity = dated headings in logs.md. Status: active ≤ 3 days or a live Claude Code session in the folder, paused 3–30 days, stale > 30 days, done when progress.md says 已完成 / 结项 (or every todo is checked), archived 3 days after done. Category: keyword rules in hub.py, overridable per path in `hub/project_cats.json` (`{"cats": {"~/code/x": "video"}, "intents": {...}, "names": {...}}`) |

**`cmd`** is any argv that accepts a shell script on stdin: `["ssh", "my-box"]`, a wrapper script, or `["local"]` for the hub itself. For `win` / `amd` probes the PowerShell one-liner is appended as the last argument (e.g. `["ssh", "win-box"]` with OpenSSH on Windows defaulting to PowerShell).

**Probes** are plain scripts (no agent to install): CPU, memory, disk, uptime, temperatures, `nvidia-smi` GPUs, and listening TCP ports. `amd` adds Windows GPU counters for integrated Radeon; set `gpu_name` and `vram_gb` on the machine.

**Card sources**

- `ports` (default): each model has a `port`; it counts as running when that port is listening on the machine. Add `"locked": "reason"` for services you never want switched.
- `command`: `status_cmd` prints `{"mode": "...", "switching": false}`; each model names the `mode` it represents. Good for clusters that switch as a whole.
- `gpus`: read-only, one entry per GPU from the probe (busy above 5 % utilisation).

## 3D models

`web/assets/models/fleet_assets.glb` holds these models, generated by `assets3d/build_assets.py` in Blender:

`spark_asus`, `spark_msi`, `spark_dell` (GB10 mini PCs), `server_a100`, `tower_4080`, `tower_white_4060`, `tower_dual_2080`, `tower_titan`, `tower_3090ti`, `bench_dual_2080`, `rog_z13`, `mac_mini`, `cloud_blade`, `macbook_pro`.

Set `model` per machine. Without it the UI falls back by `kind` (`gb10 → spark_dell`, `server → server_a100`, `windows → tower_4080`, `linux → tower_dual_2080`, `mac → mac_mini`).
