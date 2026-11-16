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
command -v nvidia-smi >/dev/null && nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits 2>/dev/null | sed 's/^/pvr=/'
ps -eo pid=,rss=,args= --sort=-rss 2>/dev/null | head -40 | cut -c1-240 | sed 's/^ */prc=/'
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
       "%EXTRA%%PROC%"
       "Write-Output ('ports='+((Get-NetTCPConnection -State Listen|Select-Object -ExpandProperty LocalPort|Sort-Object -Unique) -join ' '))")
# Windows: per-process VRAM comes from the "GPU Process Memory" counter (nvidia-smi shows [N/A] under WDDM);
# a process can appear once per adapter, so take the max, not the sum. python / node also get their command line.
WIN_PROC = ("$g=@{};(Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage').CounterSamples|ForEach-Object{if($_.InstanceName -match '^pid_(\\d+)_'){$k=[int]$matches[1];if($_.CookedValue -gt [double]$g[$k]){$g[$k]=$_.CookedValue}}};"
            "$g.GetEnumerator()|Sort-Object Value -Descending|Select-Object -First 6|ForEach-Object{$q=Get-Process -Id $_.Key;Write-Output ('pvr='+$_.Key+','+[int]($_.Value/1MB)+','+$q.ProcessName)};"
            "$pl=Get-Process|Sort-Object WorkingSet64 -Descending|Select-Object -First 40;"
            "$pl|ForEach-Object{Write-Output ('prc='+$_.Id+','+[int]($_.WorkingSet64/1KB)+','+$_.ProcessName)};"
            "$ids=@($pl|Where-Object{$_.ProcessName -match '^(python|pythonw|node|java|javaw|uv)$'}|ForEach-Object{$_.Id})+@($g.Keys);"
            "Get-CimInstance Win32_Process|Where-Object{($ids -contains $_.ProcessId) -and $_.CommandLine}|ForEach-Object{$l=$_.CommandLine;Write-Output ('pcl='+$_.ProcessId+','+$l.Substring(0,[Math]::Min(240,$l.Length)))};")
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
ps -Ao pid=,rss=,args= -m 2>/dev/null | head -40 | cut -c1-240 | sed 's/^ */prc=/'
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
        elif k in ("prc", "pvr", "pcl"):
            out.setdefault("_" + k, []).append(v.strip())
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
        ps = WIN.replace("%EXTRA%", WIN_AMD if kind == "amd" else WIN_NV).replace("%PROC%", WIN_PROC)
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
    r["mem_total_gb"] = round(mt / 1048576) if mt else None
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
    try:   # cap: total VRAM (AMD: what the whole adapter uses) — integrated GPUs sometimes report absurd per-process numbers
        cap = (num(d.get("amd_vram_b"), 0) / 2**30) if kind == "amd" else sum(g.get("vram_gb") or 0 for g in r.get("gpus") or [])
        r["procs"] = proc_top(d, kind, cap or None)
    except Exception as e:  # noqa: BLE001
        log("procs", m["id"], e)
    return r

# ------------------------------------------------------------------ top memory / VRAM processes per machine
PROC_SKIP = re.compile(r"^(memory compression|system|registry|idle|secure system|powershell|pwsh|sshd|conhost|ps|bash|sh|sed|head|cut|awk|sort|kernel_task)$", re.I)
# processes that ARE the model service (listed separately, not in the "top 3 besides the model")
PROC_MODEL = re.compile(r"sglang|vllm|llama[-_.]?(server|cpp)|ollama|trtllm|tensorrt|text-generation|exllama|tabbyapi|koboldcpp|lm ?studio|comfy|whisper|cosyvoice|fish[-_]?speech|main\.py .*--listen", re.I)
PROC_KNOWN = [(r"sglang", "SGLang"), (r"vllm", "vLLM"), (r"llama[-_.]?(server|cpp)", "llama.cpp"), (r"ollama", "Ollama"),
              (r"comfyui|comfy|main\.py .*--listen", "ComfyUI"), (r"trtllm|tensorrt_llm", "TensorRT-LLM"), (r"blender", "Blender"),
              (r"ffmpeg", "ffmpeg"), (r"whisper", "Whisper"), (r"/apt/methods/", "apt")]
