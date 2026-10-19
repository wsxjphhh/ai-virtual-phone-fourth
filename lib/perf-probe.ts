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
 *  - loaf / bigjson / idbwrite（2026-10-19.d 加的归因，见下方"大负载归因"注释）
 *
 * 存哪里：kv 键 perf_probe_log_v1（IndexedDB），刷新/重启不丢，环形裁剪到最近 600 条。
 * 怎么出去：components/perf-probe-panel.tsx 的「导出文件」/「复制全文」。
 *
 * 用完即拆：本文件 + components/perf-probe-panel.tsx + desktop-shell.tsx 里
 * 以 perfProbe / PerfProbePanel 开头的几行 + mixology-app.tsx 里标了「临时诊断」的
 * playing 副作用 + phone-shell.css 的 .perf-probe-* 段落。
 */

import { isKvHydrated, kvEntries, kvGet, kvSet } from "./kv-db";

/** 每次改动探针口径时手动 +1，方便把日志和代码版本对上 */
export const PERF_PROBE_BUILD = "2026-10-19.d（归因版：LoAF + 大 JSON + IDB 写 + 特调内导航）";

const LOG_KEY = "perf_probe_log_v1";
/**
 * 600 条：归因事件（每次大读写 2~3 条）比原来的 longtask 密得多，一局长游玩下来
 * 就可能吃掉上百条，400 的环会把早先的退出记录挤掉。第三份日志 134 条还没碰到上限，
 * 这是按"归因后事件量至少翻 3 倍"留的余量，不是踩到过才改的。
 */
const MAX_EVENTS = 600;
const WATCHDOG_MS = 250;
const BLOCK_REPORT_MS = 400;
/** 低于这个体积的 JSON / IDB 写不值得记（真机上 200KB 整包序列化也就十几毫秒） */
const BIG_KB = 200;

export type PerfProbeEvent = {
  /** 相对页面加载的毫秒数 */
  t: number;
  /** 墙钟时间，方便和用户的口述对上 */
  w?: string;
  kind: "boot" | "env" | "app-change" | "exit-overlay" | "longtask" | "block" | "visibility" | "note"
    | "loaf" | "bigjson" | "idbwrite";
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
let _loafObserver: PerformanceObserver | null = null;
/** 探针自己序列化日志时不要把自己记成"大 JSON"（递归噪声） */
let _silent = false;

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
    _silent = true;
    kvSet(LOG_KEY, JSON.stringify(_events));
  } catch {
    /* 诊断数据，写失败不影响功能 */
  } finally {
    _silent = false;
  }
}

