#!/usr/bin/env python3
"""DASH hub — collects fleet state on one always-on machine and pushes it to the relay.

It also long-polls the relay for switch requests made in the web UI and runs ONLY the
commands whitelisted in fleet.json (the browser and the relay only ever see option ids).

Usage:
  python3 hub.py --once      probe once, print the snapshot JSON, exit (debug)
  python3 hub.py --no-push   keep probing, print a one-line summary every 5 s
  python3 hub.py --dry       push snapshots but never run switch commands
  python3 hub.py             normal mode (needs FLEETDASH_RELAY + token)

Config: fleet.json next to this file (copy fleet.example.json). Edits are picked up live.
Token:  env FLEETDASH_TOKEN, or ~/.config/fleetdash/hub_token (>= 32 chars, same as relay HUB_TOKEN).
"""
import argparse
import concurrent.futures as cf
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

HOME = Path.home()
DIR = Path(__file__).resolve().parent
CFG = Path(os.environ.get("FLEETDASH_CONFIG", DIR / "fleet.json"))
STATE = Path(os.environ.get("FLEETDASH_STATE", HOME / ".local/state/fleetdash"))
STATE.mkdir(parents=True, exist_ok=True)
RELAY = os.environ.get("FLEETDASH_RELAY", "http://127.0.0.1:8941").rstrip("/")
_TOKEN_F = HOME / ".config/fleetdash/hub_token"
TOKEN = os.environ.get("FLEETDASH_TOKEN") or (_TOKEN_F.read_text().strip() if _TOKEN_F.exists() else "")
LOCK = threading.Lock()


def log(*a):
    print(time.strftime("[%H:%M:%S]"), *a, flush=True)


# ------------------------------------------------------------------ probe scripts (key=value lines)
LINUX = r"""
s1=$(awk '/^cpu /{print $2+$3+$4+$5+$6+$7+$8, $5+$6}' /proc/stat); sleep 0.4
s2=$(awk '/^cpu /{print $2+$3+$4+$5+$6+$7+$8, $5+$6}' /proc/stat)
echo "$s1 $s2" | awk '{dt=$3-$1; di=$4-$2; printf "cpu_pct=%.0f\n", (dt>0)?100*(dt-di)/dt:0}'
awk '/MemTotal/{t=$2}/MemAvailable/{a=$2}END{printf "mem_total_kb=%d\nmem_avail_kb=%d\n",t,a}' /proc/meminfo
echo "load1=$(cut -d' ' -f1 /proc/loadavg)"
echo "uptime_s=$(cut -d. -f1 /proc/uptime)"
df -P / | awk 'NR==2{gsub("%","",$5); print "disk_pct="$5}'
t=$(cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null | sort -n | tail -1); [ -n "$t" ] && echo "cpu_temp_mc=$t"
command -v nvidia-smi >/dev/null && nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw --format=csv,noheader,nounits 2>/dev/null | sed 's/^/gpu=/'
printf "ports="; (ss -ltnH 2>/dev/null | awk '{n=split($4,a,":"); print a[n]}') | sort -un | tr '\n' ' '; echo
"""

WIN = ("$ErrorActionPreference='SilentlyContinue';"
       "$c=(Get-CimInstance Win32_Processor|Measure-Object -Property LoadPercentage -Average).Average;"
       "$o=Get-CimInstance Win32_OperatingSystem;"
       "Write-Output ('cpu_pct='+[int]$c);Write-Output ('mem_total_kb='+$o.TotalVisibleMemorySize);"
       "Write-Output ('mem_avail_kb='+$o.FreePhysicalMemory);"
       "Write-Output ('uptime_s='+[int]((Get-Date)-$o.LastBootUpTime).TotalSeconds);"
       "$d=Get-CimInstance Win32_LogicalDisk|Where-Object {$_.DeviceID -eq 'C:'};"
       "Write-Output ('disk_pct='+[int](100-100*$d.FreeSpace/$d.Size));"
       "%EXTRA%"
       "Write-Output ('ports='+((Get-NetTCPConnection -State Listen|Select-Object -ExpandProperty LocalPort|Sort-Object -Unique) -join ' '))")