PROC_NICE = {"vmmemwsl": "WSL VM", "vmmem": "Hyper-V VM", "vmwp": "WSL / VM GPU", "msmpeng": "Defender", "dwm": "Desktop Window Manager",
             "chrome": "Chrome", "msedge": "Edge", "code": "VS Code", "windowserver": "WindowServer", "systemd-journald": "systemd-journald"}
_TOK = re.compile(r'"[^"]*"|\S+')


def _base(t):
    t = t.strip('"').rstrip("/\\")
    return re.sub(r"\.exe$", "", re.split(r"[\\/]", t)[-1], flags=re.I).rstrip(":")


def proc_label(args, name=""):
    """Readable name: Mac .app name, a known service, python/node script or -m module, else the executable; plus :port if given."""
    a = (args or "").strip()
    m = re.search(r"/([^/]+?)\.app/", a)
    if m:
        return m.group(1)[:40]
    base = next((lab for rx, lab in PROC_KNOWN if re.search(rx, a or name, re.I)), None)
    toks = _TOK.findall(a)
    exe = _base(toks[0]) if toks else (name or "?")
    if base is None:
        if exe.lower().rstrip("0123456789.") in ("python", "pythonw", "node", "java", "javaw", "uv", "bun", "deno"):
            rest = toks[1:]
            if "-m" in rest and rest.index("-m") + 1 < len(rest):
                base = rest[rest.index("-m") + 1].split(".")[0]
            else:
                sc = next((t for t in rest if not t.startswith("-")), "")
                if sc:
                    parts = [x for x in re.split(r"[\\/]", sc.strip('"')) if x]
                    stem = re.sub(r"\.(py|js|mjs|cjs|ts|jar)$", "", parts[-1])
                    base = parts[-2] if stem in ("main", "app", "server", "run", "index", "cli", "__main__", "serve") and len(parts) > 1 else stem
            base = base or exe
        else:
            base = name or exe
    base = PROC_NICE.get(base.lower(), base)
    port = re.search(r"--port[= ](\d{2,5})", a)
    return (f"{base} :{port.group(1)}" if port else base)[:40]