function load(): void {
  const raw = kvGet(LOG_KEY);
  if (!raw) return;
  try {
    _silent = true;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      _events = parsed.filter((e): e is PerfProbeEvent => !!e && typeof e === "object" && typeof e.kind === "string");
    }
  } catch {
    _events = [];
  } finally {
    _silent = false;
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

/**
 * 大负载归因（2026-10-19.d）
 *
 * 第三份真机日志（07-15-54）里有三条 1.8~2.0s 的长任务，另有 14 次"应用内返回"后面
 * 各挂着两条 620~800ms。longtask 只给时长不给原因，于是两条嫌疑路分不开：
 *   A. 整包序列化 —— mixology_sessions_v1 14267KB，引擎每回合、连面板开关都要
 *      JSON.stringify 整包再 IDB.put（开发机实测 stringify 50ms + put 同步段 71ms ≈ 140ms，
 *      手机按这次日志的比例尺约 10~15 倍 → 1.4~2.1s，和观测到的三条完全同量级）；
 *   B. 桌面重新栅格化 —— 退出提交只花 142ms，但提交之后 141ms 起就是一条 2005ms 的任务。
 * 这三条钩子（LoAF / JSON / IDB 写）把"哪一段脚本、多大体积、多久"直接钉在事件上，
 * 下一份日志不用再猜。全部只在 ≥200KB 或 ≥120ms 时记账，正常操作不产生噪声。
 */

/** 调用栈里除探针自身之外的前两帧，够定位"是谁在读整包"就行 */
const HOOK_FRAMES = ["callerHint", "patchedParse", "patchedStringify", "patchedPut", "perfProbeMark"];

function callerHint(): string {
  try {
    const frames = (new Error().stack || "")
      .split("\n")
      .slice(2, 8)
      .map(line => {
        const m = line.match(/at\s+([^(\s]+)?\s*\(?([^)(]*?\/[\w.-]+:\d+:\d+)\)?/);
        const fn = (m?.[1] || "<anon>").slice(0, 26);
        const loc = m?.[2] ? m[2].slice(m[2].lastIndexOf("/") + 1).slice(0, 30) : "";
        return { fn, loc };
      })
      .filter(f => !HOOK_FRAMES.includes(f.fn));
    return frames.slice(0, 2).map(f => f.fn + (f.loc ? "@" + f.loc : "")).join("<");
  } catch {
    return "";
  }
}

function installBigJsonHooks(): void {
  const originalParse = JSON.parse.bind(JSON) as (text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => unknown;
  const originalStringify = JSON.stringify.bind(JSON) as (value: unknown, replacer?: unknown, space?: unknown) => string;

  JSON.parse = function patchedParse(
    text: string,
    reviver?: (this: unknown, key: string, value: unknown) => unknown,
  ): unknown {
    const kb = typeof text === "string" ? text.length >> 10 : 0;
    if (kb < BIG_KB || _silent) return reviver ? originalParse(text, reviver) : originalParse(text);
    const t0 = performance.now();
    const out = reviver ? originalParse(text, reviver) : originalParse(text);
    perfProbeMark("bigjson", { ms: Math.round(performance.now() - t0), d: { op: "parse", kb, at: callerHint() } });
    return out;
  };

  JSON.stringify = function patchedStringify(value: unknown, replacer?: unknown, space?: unknown): string {
    const t0 = performance.now();
    const out = originalStringify(value, replacer, space);
    const kb = typeof out === "string" ? out.length >> 10 : 0;
    if (kb >= BIG_KB && !_silent) {
      perfProbeMark("bigjson", { ms: Math.round(performance.now() - t0), d: { op: "str", kb, at: callerHint() } });
    }
    return out;
  } as typeof JSON.stringify;
}

/** IDB 写入的同步段（结构化克隆就在这里面），只记大值 */
function installIdbWriteHook(): void {
  const proto = typeof IDBObjectStore !== "undefined" ? IDBObjectStore.prototype : null;
  const originalPut = proto?.put;
  if (!proto || !originalPut) return;
  // 必须用 apply 原样转发 arguments.length：IDL 绑定是按"实参个数"判断 key 有没有传的，
  // 如果写成 originalPut.call(this, value, key)，调用方只传一个参数时也会被我们补成两个
  // （第二个是 undefined），Dexie 那种 in-line key 的写法就可能变成 DataError。
  proto.put = function patchedPut(this: IDBObjectStore, ...args: unknown[]): IDBRequest<IDBValidKey> {
    const record = args[0] as { key?: unknown; value?: unknown } | null;
    const raw = record && typeof record === "object" ? record.value : undefined;
    const kb = typeof raw === "string" ? raw.length >> 10 : 0;
    const t0 = performance.now();
    const request = (originalPut as (...a: unknown[]) => IDBRequest<IDBValidKey>).apply(this, args);
    const ms = Math.round(performance.now() - t0);
    if (kb >= BIG_KB && ms >= 8 && !_silent) {
      perfProbeMark("idbwrite", { ms, d: { k: String(record?.key ?? "?"), kb, at: callerHint() } });
    }
    return request;
  } as unknown as IDBObjectStore["put"];
}

type LoafScript = {
  duration?: number;
  invoker?: string;
  invokerType?: string;
  sourceFunctionName?: string;
  sourceURL?: string;
  forcedStyleAndLayoutDuration?: number;
};
type LoafEntry = PerformanceEntry & {
  renderStart?: number;
  styleAndLayoutStart?: number;
  firstUIEventTimestamp?: number;
  blockingDuration?: number;
  scripts?: LoafScript[];
};

function loafFieldsOf(entry: LoafEntry): Record<string, unknown> {
  const start = entry.startTime;
  const scripts = (entry.scripts ?? [])
    .slice(0, 3)
    .map(s => ({
      f: (s.sourceFunctionName || "").slice(0, 24),
      i: (s.invoker || s.invokerType || "").slice(0, 22),
      d: Math.round(s.duration || 0),
    }));
  return {
    at: Math.round(start),
    sl: entry.styleAndLayoutStart ? Math.round(entry.styleAndLayoutStart - start) : -1,
    rn: entry.renderStart ? Math.round(start + entry.duration - entry.renderStart) : -1,
    bk: Math.round(entry.blockingDuration || 0),
    s: scripts.length ? scripts : undefined,
  };
}

/**
 * 长帧归因：longtask 只说"卡了多久"，LoAF 还说这 2 秒花在 JS 还是花在样式/布局/渲染上。
 * d 里的字段（见 loafFieldsOf）：
 *  sl = 本帧第几 ms 才开始样式/布局（-1 = 整帧没走样式/布局 → 纯 JS 卡住）
 *  rn = 从渲染开始到帧结束占了多少 ms（大 → 栅格化/模糊这种绘制成本，不是脚本）
 *  s  = 本帧最贵的三段脚本（函数名 + invoker + 时长）
 * 回调整体包 try：一条读不懂的条目不能把整个探针（含 longtask、看门狗）带崩。
 */
function startLoafObserver(): void {
  if (_loafObserver) return;
  try {
    _loafObserver = new PerformanceObserver(list => {
      try {
        for (const entry of list.getEntries() as LoafEntry[]) {
          if (entry.duration < 120) continue;
          perfProbeMark("loaf", { ms: Math.round(entry.duration), d: loafFieldsOf(entry) });
        }
      } catch {
        /* 归因失败不拖累其它记录 */
      }
    });
    _loafObserver.observe({ type: "long-animation-frame" });
  } catch {
    /* WebView 不支持 LoAF（Chrome 123 以前）就退回 longtask + 看门狗 */
  }
}

/** 在桌面壳挂载后调用一次，幂等 */
export function startPerfProbe(): void {
  if (_started || typeof window === "undefined") return;
  _started = true;
  load();
  startLongTaskObserver();
  startLoafObserver();
  installBigJsonHooks();
  installIdbWriteHook();
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
    `>300ms 的卡顿（按耗时前 8 条，t=距页面加载 ms，* = 采样时页面在后台）：`,
    ...worst.slice(0, 8).map(e => `  t=${e.t}ms ${e.kind} ${e.ms}ms${e.app ? ` app=${e.app}` : ""}${e.d?.hidden ? "*" : ""}${e.w ? ` (${e.w})` : ""}`),
  ];
  const exits = _events.filter(e => e.kind === "exit-overlay" && e.ms !== undefined);
  if (exits.length) {
    lines.push(`退出 App 等待（最近 8 次，* = 采样时在后台）：`, ...exits.slice(-8).map(e => `  ${e.app} → ${e.ms}ms${e.d?.hidden ? " *" : ""}`));
  }
  // 归因：最贵的长帧 + 最费的大序列化/大写入。没有这两段就只能看到"卡了 2 秒"，
  // 看不到是脚本在读 14MB 整包还是桌面在重新栅格化。
  const loafs = _events.filter(e => e.kind === "loaf" && e.ms && e.ms >= 200).sort((a, b) => (b.ms || 0) - (a.ms || 0));
  if (loafs.length) {
    lines.push(`最贵的长帧（LoAF，sl=第几 ms 才开始样式/布局，-1 表示整帧没走样式/布局＝纯 JS；rn=渲染阶段占了多少 ms）：`);
    for (const e of loafs.slice(0, 6)) {
      const s = Array.isArray(e.d?.s) ? (e.d.s as Array<{ f?: string; i?: string; d?: number }>) : [];
      lines.push(
        `  t=${e.t} ${e.ms}ms sl=${e.d?.sl} rn=${e.d?.rn}` +
        (s.length ? `  ${s.map(x => `${x.f || "?"}/${x.i || "?"} ${x.d}ms`).join(" | ")}` : ""),
      );
    }
  }
  const heavy = _events
    .filter(e => (e.kind === "bigjson" || e.kind === "idbwrite") && e.ms && e.ms >= 30)
    .sort((a, b) => (b.ms || 0) - (a.ms || 0));
  if (heavy.length) {
    lines.push(`>30ms 的大体积读写（按耗时取前 8 次）：`);
    for (const e of heavy.slice(0, 8)) {
      lines.push(`  t=${e.t} ${e.kind === "idbwrite" ? "写库" : (e.d?.op === "str" ? "序列化" : "解析")} ${e.d?.kb}KB ${e.ms}ms ${e.d?.at || ""}`);
    }
  }
  return lines.join("\n");
}

export function perfProbeJson(): string {
  _silent = true;
  try {
    return JSON.stringify({
      build: PERF_PROBE_BUILD,
      exportedAt: new Date().toISOString(),
      env: collectEnv(),
      kv: collectKvSizes(),
      events: _events,
    }, null, 1);
  } finally {
    _silent = false;
  }
}