WIN_NV = ("nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw "
          "--format=csv,noheader,nounits|ForEach-Object {'gpu='+$_};")
WIN_AMD = ("$m=((Get-Counter '\\GPU Adapter Memory(*)\\Dedicated Usage').CounterSamples|Measure-Object -Property CookedValue -Maximum).Maximum;"
           "Write-Output ('amd_vram_b='+[int64]$m);"
           "$u=((Get-Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage').CounterSamples|Measure-Object -Property CookedValue -Sum).Sum;"
           "Write-Output ('amd_util='+[int]$u);"
           "$z=(Get-CimInstance -Namespace root/wmi MSAcpi_ThermalZoneTemperature|Measure-Object -Property CurrentTemperature -Maximum).Maximum;"
           "Write-Output ('acpi_dk='+$z);")

MAC = r"""
n=$(sysctl -n hw.ncpu); echo "cpu_pct=$(ps -A -o %cpu= | awk -v n=$n '{s+=$1}END{printf "%.0f", s/n}')"
mt=$(sysctl -n hw.memsize); pg=$(sysctl -n hw.pagesize)
vm_stat | awk -v pg=$pg -v mt=$mt '/Pages free/{f=$3}/Pages inactive/{i=$3}/Pages speculative/{s=$3}/Pages purgeable/{p=$3}END{gsub(/\./,"",f);gsub(/\./,"",i);gsub(/\./,"",s);gsub(/\./,"",p);printf "mem_total_kb=%d\nmem_avail_kb=%d\n", mt/1024, (f+i+s+p)*pg/1024}'
echo "load1=$(sysctl -n vm.loadavg | awk '{print $2}')"
bt=$(sysctl -n kern.boottime | sed -E 's/.*sec = ([0-9]+).*/\1/'); echo "uptime_s=$(( $(date +%s) - bt ))"
df -P /System/Volumes/Data 2>/dev/null | awk 'NR==2{gsub("%","",$5); print "disk_pct="$5}'
pmset -g therm 2>/dev/null | awk -F'= ' '/CPU_Speed_Limit/{print "speed_limit="$2}'
echo "ports=$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1{n=split($9,a,":"); print a[n]}' | sort -un | tr '\n' ' ')"
"""


def run(cmd, timeout=25, stdin=None):
    """Run a command, return (rc, stdout, stderr); timeout gives rc=124."""
    try:
        p = subprocess.run(cmd, input=stdin, capture_output=True, text=True, timeout=timeout, errors="replace")
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "timeout"
    except Exception as e:  # noqa: BLE001
        return 127, "", str(e)


def last_json(text):
    """Last line of `text` that parses as JSON (commands may print logs before it)."""
    for line in reversed(text.splitlines()):
        line = line.strip()
        if line[:1] in "{[":
            try:
                return json.loads(line)
            except ValueError:
                pass
    return None


def kv(text):
    out, gpus = {}, []
    for line in text.replace("\r", "").splitlines():
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        if k == "gpu":
            gpus.append(v.strip())
        elif re.fullmatch(r"[a-z_0-9]+", k):
            out[k] = v.strip()
    out["_gpus"] = gpus
    return out


def num(x, d=None):
    try:
        return float(str(x).strip().replace("[N/A]", "").replace("N/A", ""))
    except (TypeError, ValueError):
        return d


def parse_gpus(lines):
    gs = []
    for l in lines:
        p = [x.strip() for x in l.split(",")]
        if len(p) < 7:
            continue
        mu, mt = num(p[2]), num(p[3])
        gs.append({"idx": int(num(p[0], 0)), "name": p[1].replace("NVIDIA ", "").replace("GeForce ", ""),
                   "vram_gb": round(mt / 1024) if mt else None,
                   "mem_pct": round(100 * mu / mt) if (mu is not None and mt) else None,
                   "util": num(p[4]), "temp_c": num(p[5]), "power_w": num(p[6])})
    return gs


