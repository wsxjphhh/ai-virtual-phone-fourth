"use client";

/**
 * 真机性能自记录探针（临时诊断件）
 *
 * 为什么要它：开发机（Chrome / 桌面 CPU）测出来的数字和手机 WebView 差一个量级。
 * 2026-10-19 的开发机实测是"退出 App 48~66ms"，用户真机反馈却是"要等约 5 秒"，
 * 没有端上数据就只能猜。这个探针在真机上自动跑，把带时间戳的事件攒成一份日志，
 * 用户导出后可以直接读。
 *
 * 记什么：
 *  - boot：环境（UA / DPR / 屏幕 / CPU 核数 / deviceMemory）、构建标识、各 kv 键体积、存储占用
 *  - app-change：打开/关闭哪个 App、点击到桌面真正可用的耗时
 *  - longtask：所有 >50ms 的长任务（相对页面加载的时间点 + 时长）
 *  - block：主线程看门狗。setInterval 的漂移能抓到"和 App 无关的整段卡死"，
 *          这正是 5 秒等待最可能的形态，而 longtask 只覆盖浏览器认定的那部分
 *  - visibility：前后台切换（后台页测不出渲染，必须能区分出来）
 *
 * 存哪里：kv 键 perf_probe_log_v1（IndexedDB），刷新/重启不丢，环形裁剪到最近 400 条。
 * 怎么出去：components/perf-probe-panel.tsx 的「导出文件」/「复制全文」。
 *
 * 用完即拆：本文件 + components/perf-probe-panel.tsx + desktop-shell.tsx 里
 * 以 perfProbe / PerfProbePanel 开头的几行 + phone-shell.css 的 .perf-probe-* 段落。
 */

import { isKvHydrated, kvEntries, kvGet, kvSet } from "./kv-db";

/** 每次改动探针口径时手动 +1，方便把日志和代码版本对上 */
export const PERF_PROBE_BUILD = "2026-10-19.c（对局存储备忘 c80069d + 首帧窗口 e37cffc）";

const LOG_KEY = "perf_probe_log_v1";
const MAX_EVENTS = 400;
const WATCHDOG_MS = 250;
const BLOCK_REPORT_MS = 400;

export type PerfProbeEvent = {
  /** 相对页面加载的毫秒数 */
  t: number;
  /** 墙钟时间，方便和用户的口述对上 */
  w?: string;
  kind: "boot" | "env" | "app-change" | "exit-overlay" | "longtask" | "block" | "visibility" | "note";
  app?: string | null;
  ms?: number;
  /** 紧凑的附加信息 */
  d?: Record<string, unknown>;
};

let _events: PerfProbeEvent[] = [];
let _started = false;
let _watchdogTimer = 0;
let _lastTick = 0;
let _persistTimer = 0;
let _longTaskObserver: PerformanceObserver | null = null;

function now(): number {
  return Math.round(performance.now());
}

function wall(): string {
  try {
    return new Date().toISOString().slice(5, 19).replace("T", " ");
  } catch {
    return "";
  }
}

function schedulePersist(): void {
  if (_persistTimer) return;
  _persistTimer = window.setTimeout(() => {
    _persistTimer = 0;
    persist();
  }, 1500);
}

function persist(): void {
  if (!isKvHydrated()) return; // 未水合时写入会用空日志覆盖掉真日志
  try {
    kvSet(LOG_KEY, JSON.stringify(_events));
  } catch {
    /* 诊断数据，写失败不影响功能 */
  }
}

function load(): void {
  const raw = kvGet(LOG_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      _events = parsed.filter((e): e is PerfProbeEvent => !!e && typeof e === "object" && typeof e.kind === "string");
    }
  } catch {
    _events = [];
  }
}

/** 记录一条事件（自动环形裁剪） */
export function perfProbeMark(
  kind: PerfProbeEvent["kind"],
  fields: { app?: string | null; ms?: number; d?: Record<string, unknown> } = {},
): void {
  if (!_started) return;
  _events.push({ t: now(), w: wall(), kind, ...fields });
  if (_events.length > MAX_EVENTS) _events.splice(0, _events.length - MAX_EVENTS);
  schedulePersist();
}

export function perfProbeEvents(): PerfProbeEvent[] {
  return _events.slice();
}

export function clearPerfProbe(): void {
  _events = [];
  persist();
}

function collectEnv(): Record<string, unknown> {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    ua: (nav.userAgent || "").slice(0, 160),
    dpr: window.devicePixelRatio,
    screen: `${window.screen.width}x${window.screen.height}`,
    vp: `${window.innerWidth}x${window.innerHeight}`,
    cores: nav.hardwareConcurrency,
    mem: nav.deviceMemory,
    touch: navigator.maxTouchPoints,
    hidden: document.hidden,
    build: PERF_PROBE_BUILD,
  };
}