def proc_top(d, kind, cap_gb=None):
    """Group the probe's process lines by readable name (chrome ×10 is one row); up to 8 rows, model services flagged."""
    win = kind in ("win", "amd")
    ram, names, vr = {}, {}, {}
    for l in d.get("_prc", []):
        if win:
            p = l.split(",", 2)
            if len(p) == 3:
                ram[p[0].strip()] = (num(p[1], 0), ""); names[p[0].strip()] = p[2].strip()
        else:
            p = l.split(None, 2)
            if len(p) >= 2:
                ram[p[0]] = (num(p[1], 0), p[2] if len(p) > 2 else "")
    for l in d.get("_pvr", []):
        p = [x.strip() for x in l.split(",")]
        mb = num(p[1]) if len(p) > 1 else None
        if mb:
            vr[p[0]] = vr.get(p[0], 0) + mb
            if len(p) > 2 and p[2]:
                names.setdefault(p[0], p[2])
    cl = dict(l.split(",", 1) for l in d.get("_pcl", []) if "," in l)
    groups = {}
    for pid in set(ram) | set(vr):
        kb, args = ram.get(pid, (0, ""))
        args, name = cl.get(pid) or args, names.get(pid, "")
        toks = _TOK.findall(args)
        if PROC_SKIP.match(name or (_base(toks[0]) if toks else "")):
            continue
        lab = proc_label(args, name)
        g = groups.setdefault(lab, {"name": lab, "ram": 0.0, "vram": 0.0, "n": 0, "model": False})
        v = vr.get(pid, 0) / 1024
        if cap_gb and v > cap_gb * 1.02:
            v = 0
        g["ram"] += kb / 1048576; g["vram"] += v; g["n"] += 1
        g["model"] = g["model"] or bool(PROC_MODEL.search(f"{args} {name}"))
    out = sorted(groups.values(), key=lambda g: -max(g["ram"], g["vram"]))
    return [{"name": g["name"], "ram_gb": round(g["ram"], 1), "vram_gb": round(g["vram"], 1) if g["vram"] >= 0.05 else None,
             "n": g["n"], "model": g["model"]} for g in out[:8] if max(g["ram"], g["vram"]) >= 0.05]


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
        out.append({"_cwd": j.get("cwd", ""), "title": (j.get("name") or Path(j.get("cwd", "")).name or "未命名会话")[:60],
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


# ------------------------------------------------------------------ projects tab (optional): folders that keep a progress.md
# fleet.json: "projects": {"roots": ["~/code"], "depth": 4}. Status: active ≤ 3 days or a live Claude Code session in the folder,
# paused 3–30 days, stale > 30 days; done = progress.md says so (or every todo checked), archived 3 days after done.
PROJ_ROOTS = []
PROJ_SKIP = {"node_modules", "Library", "dist", "build", "_backups", "archive", "vendor", "venv", ".venv", "site-packages", "Applications", "Movies", "Music", "Pictures"}
_proj = {"dirs": [], "t": 0}
PROJ_DEPTH = [4]
DONE_RE = re.compile(r"(状态|阶段|进度)[^\n]{0,6}[:：]\s*[^\n]{0,8}(已完成|已结项|已交付|结项|完结|全部完成)|项目(已)?完成|✅\s*(全部|项目)?(已)?完成")
DATE_RE = re.compile(r"(20\d\d)-(\d\d)-(\d\d)")


def proj_discover():
    out = []
    def walk(d, depth):
        try:
            it = list(os.scandir(d))
        except OSError:
            return
        names = {e.name.lower() for e in it if e.is_file()}
        if "progress.md" in names:
            out.append(d)
        if depth >= PROJ_DEPTH[0]:
            return
        for e in it:
            if e.is_dir(follow_symlinks=False) and not e.name.startswith(".") and e.name not in PROJ_SKIP:
                walk(e.path, depth + 1)
    for r in PROJ_ROOTS:
        walk(r, 1)
    return sorted(set(out))


def _read(p, limit=200_000):
    try:
        with open(p, encoding="utf-8", errors="replace") as f:
            return f.read(limit)
    except OSError:
        return ""


def _find(d, *names):
    for n in names:
        for v in (n, n.upper(), n.capitalize()):
            p = os.path.join(d, v)
            if os.path.isfile(p):
                return p
    return None


def _clean(t):
    t = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", t)
    t = re.sub(r"[*`_]{1,3}", "", t)
    return re.sub(r"\s+", " ", t).strip(" -*>|：:\t")


def proj_intent(d, up=True):
    """项目意图：context.md 的「目标：」→「项目概述 / 项目目标」小节第一句 → README / HANDOFF / CLAUDE.md 开头一段；docs 之类子目录再看上一级。"""
    cf = _find(d, "context.md")
    ctx = _read(cf, 60_000) if cf else ""
    m = re.search(r"^\s*[-*]?\s*(?:\*\*)?(?:(?:当前)?(?:项目)?目标|Goal|Intent|Purpose)(?:\*\*)?\s*[:：]\s*(.+)$", ctx, re.M | re.I)
    if m and len(_clean(m.group(1))) >= 4:
        return _clean(m.group(1))
    m = re.search(r"^#+[^\n]*(项目概述|项目目标|目标|概述|简介)[^\n]*\n(.*?)(?=^#+\s|\Z)", ctx, re.M | re.S)
    if m:
        for l in m.group(2).splitlines():
            c = _clean(l)
            if len(c) >= 6 and not re.match(r"^(名称|路径|类型|技术栈|仓库|线上|地址)\s*[:：/]", c):
                return c
    for n in ("README.md", "HANDOFF.md", "CLAUDE.md", "AGENTS.md"):
        f = _find(d, n)
        if not f:
            continue
        for l in _read(f, 20_000).splitlines():
            c = _clean(l)
            if len(c) >= 8 and not l.lstrip().startswith(("#", "!", "<", "```", "|", "[!")) and not c.startswith(("http", "本文件", "This file")):
                return c
    if up and os.path.basename(d.rstrip("/")).lower() in ("docs", "web", "app", "src"):
        return proj_intent(os.path.dirname(d.rstrip("/")), up=False)
    return ""


HEAD_RE = re.compile(r"^#{2,4}\s+[^\n]*?(20\d\d-\d\d-\d\d)([^\n]*)$", re.M)
BUL_RE = re.compile(r"^\s*[-*|]\s*[^\n]*?(20\d\d-\d\d-\d\d)([^\n]*)$", re.M)


def proj_recent(logs, prog, n=3):
    """最近几条「哪天做了什么」：先取日志里带日期的标题，没有再取进度里带日期的条目。"""
    def pick(txt, rx, newest_last):
        out = []
        for i, m in enumerate(rx.finditer(txt)):
            t = _clean(re.sub(r"^\s*[·:：—\-|]*\s*(会话\s*#?\d+\s*(续)?\s*[·:：—\-]\s*)?", "", m.group(2)))
            t = re.sub(r"\s*\|\s*", " · ", t).strip(" ·|")
            t = re.sub(r"^\d{1,2}:\d\d(:\d\d)?(\s*[+-]\d{4})?\s*\]?\s*[·:：—-]?\s*", "", t)          # 标题里带的时分 / 时区
            t = re.sub(r"^[\w./-]*\.(md|txt|json|log)[)）]?\s*[:：]?\s*", "", t).strip(" ·:：")    # 日期其实在文件名里
            if len(t) >= 2:
                out.append((m.group(1), i if newest_last else -i, t[:90]))
        out.sort(key=lambda x: (x[0], x[1]), reverse=True)
        return out
    items = pick(logs, HEAD_RE, True) if logs else []
    if not items:
        items = pick(prog, BUL_RE, False)
    seen, res = set(), []
    for d_, _, t in items:
        if t in seen:
            continue
        seen.add(t); res.append({"d": d_, "t": t})
        if len(res) >= n:
            break
    return res


def proj_one(d, now, live):
    pf = _find(d, "progress.md")
    lf = _find(d, "logs.md") or _find(d, "log.md")
    prog, logs = _read(pf), _read(lf) if lf else ""
    mt = [os.path.getmtime(p) for p in (pf, lf, _find(d, "context.md"), _find(d, "bug.md"), _find(d, "HANDOFF.md")) if p and os.path.exists(p)]
    last = max(mt) if mt else 0
    done_n = len(re.findall(r"^\s*[-*]\s*\[[xX✓]\]", prog, re.M))
    todo = re.findall(r"^\s*[-*]\s*\[ \]\s*(.+)$", prog, re.M)
    total = done_n + len(todo)
    h1 = re.search(r"^#\s+(.+)$", prog, re.M)
    name = os.path.basename(d.rstrip("/")) or d
    if name.lower() in ("docs", "web", "app", "project", "src"):
        name = os.path.basename(os.path.dirname(d.rstrip("/"))) or name
    if h1 and "·" in h1.group(1):
        name = h1.group(1).split("·")[-1].strip()[:40] or name
    # 最新里程碑：「里程碑」小节下第一条；没有就取第一条带日期的列表项
    ms = None
    m = re.search(r"^#+[^\n]*里程碑[^\n]*\n(.*?)(?=^#+\s|\Z)", prog, re.M | re.S)
    if m:
        ms = next((l.strip(" -*|>\t") for l in m.group(1).splitlines() if l.strip(" -*|>\t") and not set(l.strip()) <= set("|-: ")), None)
    if not ms:
        ms = next((l.strip(" -*\t") for l in prog.splitlines() if DATE_RE.search(l) and l.strip().startswith(("-", "*"))), None)
    # 最近 14 天每天几条记录（日志标题 + 进度里带日期的行）
    days = [0] * 14
    today = time.localtime(now)
    t0 = time.mktime((today.tm_year, today.tm_mon, today.tm_mday, 0, 0, 0, 0, 0, -1))
    for txt in (logs, prog):
        for y, mo, da in DATE_RE.findall("\n".join(l for l in txt.splitlines() if l.lstrip().startswith(("#", "-", "*", "|")))):
            try:
                t = time.mktime((int(y), int(mo), int(da), 0, 0, 0, 0, 0, -1))
            except (OverflowError, ValueError):
                continue
            k = int(round((t0 - t) / 86400))
            if 0 <= k < 14:
                days[13 - k] += 1
    if last and now - last < 86400 and days[13] == 0:
        days[13] = 1
    head = "\n".join(prog.splitlines()[:60])
    done = bool(DONE_RE.search(head)) or (total >= 3 and done_n == total)
    age = now - last if last else 1e12
    sess = [x for x in live if x.get("_cwd", "").rstrip("/") == d.rstrip("/") or x.get("_cwd", "").startswith(d.rstrip("/") + "/")]
    if done:
        status = "archived" if age > 3 * 86400 else "done"
    elif sess or age <= 3 * 86400:
        status = "active"
    elif age <= 30 * 86400:
        status = "paused"
    else:
        status = "stale"
    short = d.replace(str(HOME), "~", 1)
    ov = proj_overrides()
    name = (ov.get("names") or {}).get(short) or name
    intent = ((ov.get("intents") or {}).get(short) or proj_intent(d))[:160]
    p = {"id": format(abs(hash(d)) % (1 << 40), "x"), "name": name, "path": short, "dir": d, "intent": intent, "cat": proj_cat(short, name, intent), "status": status,
         "last": int(last * 1000) if last else None, "done": done_n, "total": total,
         "live": len(sess), "live_busy": sum(1 for x in sess if x.get("status") == "busy")}
    if status in ("active", "paused", "done"):
        p.update({"milestone": (ms or "")[:120], "next": [t.strip()[:80] for t in todo[:4]], "days": days, "recent": proj_recent(logs, prog)})
    return p


# 项目分类：先查 project_cats.json（手工对照，网页路径为键），没登记的按关键词打分，都不中归 misc
CAT_RULES = [
    ("web3d", "web3d|3d 网页|3d 站|three.js|threejs|webgl|scroll3d|3d 提案|3d 作品集"),
    ("dashboard", "仪表盘|看板|dashboard|监控|总览|状态面板"),
    ("vj", "vj|舞台视觉|演唱会|无缝循环"),
    ("music", "音乐|配乐|bgm|歌词|suno|yue2|作曲|翻唱"),
    ("voice", "配音|tts|语音合成|音色|旁白|朗读|听写|asr|转写"),
    ("videoai", "h3|视频模型|图生视频|文生视频|seedance|可灵|ltx|超分"),
    ("shortvideo", "抖音|短视频|竖版|tiktok|小红书视频|reels|shorts"),
    ("video", "视频|成片|分镜|口播|官宣片|宣传片|剪辑|镜头|短片|mv"),
    ("image", "出图|生图|关键帧|海报|comfyui|qwen-image|gpt-image|效果图"),
    ("model3d", "blender|建模|渲染|glb|3d 模型|cad|白模"),
    ("llm", "大模型|推理|llm|vllm|sglang|deepseek|glm|qwen|量化|投机解码|微调"),
    ("gpu", "gpu|显卡|a100|4090|4080|3080|2080|算力机|cuda"),
    ("cluster", "集群|多机|四机|双机|机队|gb10|spark"),
    ("network", "vpn|代理|隧道|tailscale|sing-box|xray|cloudflare|dns|路由|pppoe"),
    ("security", "安全|网关|鉴权|token|密钥|口令|审计"),
    ("search", "搜索|searxng|检索|爬虫|crawl"),
    ("data", "数据|采集|抓取|报表|月报|统计|分析"),
    ("hardware", "esp32|固件|嵌入式|电路|pcb|单片机|硬件|板子"),
    ("agent", "agent|执行方|codex|claude|派活|harness|自动编码"),
    ("chat", "聊天|对话|chat|客服机器人"),
    ("social", "社交|微博|小红书|营销|campaign|种草|公众号"),
    ("miniprogram", "小程序|客服"),
    ("app", "app|pwa|ios|android|手机应用"),
    ("website", "官网|网站|落地页|网页|cms|站点|landing"),
    ("client", "提案|客户|比稿|方案网页"),
    ("design", "设计|品牌|视觉规范|logo|版式"),
    ("slides", "ppt|演示文稿|幻灯片|印刷|画册|pdf"),
    ("doc", "知识库|知识|资料|文档|笔记|整理|归档"),
    ("translate", "翻译|多语言|韩文|日文|英文版"),
    ("game", "游戏|game|关卡"),
    ("edu", "课程|教学|学习|教育|课堂"),
    ("finance", "商业计划|收入|获客|财务|定价|报价|增长|投资"),
    ("automation", "自动化|流水线|定时|批量|工作流|pipeline"),
    ("backup", "备份|nas|恢复|迁移数据|快照"),
    ("deploy", "部署|上线|发布|zeabur|docker|vercel|netlify"),
    ("car", "汽车|vin|车型|大众|路虎|捷豹|宝马|特斯拉"),
    ("drink", "酒|餐饮|菜品|餐厅|居酒屋|咖啡|饮品|lounge|酒吧"),
    ("health", "健康|减重|减肥|医疗|运动|睡眠"),
    ("culture", "文化|旅行|旅游|神社|寺|出行|入境"),
    ("legal", "法律|律所|律师|合同|专利"),
    ("industry", "工业|制造|工厂|排产|热处理|生产线"),
    ("home", "家居|卫浴|户型|装修|平面图|室内"),
    ("fashion", "服饰|面料|丝绸|服装|时尚"),
    ("pet", "宠物|猫|狗"),
    ("phone", "iphone|手机操控|远程控制手机|镜像"),
    ("product", "水杯|杯|外观|工业设计|实物"),
    ("research", "调研|研判|评估|研究|可行性"),
    ("tools", "工具|脚本|命令行|cli|插件"),
    ("scratch", "临时|试验|草稿|scratch|tmp"),
]
def _rx(alts):  # 纯英文词加词边界，免得 ios 命中 studios、vin 命中 vinyl
    return re.compile("|".join(rf"(?<![a-z]){re.escape(a)}(?![a-z])" if re.fullmatch(r"[a-z0-9 .\-]+", a) else re.escape(a) for a in alts.split("|")), re.I)


CAT_RULES = [(k, _rx(v)) for k, v in CAT_RULES]
_cats = {"t": 0, "data": {}}


def proj_overrides():
    """Optional hub/project_cats.json: {"cats": {"~/code/x": "video"}, "intents": {...}, "names": {...}} (keys = displayed path)."""
    f = DIR / "project_cats.json"
    if not f.exists():
        return {}
    try:
        mt = f.stat().st_mtime
        if mt != _cats["t"]:
            _cats["data"] = json.loads(f.read_text()); _cats["t"] = mt
    except Exception as e:  # noqa: BLE001
        if _cats["t"] != -1:
            log("project_cats.json unreadable", e); _cats["t"] = -1
    return _cats["data"]


def proj_cat(short, name, intent):
    hit = (proj_overrides().get("cats") or {}).get(short)
    if hit:
        return hit
    text = f"{name} {intent} {short.rsplit('/', 1)[-1]}"
    best, score = "misc", 0
    for k, rx in CAT_RULES:
        n = len(rx.findall(text))
        if n > score:
            best, score = k, n
    return best


def proj_scan(pcfg):
    PROJ_ROOTS[:] = [os.path.expanduser(r) for r in pcfg.get("roots", [])]
    PROJ_DEPTH[0] = int(pcfg.get("depth", 4))
    now = time.time()
    if now - _proj["t"] > 600 or not _proj["dirs"]:
        _proj["dirs"] = proj_discover(); _proj["t"] = now
    live = EXTRA.get("sessions") or []
    out = []
    for d in _proj["dirs"]:
        try:
            out.append(proj_one(d, now, live))
        except Exception as e:  # noqa: BLE001
            log("proj", d, e)
    rank = {"active": 0, "done": 1, "paused": 2, "archived": 3, "stale": 4}
    out.sort(key=lambda p: (rank[p["status"]], -(p["last"] or 0)))
    EXTRA["projects"] = out
    EXTRA["projects_meta"] = {"scanned_at": int(now * 1000), "roots": [r.replace(str(HOME), "~", 1) for r in PROJ_ROOTS], "count": len(out)}


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
            "mem_total_gb": r.get("mem_total_gb"), "procs": r.get("procs") or [],
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
        "claude": {"sessions": [{k: v for k, v in x.items() if not k.startswith("_")} for x in (EXTRA.get("sessions") or [])[:12]], "tasks": (EXTRA.get("tasks") or [])[:12]},
        **({"projects": EXTRA["projects"], "projects_meta": EXTRA.get("projects_meta")} if "projects" in EXTRA else {}),
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
            pc = cfg.get("projects")
            if pc and pc.get("roots") and n % 12 == 0 and not _proj.get("busy"):   # projects: re-read every minute, in the background
                def scan(pc=pc):
                    _proj["busy"] = True
                    try:
                        proj_scan(pc)
                    except Exception as e:  # noqa: BLE001
                        log("projects", e)
                    _proj["busy"] = False
                threading.Thread(target=scan, daemon=True).start()
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