# ------------------------------------------------------------------ per-machine probe
def probe(m):
    t0 = time.time()
    kind = m["probe"]
    to = m.get("timeout", 25)
    local = m.get("cmd") == ["local"]
    if kind == "linux":
        rc, out, err = run(["bash", "-s"] if local else m["cmd"] + ["bash", "-s"], timeout=to, stdin=LINUX)
    elif kind == "mac":
        rc, out, err = run(["bash", "-s"] if local else m["cmd"] + ["bash", "-s"], timeout=to, stdin=MAC)
    elif kind in ("win", "amd"):
        ps = WIN.replace("%EXTRA%", WIN_AMD if kind == "amd" else WIN_NV)
        rc, out, err = run(m["cmd"] + [ps], timeout=to)
    else:
        return {"error": f"unknown probe {kind}"}
    d = kv(out)
    ms = int((time.time() - t0) * 1000)
    if "cpu_pct" not in d and "mem_total_kb" not in d:
        msg = (err or out or f"rc={rc}").strip().splitlines()
        return {"online": False, "error": (msg[-1] if msg else f"rc={rc}")[:160], "probe_ms": ms}
    r = {"online": True, "probe_ms": ms, "error": None,
         "cpu_pct": num(d.get("cpu_pct")), "uptime_s": num(d.get("uptime_s")), "disk_pct": num(d.get("disk_pct"))}
    mt, ma = num(d.get("mem_total_kb")), num(d.get("mem_avail_kb"))
    r["mem_pct"] = round(100 * (mt - ma) / mt) if (mt and ma is not None) else None
    r["gpus"] = parse_gpus(d["_gpus"])
    r["ports"] = sorted({int(x) for x in d.get("ports", "").split() if x.isdigit()})
    cpu_t = num(d.get("cpu_temp_mc"))
    r["cpu_temp_c"] = round(cpu_t / 1000) if cpu_t else None
    if kind == "amd":   # integrated AMD GPU: name / VRAM come from fleet.json
        vb, dk, vram = num(d.get("amd_vram_b")), num(d.get("acpi_dk")), m.get("vram_gb") or 16
        r["gpus"] = [{"idx": 0, "name": m.get("gpu_name", "AMD GPU"), "vram_gb": vram, "util": min(100, num(d.get("amd_util"), 0)),
                      "mem_pct": round(100 * vb / (vram * 2**30)) if vb else None, "temp_c": None, "power_w": None}]
        r["cpu_temp_c"] = round(dk / 10 - 273.15) if dk else None
    if d.get("speed_limit"):
        r["speed_limit"] = num(d["speed_limit"])
    return r


# ------------------------------------------------------------------ optional feeds
_net = {"t": 0, "ib": 0, "ob": 0, "down": None, "up": None}


def mac_net(iface="en0"):
    """Hub's own WAN throughput (macOS netstat), shown as the hub site's down / up."""
    rc, out, _ = run(["netstat", "-ib", "-I", iface], timeout=5)
    for line in out.splitlines()[1:]:
        p = line.split()
        if len(p) >= 10 and p[0] == iface and p[2].startswith("<Link"):
            ib, ob, now = int(p[6]), int(p[9]), time.time()
            if _net["t"]:
                dt = now - _net["t"]
                _net["down"] = round((ib - _net["ib"]) * 8 / dt / 1e6, 2)
                _net["up"] = round((ob - _net["ob"]) * 8 / dt / 1e6, 2)
            _net.update(t=now, ib=ib, ob=ob)
            break
    return _net["down"], _net["up"]