/** kv 各键体积：整包 JSON.parse 型卡顿的元凶都在这里现形 */
function collectKvSizes(): Array<{ k: string; kb: number }> {
  if (!isKvHydrated()) return [];
  const out: Array<{ k: string; kb: number }> = [];
  try {
    // kvEntries() 只拷引用，不拷字符串本体，72 条量级下开销可忽略
    for (const { key, value } of kvEntries()) {
      if (typeof value !== "string") continue;
      const kb = Math.round(value.length / 1024);
      if (kb >= 64) out.push({ k: key, kb });
    }
  } catch {
    /* 拿不到就留空，不影响其它记录 */
  }
  out.sort((a, b) => b.kb - a.kb);
  return out.slice(0, 15);
}

function startWatchdog(): void {
  if (_watchdogTimer) return;
  _lastTick = performance.now();
  _watchdogTimer = window.setInterval(() => {
    const t = performance.now();
    const drift = t - _lastTick - WATCHDOG_MS;
    _lastTick = t;
    // 后台页的 setInterval 会被钳到 1s 一次，漂移全是节流造成的假阳性
    //（实测：隐藏时稳定刷出 750ms 的"卡顿"）。只在页面可见时判定卡顿。
    if (document.hidden) return;
    if (drift > BLOCK_REPORT_MS) {
      perfProbeMark("block", { ms: Math.round(drift) });
    }
  }, WATCHDOG_MS);
}

function startLongTaskObserver(): void {
  if (_longTaskObserver) return;
  try {
    _longTaskObserver = new PerformanceObserver(list => {
      for (const e of list.getEntries()) {
        if (e.duration < 80) continue; // 只留肉眼可感的
        perfProbeMark("longtask", { ms: Math.round(e.duration), d: { at: Math.round(e.startTime), hidden: document.hidden } });
      }
    });
    _longTaskObserver.observe({ entryTypes: ["longtask"] });
  } catch {
    /* 老 WebView 可能没有 longtask 支持，看门狗仍然有效 */
  }
}

/** 在桌面壳挂载后调用一次，幂等 */
export function startPerfProbe(): void {
  if (_started || typeof window === "undefined") return;
  _started = true;
  load();
  startLongTaskObserver();
  startWatchdog();
  document.addEventListener("visibilitychange", () => {
    perfProbeMark("visibility", { d: { hidden: document.hidden } });
  });
  window.addEventListener("pagehide", () => {
    if (_persistTimer) {
      window.clearTimeout(_persistTimer);
      _persistTimer = 0;
    }
    persist();
  });
  perfProbeMark("boot", { d: { env: collectEnv(), reloaded: _events.length > 0 } });
  // 等 kv 水合完再取体积与存储占用，避免读到空缓存
  window.setTimeout(() => {
    perfProbeMark("env", { d: { kv: collectKvSizes() } });
    if (navigator.storage?.estimate) {
      navigator.storage.estimate().then(est => {
        perfProbeMark("note", { d: { quotaMB: Math.round((est.quota || 0) / 1048576), usageMB: Math.round((est.usage || 0) / 1048576) } });
      }).catch(() => {});
    }
  }, 4000);
}

export function perfProbeSummary(): string {
  const counts = new Map<string, number>();
  const worst: PerfProbeEvent[] = [];
  for (const e of _events) {
    counts.set(e.kind, (counts.get(e.kind) || 0) + 1);
    if ((e.kind === "longtask" || e.kind === "block") && e.ms && e.ms > 300) worst.push(e);
  }
  worst.sort((a, b) => (b.ms || 0) - (a.ms || 0));
  const lines = [
    `构建：${PERF_PROBE_BUILD}`,
    `事件总数：${_events.length}`,
    `当前可见性：${document.hidden ? "后台（本次数据的耗时不可信，请切回前台重测）" : "前台"}`,
    `分类：${Array.from(counts.entries()).map(([k, v]) => `${k}=${v}`).join("  ")}`,
    `>300ms 的卡顿（最近 8 条，t=距页面加载 ms，* = 采样时页面在后台）：`,
    ...worst.slice(0, 8).map(e => `  t=${e.t}ms ${e.kind} ${e.ms}ms${e.app ? ` app=${e.app}` : ""}${e.d?.hidden ? "*" : ""}${e.w ? ` (${e.w})` : ""}`),
  ];
  const exits = _events.filter(e => e.kind === "exit-overlay" && e.ms !== undefined);
  if (exits.length) {
    lines.push(`退出 App 等待（最近 8 次，* = 采样时在后台）：`, ...exits.slice(-8).map(e => `  ${e.app} → ${e.ms}ms${e.d?.hidden ? " *" : ""}`));
  }
  return lines.join("\n");
}

export function perfProbeJson(): string {
  return JSON.stringify({
    build: PERF_PROBE_BUILD,
    exportedAt: new Date().toISOString(),
    env: collectEnv(),
    kv: collectKvSizes(),
    events: _events,
  }, null, 1);
}
