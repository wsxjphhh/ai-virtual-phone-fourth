// components/music/listen-together-layer.tsx — 「一起听」实时互动层
// 挂在音乐播放器之上（非阻塞）：右下角浮起角色点评气泡（弹幕），按随机间隔自动冒泡；
// 角色提议切歌时弹出确认窗（含切歌理由评价），用户允许才真正切歌。
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import type { MusicTrack } from "@/lib/music-storage";
import {
    generateListenComment,
    decideListenSkip,
    appendListenHistory,
    type ListenTogetherMessage,
} from "@/lib/music-listen-together";

type Bubble = {
    key: number;
    character: Character;
    text: string;
    action: "comment" | "skip";
};

type PendingSkip = {
    character: Character;
    reason: string;
};

type Props = {
    track: MusicTrack;
    characterIds: string[];
    intervalMin: number;
    intervalMax: number;
    onSkip: () => void;
    onToast?: (text: string) => void;
    onStop: () => void;
};

const BUBBLE_TTL = 7000;
const MAX_BUBBLES = 5;

function randomBetween(min: number, max: number): number {
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    return lo + Math.random() * (hi - lo);
}

export default function ListenTogetherLayer({
    track,
    characterIds,
    intervalMin,
    intervalMax,
    onSkip,
    onToast,
    onStop,
}: Props) {
    const [bubbles, setBubbles] = useState<Bubble[]>([]);
    const [pendingSkip, setPendingSkip] = useState<PendingSkip | null>(null);
    const [busyAll, setBusyAll] = useState(false);
    const [busySkip, setBusySkip] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // 最新值用 ref 暴露给随机调度器，避免闭包过期
    const charsRef = useRef<Character[]>([]);
    const trackRef = useRef<MusicTrack>(track);
    const intervalRef = useRef({ min: intervalMin, max: intervalMax });
    const mountedRef = useRef(true);
    const speakingRef = useRef(false);
    const keyRef = useRef(0);
    const removeTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
    const scheduleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        mountedRef.current = true;
        const chars = loadCharacters().filter(c => characterIds.includes(c.id));
        charsRef.current = chars;
        return () => { mountedRef.current = false; };
    }, [characterIds]);

    useEffect(() => { trackRef.current = track; }, [track]);
    useEffect(() => { intervalRef.current = { min: intervalMin, max: intervalMax }; }, [intervalMin, intervalMax]);

    // 切歌后清空弹幕，重新计时
    useEffect(() => {
        setBubbles([]);
        removeTimersRef.current.forEach(t => clearTimeout(t));
        removeTimersRef.current.clear();
    }, [track.id]);

    const pushBubble = useCallback((character: Character, text: string, action: Bubble["action"]) => {
        const key = ++keyRef.current;
        setBubbles(prev => {
            const next = [...prev, { key, character, text, action }];
            return next.length > MAX_BUBBLES ? next.slice(next.length - MAX_BUBBLES) : next;
        });
        const timer = setTimeout(() => {
            setBubbles(prev => prev.filter(b => b.key !== key));
            removeTimersRef.current.delete(key);
        }, BUBBLE_TTL);
        removeTimersRef.current.set(key, timer);
    }, []);

    const recordHistory = useCallback((character: Character, action: "comment" | "skip", content: string) => {
        try {
            const message: ListenTogetherMessage = {
                characterId: character.id,
                characterName: character.name || "角色",
                characterAvatar: character.avatar ?? null,
                action,
                content,
                createdAt: new Date().toISOString(),
            };
            appendListenHistory(trackRef.current.id, message);
        } catch { /* ignore */ }
    }, []);

    // 单个角色冒一句点评（自动调度用，失败静默）
    const speakOne = useCallback(async () => {
        const chars = charsRef.current;
        if (chars.length === 0 || speakingRef.current) return;
        speakingRef.current = true;
        const character = chars[Math.floor(Math.random() * chars.length)];
        try {
            const text = await generateListenComment(character, trackRef.current);
            if (!mountedRef.current) return;
            pushBubble(character, text, "comment");
            recordHistory(character, "comment", text);
        } catch {
            /* 自动模式下忽略失败，不打扰用户 */
        } finally {
            speakingRef.current = false;
        }
    }, [pushBubble, recordHistory]);

    // 随机自动发言调度器
    const scheduleNext = useCallback(() => {
        if (scheduleTimerRef.current) clearTimeout(scheduleTimerRef.current);
        const { min, max } = intervalRef.current;
        const delay = randomBetween(Math.max(3, min), Math.max(min + 2, max)) * 1000;
        scheduleTimerRef.current = setTimeout(() => {
            void speakOne();
            scheduleNext();
        }, delay);
    }, [speakOne]);

    useEffect(() => {
        scheduleNext();
        return () => {
            if (scheduleTimerRef.current) clearTimeout(scheduleTimerRef.current);
        };
    }, [scheduleNext, track.id]);

    // 手动：大家一起评一句
    const handleCommentAll = useCallback(async () => {
        const chars = charsRef.current;
        if (chars.length === 0 || busyAll) return;
        setBusyAll(true);
        setError(null);
        let failed = 0;
        await Promise.all(chars.map(async character => {
            try {
                const text = await generateListenComment(character, trackRef.current);
                pushBubble(character, text, "comment");
                recordHistory(character, "comment", text);
            } catch {
                failed += 1;
            }
        }));
        setBusyAll(false);
        if (failed === chars.length) {
            setError("角色们都没回应，可能还没配置 API 或人设");
        } else if (failed > 0) {
            onToast?.(`${failed} 位角色没回应`);
        }
    }, [busyAll, pushBubble, recordHistory, onToast]);

    // 手动：问问谁想切歌
    const handleAskSkip = useCallback(async () => {
        const chars = charsRef.current;
        if (chars.length === 0 || busySkip) return;
        setBusySkip(true);
        setError(null);
        const character = chars[Math.floor(Math.random() * chars.length)];
        try {
            const decision = await decideListenSkip(character, trackRef.current);
            if (decision.skip) {
                setPendingSkip({ character, reason: decision.reason || "想换一首" });
            } else {
                onToast?.("TA 想继续听这首");
            }
        } catch {
            setError("TA 没有回应，可能还没配置 API 或人设");
        } finally {
            setBusySkip(false);
        }
    }, [busySkip, onToast]);

    const handleAllowSkip = useCallback(() => {
        if (!pendingSkip) return;
        const { character, reason } = pendingSkip;
        pushBubble(character, `（切歌）${reason}`, "skip");
        recordHistory(character, "skip", reason);
        setPendingSkip(null);
        onSkip();
    }, [pendingSkip, pushBubble, recordHistory, onSkip]);

    const handleDenySkip = useCallback(() => {
        setPendingSkip(null);
    }, []);

    return (
        <div className="lt-layer">
            {/* 实时控制条（左上，不挡播放器主体交互） */}
            <div className="lt-live-bar">
                <span className="lt-live-dot" />
                <span className="lt-live-label">一起听 · {charsRef.current.length}人</span>
                <button className="lt-live-btn" onClick={handleCommentAll} disabled={busyAll}>
                    {busyAll ? "…" : "一起评"}
                </button>
                <button className="lt-live-btn" onClick={handleAskSkip} disabled={busySkip}>
                    {busySkip ? "…" : "谁想切歌"}
                </button>
                <button className="lt-live-btn lt-live-stop" onClick={onStop}>
                    结束
                </button>
            </div>

            {/* 错误提示（瞬时） */}
            {error && <div className="lt-layer-error">{error}</div>}

            {/* 右下角弹幕气泡 */}
            <div className="lt-danmaku">
                {bubbles.map(b => (
                    <div key={b.key} className="lt-bubble" data-action={b.action}>
                        <span className="lt-bubble-ava">
                            {b.character.avatar
                                ? <img src={b.character.avatar} alt="" />
                                : <i>{(b.character.name || "?").slice(0, 1)}</i>}
                        </span>
                        <span className="lt-bubble-body">
                            <span className="lt-bubble-name">{b.character.name || "角色"}</span>
                            <span className="lt-bubble-text">{b.text}</span>
                        </span>
                    </div>
                ))}
            </div>

            {/* 切歌确认弹窗 */}
            {pendingSkip && (
                <div className="lt-skip-mask" onClick={handleDenySkip}>
                    <div className="lt-skip-card" onClick={e => e.stopPropagation()}>
                        <div className="lt-skip-head">
                            <span className="lt-skip-ava">
                                {pendingSkip.character.avatar
                                    ? <img src={pendingSkip.character.avatar} alt="" />
                                    : <i>{(pendingSkip.character.name || "?").slice(0, 1)}</i>}
                            </span>
                            <div className="lt-skip-title">
                                <b>{pendingSkip.character.name || "角色"}</b>
                                <span>想切掉这首</span>
                            </div>
                        </div>
                        <p className="lt-skip-reason">{pendingSkip.reason}</p>
                        <div className="lt-skip-actions">
                            <button className="lt-skip-no" onClick={handleDenySkip}>不用了</button>
                            <button className="lt-skip-yes" onClick={handleAllowSkip}>允许切歌</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