def claude_code_sessions():
    """Live Claude Code sessions on this machine (reads ~/.claude/sessions/*.json, skips dead pids)."""
    out = []
    for f in (HOME / ".claude/sessions").glob("*.json"):
        try:
            j = json.loads(f.read_text())
            os.kill(int(j.get("pid") or 0), 0)
        except (OSError, ValueError):
            continue
        upd = j.get("updatedAt") or j.get("statusUpdatedAt") or 0
        out.append({"title": (j.get("name") or Path(j.get("cwd", "")).name or "未命名会话")[:60],
                    "project": Path(j.get("cwd", "")).name, "status": j.get("status", "idle"),
                    "age_s": int(time.time() - upd / 1000) if upd else None})
    out.sort(key=lambda x: (x["status"] != "busy", x["age_s"] if x["age_s"] is not None else 1e9))
    return out


def feed(spec):
    """A feed is "claude-code" (built-in) or a command printing a JSON array (see docs/data-contract.md)."""
    if spec == "claude-code":
        return claude_code_sessions()
    if isinstance(spec, list):
        rc, out, _ = run(spec, timeout=30)
        j = last_json(out)
        return j if isinstance(j, list) else None
    return None


# ------------------------------------------------------------------ snapshot
HIST_F = STATE / "temp_hist.json"
try:
    HIST = json.loads(HIST_F.read_text())
except (OSError, ValueError):
    HIST = {}
LAST = {}          # machine id -> last probe result
EXTRA = {}         # feeds, card status commands, hub network
SEEN = set()       # switch aids already taken (relay resends until it hears "running")


def status_of(r, temp):
    if not r or not r.get("online"):
        return "offline"
    if temp is not None and temp >= 85:
        return "hot"
    if temp is not None and temp >= 75:
        return "warm"
    g = max([x.get("util") or 0 for x in r.get("gpus", [])] or [0])
    if g >= 40 or (r.get("cpu_pct") or 0) >= 70:
        return "busy"
    return "normal"


