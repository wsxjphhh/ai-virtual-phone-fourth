"use client";

/**
 * 性能日志面板（临时诊断件，配合 lib/perf-probe.ts）
 *
 * 存在的理由：真机 WebView 上没有控制台，日志必须能在手机上直接导出或复制，
 * 否则端上数据拿不到手里。导出走的是备份导出同一条 blob 下载路径
 * （lib/download-utils.ts，android-shell 的 DownloadListener 已验证可用），
 * 复制走剪贴板，两条路任选一条都能把数据交出来。
 *
 * 拆除时：删本文件 + desktop-shell.tsx 里 PerfProbePanel / perfProbe* 的引用即可。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { downloadFile } from "@/lib/download-utils";
import {
  PERF_PROBE_BUILD,
  clearPerfProbe,
  perfProbeEvents,
  perfProbeJson,
  perfProbeMark,
  perfProbeSummary,
} from "@/lib/perf-probe";

export default function PerfProbePanel() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [hint, setHint] = useState("");
  const hintTimer = useRef(0);

  const flash = useCallback((msg: string) => {
    setHint(msg);
    if (hintTimer.current) window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint(""), 4000);
  }, []);

  useEffect(() => () => {
    if (hintTimer.current) window.clearTimeout(hintTimer.current);
  }, []);

  const refresh = useCallback(() => {
    setText(`${perfProbeSummary()}\n\n──── 原始事件 ────\n${perfProbeEvents().map(e => JSON.stringify(e)).join("\n")}`);
  }, []);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  const handleExport = useCallback(async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `aiphone-perf-${stamp}.json`;
    try {
      perfProbeMark("note", { d: { msg: "export" } });
      await downloadFile(new Blob([perfProbeJson()], { type: "application/json" }), filename, { disableNativeShare: true });
      flash(`已导出 ${filename}（系统下载目录）`);
    } catch (err) {
      flash(`导出失败：${err instanceof Error ? err.message : String(err)}，请改用「复制全文」`);
    }
  }, [flash]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(perfProbeJson());
      flash("日志已复制到剪贴板，粘贴到任意笔记/聊天发出来即可");
    } catch {
      const ta = document.createElement("textarea");
      ta.value = perfProbeJson();
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand?.("copy");
      ta.remove();
      flash(ok ? "日志已复制（兼容路径）" : "复制失败，请改用「导出文件」");
    }
  }, [flash]);

  const handleClear = useCallback(() => {
    clearPerfProbe();
    refresh();
    flash("日志已清空");
  }, [refresh, flash]);

  return (
    <>
      <button
        type="button"
        className="perf-probe-fab"
        onClick={() => setOpen(v => !v)}
        aria-label="性能日志"
      >
        日志
      </button>
      {open ? (
        <div className="perf-probe-panel" role="dialog" aria-label="性能日志">
          <div className="perf-probe-head">
            <span>性能日志 · {PERF_PROBE_BUILD}</span>
            <button type="button" className="perf-probe-x" onClick={() => setOpen(false)} aria-label="关闭">✕</button>
          </div>
          <div className="perf-probe-actions">
            <button type="button" onClick={() => void handleExport()}>导出文件</button>
            <button type="button" onClick={() => void handleCopy()}>复制全文</button>
            <button type="button" onClick={refresh}>刷新</button>
            <button type="button" onClick={handleClear}>清空</button>
          </div>
          {hint ? <div className="perf-probe-hint">{hint}</div> : null}
          <pre className="perf-probe-body">{text}</pre>
        </div>
      ) : null}
    </>
  );
}