def build(cfg):
    now = time.time()
    machines, alerts = [], []
    for m in cfg["machines"]:
        r = LAST.get(m["id"], {})
        gpus = r.get("gpus") or []
        temps = [g["temp_c"] for g in gpus if g.get("temp_c") is not None]
        temp = max(temps) if temps else r.get("cpu_temp_c")
        gpu_pct = max([g.get("util") or 0 for g in gpus]) if gpus else None
        st = status_of(r, temp)
        load = max(gpu_pct or 0, r.get("cpu_pct") or 0) / 100
        if st == "hot":
            alerts.append({"level": "hot", "machine": m["id"], "text": f"{m['name']} {int(temp)}℃"})
        machines.append({
            "id": m["id"], "name": m["name"], "site": m["site"], "kind": m["kind"], "role": m.get("role", ""),
            **({"model": m["model"]} if m.get("model") else {}),
            "online": bool(r.get("online")), "status": st, "temp_c": temp, "cpu_pct": r.get("cpu_pct"),
            "mem_pct": r.get("mem_pct"), "disk_pct": r.get("disk_pct"), "gpu_pct": gpu_pct, "uptime_s": r.get("uptime_s"),
            "gpus": [{k: g.get(k) for k in ("idx", "name", "vram_gb", "util", "mem_pct", "temp_c", "power_w")} for g in gpus],
            "temp_hist": HIST.get(m["id"], [])[-45:], "flow": round(0.15 + 0.85 * load, 2) if r.get("online") else 0.05,
            "probe_ms": r.get("probe_ms"), "updated": int(r.get("_t", 0) * 1000), "error": r.get("error"),
        })
    # model cards
    busy_machines = set(EXTRA.get("busy_machines", []))
    switch = cfg.get("switch", [])
    by_card = {}
    for o in switch:
        by_card.setdefault((o["card"], o["model"]), o)
    cards = []
    for c in cfg.get("cards", []):
        r = LAST.get(c["machine"], {})
        online = bool(r.get("online"))
        ports = set(r.get("ports") or [])
        models, src = [], c.get("source", "ports")
        if src == "command":
            # status_cmd prints {"mode": "...", "switching": false}; each model names the mode it represents
            q = EXTRA.get(("card", c["slot"])) or {}
            cur = q.get("mode")
            for x in c.get("models", []):
                running = cur == x.get("mode")
                o = by_card.get((c["slot"], x["id"]))
                models.append({"id": x["id"], "name": x["name"], "state": "running" if running else "idle",
                               "option": (o["id"] if (o and online and not running and not q.get("switching")) else None)})
            if q.get("switching"):
                models.insert(0, {"id": "_switching", "name": "正在切档…", "state": "busy", "option": None})
        elif src == "gpus":
            # read-only: one entry per GPU of the machine
            for g in r.get("gpus") or []:
                busy = (g.get("util") or 0) > 5
                models.append({"id": f"gpu{g.get('idx')}", "name": f"GPU{g.get('idx')} · {g.get('name') or ''}".strip(" ·"),
                               "state": "busy" if busy else "running", "option": None})
        else:
            # "ports": a model counts as running when its port is listening on the machine
            for x in c.get("models", []):
                running = x.get("port") in ports
                o = by_card.get((c["slot"], x["id"]))
                state = "locked" if x.get("locked") else "running" if running else ("idle" if o else "asleep")
                opt = None
                if o and online and x.get("locked") is None:
                    if o.get("kind") == "free":
                        opt = o["id"] if running else None
                    elif not running:
                        opt = o["id"]
                models.append({"id": x["id"], "name": x["name"], "state": state, "option": opt,
                               **({"note": x["locked"] + (" · 在线" if running else " · 未在监听"), "up": running} if x.get("locked") else {}),
                               **({"action": "释放显存"} if (o and o.get("kind") == "free" and running) else {})})
        if c["machine"] in busy_machines:
            for x in models:
                x["option"] = None
        cards.append({"machine": c["machine"], "slot": c["slot"], "label": c.get("label", ""), "online": online, "models": models,
                      "switchable": any(o["card"] == c["slot"] for o in switch), **({"kind": "gpus"} if src == "gpus" else {})})
    switch_options = [{"id": o["id"], "machine": o["machine"], "label": o["label"], "confirm": o.get("confirm"),
                       "eta_s": o.get("eta_s")} for o in switch]
    queue = list(EXTRA.get("queue") or [])[:12]
    hot = sorted([m for m in machines if m["online"] and m["temp_c"] is not None], key=lambda m: -m["temp_c"])
    headline = None
    if hot:
        h = hot[0]
        headline = {"text": f"{h['name']} · {h['role']}", "machine": h["id"], "age_s": None, "temp_c": h["temp_c"]}
    hubr = LAST.get("_hub", {})
    down, up = EXTRA.get("net", (None, None))
    hub = cfg.get("hub", {})
    return {
        "v": 1, "ts": int(now * 1000),
        "hub": {"id": "hub", "name": hub.get("name", "Hub"), "chip": hub.get("chip"), "cpu_pct": hubr.get("cpu_pct"),
                "mem_pct": hubr.get("mem_pct"), "temp_c": None, "speed_limit": hubr.get("speed_limit")},
        "headline": headline,
        "sites": [{**s, "wan": None} for s in cfg["sites"]] + [{"id": "hub", "name": "本机", "wan": {"down_mbps": down, "up_mbps": up}}],
        "machines": machines, "local_ai": cards, "switch_options": switch_options,
        "claude": {"sessions": (EXTRA.get("sessions") or [])[:12], "tasks": (EXTRA.get("tasks") or [])[:12]},
        "queue": queue, "decide_pending": sum(1 for q in queue if q.get("state") == "needs_you"), "alerts": alerts,
    }


# ------------------------------------------------------------------ loops
def http(method, path, body=None, timeout=30):
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    req = urllib.request.Request(RELAY + path, data=data, method=method,
                                 headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json",
                                          "User-Agent": "fleetdash-hub/1"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


def load_cfg():
    return json.loads(CFG.read_text())


def hub_probe_spec():
    return {"id": "_hub", "probe": "mac" if sys.platform == "darwin" else "linux", "cmd": ["local"], "every": 5}


def probe_loop(cfg_ref, stop):
    due = {}
    with cf.ThreadPoolExecutor(max_workers=16) as ex:
        futs = {}
        while not stop.is_set():
            cfg = cfg_ref[0]
            now = time.time()
            for m in cfg["machines"] + [hub_probe_spec()]:
                mid = m["id"]
                if mid in futs or now < due.get(mid, 0):
                    continue
                futs[mid] = ex.submit(probe, m)
                due[mid] = now + m.get("every", 10)
            for mid, f in list(futs.items()):
                if f.done():
                    try:
                        r = f.result()
                    except Exception as e:  # noqa: BLE001
                        r = {"online": False, "error": str(e)[:160]}
                    r["_t"] = time.time()
                    with LOCK:
                        # one failed probe doesn't flip a machine offline: keep the previous result for 60 s
                        prev = LAST.get(mid)
                        if not r.get("online") and prev and prev.get("online") and time.time() - prev.get("_t", 0) < 60:
                            prev["error"] = r.get("error")
                        else:
                            LAST[mid] = r
                    del futs[mid]
            stop.wait(0.5)


def slow_loop(cfg_ref, stop):
    n, due = 0, {}
    while not stop.is_set():
        cfg = cfg_ref[0]
        try:
            if sys.platform == "darwin":
                EXTRA["net"] = mac_net(cfg.get("hub", {}).get("iface", "en0"))
            for name, spec in (cfg.get("feeds") or {}).items():
                if time.time() >= due.get(name, 0):
                    due[name] = time.time() + 15
                    v = feed(spec)
                    if v is not None:
                        EXTRA[name] = v
            for c in cfg.get("cards", []):
                if c.get("source") == "command" and c.get("status_cmd"):
                    k = ("card", c["slot"])
                    if time.time() >= due.get(k, 0):
                        due[k] = time.time() + c.get("every", 30)
                        rc, out, _ = run(c["status_cmd"], timeout=c.get("timeout", 60))
                        j = last_json(out)
                        if isinstance(j, dict):
                            EXTRA[k] = j
            if n % 12 == 0:   # temperature history: one point per minute, 45 points
                with LOCK:
                    for mid, r in LAST.items():
                        gs = r.get("gpus") or []
                        t = max([g["temp_c"] for g in gs if g.get("temp_c") is not None] or [r.get("cpu_temp_c") or 0]) or None
                        if r.get("online") and t:
                            HIST.setdefault(mid, []).append(round(t))
                            HIST[mid] = HIST[mid][-45:]
                HIST_F.write_text(json.dumps(HIST))
        except Exception as e:  # noqa: BLE001
            log("slow_loop", e)
        n += 1
        stop.wait(5)


def run_action(cfg, aid, option):
    o = next((x for x in cfg.get("switch", []) if x["id"] == option), None)
    if not o:
        return "failed", "白名单里没有这个切换项"
    EXTRA.setdefault("busy_machines", []).append(o["machine"])
    try:
        log("switch", option, o["run"])
        for _ in range(3):
            try:
                http("POST", f"/ingest/actions/{aid}", {"status": "running", "message": o["label"]}, timeout=10)
                break
            except Exception:  # noqa: BLE001
                time.sleep(2)
        rc, out, err = run(o["run"], timeout=max(600, int(o.get("eta_s", 300)) * 3), stdin="")
        tail = "\n".join((out + "\n" + err).strip().splitlines()[-6:])[-600:]
        olines = [x for x in out.strip().splitlines() if x.strip()]
        elines = [x for x in err.strip().splitlines() if x.strip() and "Pseudo-terminal" not in x]
        with (STATE / "actions.log").open("a") as f:
            f.write(json.dumps({"t": time.time(), "aid": aid, "option": option, "rc": rc, "tail": tail}, ensure_ascii=False) + "\n")
        reasons = {124: "执行超时", **{int(k): v for k, v in (o.get("exit_reasons") or {}).items()}}
        if rc == 0:
            return "done", (olines[-1] if olines else "完成")[:300]
        last = (elines or olines or [""])[-1][:300]
        return "failed", reasons.get(rc, f"退出码 {rc}") + (f"：{last}" if last else "")
    finally:
        EXTRA["busy_machines"].remove(o["machine"])


def action_loop(cfg_ref, stop, dry):
    while not stop.is_set():
        try:
            j = http("GET", "/ingest/actions?wait=25", timeout=40)
        except Exception as e:  # noqa: BLE001
            log("poll actions failed", e)
            stop.wait(5)
            continue
        for a in j.get("actions", []):
            if a["aid"] in SEEN:
                continue
            SEEN.add(a["aid"])
            if dry:
                log("dry run, not executing", a)
                continue

            def work(a=a):
                st, msg = run_action(cfg_ref[0], a["aid"], a["option"])
                log("switch result", a["option"], st, msg)
                try:
                    http("POST", f"/ingest/actions/{a['aid']}", {"status": st, "message": msg}, timeout=10)
                except Exception as e:  # noqa: BLE001
                    log("report failed", e)
            threading.Thread(target=work, daemon=True).start()


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--once", action="store_true", help="probe once, print the snapshot, exit")
    ap.add_argument("--dry", action="store_true", help="push snapshots, never run switch commands")
    ap.add_argument("--no-push", action="store_true", help="probe only, print a summary line")
    a = ap.parse_args()
    if not CFG.exists():
        sys.exit(f"missing {CFG} (copy fleet.example.json to fleet.json and edit it)")
    cfg_ref = [load_cfg()]
    mtime = CFG.stat().st_mtime
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    threading.Thread(target=probe_loop, args=(cfg_ref, stop), daemon=True).start()
    threading.Thread(target=slow_loop, args=(cfg_ref, stop), daemon=True).start()
    if a.once:
        time.sleep(max([m.get("timeout", 25) for m in cfg_ref[0]["machines"]] + [5]) + 3)
        with LOCK:
            s = build(cfg_ref[0])
        print(json.dumps(s, ensure_ascii=False, indent=1))
        return
    if not a.no_push:
        if len(TOKEN) < 32:
            sys.exit("missing token: set FLEETDASH_TOKEN or ~/.config/fleetdash/hub_token (>= 32 chars)")
        threading.Thread(target=action_loop, args=(cfg_ref, stop, a.dry), daemon=True).start()
    log("hub started, relay =", RELAY)
    fails = 0
    while not stop.is_set():
        if CFG.stat().st_mtime != mtime:
            try:
                cfg_ref[0] = load_cfg()
                mtime = CFG.stat().st_mtime
                log("fleet.json reloaded")
            except ValueError as e:
                log("fleet.json is broken, keeping the old config", e)
        with LOCK:
            s = build(cfg_ref[0])
        if a.no_push:
            on = sum(m["online"] for m in s["machines"])
            log(f"online {on}/{len(s['machines'])}", " ".join(f"{m['id']}:{m['status']}:{m['temp_c']}" for m in s["machines"]))
        else:
            try:
                http("POST", "/ingest/snapshot", s, timeout=15)
                fails = 0
            except Exception as e:  # noqa: BLE001
                fails += 1
                if fails in (1, 10) or fails % 60 == 0:
                    log("push failed", fails, e)
        stop.wait(5)


if __name__ == "__main__":
    main()
