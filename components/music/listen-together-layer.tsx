// components/music/listen-together-layer.tsx — 「一起听」实时互动层
// 挂在音乐播放器之上（非阻塞）：右下角浮起角色点评气泡（弹幕），按随机间隔自动冒泡；
// 角色也会自发斟酌切歌——按人数走动态阈值：
//   1人：不弹窗，弹幕内嵌「切歌」小按钮（软确认，超时自动消失）；
//   2人：1人想切即弹窗；3人+：≥2 票或 ≥60% 支持才弹窗，凑不齐票只在弹幕嘀咕。
// 用户拒绝弹窗后进入冷却，避免反复提议打扰。
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import type { MusicTrack } from "@/lib/music-storage";
import {
    generateListenComment,
    decideListenSkip,
    appendListenHistory,
    loadListenHistory,
    markListenHeard,
    markSkipWanted,
    markSkipDenied,
    type ListenTogetherMessage,
} from "@/lib/music-listen-together";

type Bubble = {
    key: number;
    character: Character;
    text: string;
    action: "comment" | "skip" | "propose";
};

type SkipProposal = { character: Character; reason: string };

type PendingSkip = {
    proposers: SkipProposal[];
};

type Props = {
    track: MusicTrack;
    currentTime: number;
    characterIds: string[];
    intervalMin: number;
    intervalMax: number;
    onSkip: () => void;
    onToast?: (text: string) => void;
    onStop: () => void;
};

const BUBBLE_TTL = 7000;
const PROPOSE_TTL = 15000;   // 切歌提议气泡留久一点，给用户点按钮的时间
const MAX_BUBBLES = 5;
const MIN_EVAL_PLAYED = 60;  // 至少听了1分钟才允许自动提议切歌
const AUTO_EVAL_GAP_MS = 45000; // 自动切歌评估最小间隔
const DENY_COOLDOWN_MS = 180000; // 用户拒绝提议后的冷却
const SKIP_PROBABILITY = 0.22; // 每次调度 tick 转为切歌评估的概率
const AUTO_SKIP_DENY_LIMIT = 3; // 同一会话被拒满3次，本次不再自动提议切歌

function randomBetween(min: number, max: number): number {
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    return lo + Math.random() * (hi - lo);
}

/** 动态阈值：不同人数下，几票才值得打扰用户 */
function reachesConsensus(total: number, yesVotes: number): boolean {
    if (total <= 2) return yesVotes >= 1;
    return yesVotes >= 2 || yesVotes / total >= 0.6;
}

export default function ListenTogetherLayer({
    track,
    currentTime,
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
    const currentTimeRef = useRef<number>(currentTime);
    const intervalRef = useRef({ min: intervalMin, max: intervalMax });
    const mountedRef = useRef(true);
    const speakingRef = useRef(false);
    const keyRef = useRef(0);
    const removeTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
    const scheduleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // 切歌提议状态（按当前这首歌累计）
    const votesRef = useRef<Map<string, SkipProposal>>(new Map());
    const askedRef = useRef<Set<string>>(new Set());
    const lastAutoEvalRef = useRef(0);
    const cooldownUntilRef = useRef(0);
    const denyCountRef = useRef(0);
    const autoSkipDisabledRef = useRef(false);
    const proposalsRef = useRef<Map<number, SkipProposal>>(new Map());
    const pendingSkipRef = useRef<PendingSkip | null>(null);
    pendingSkipRef.current = pendingSkip;

    useEffect(() => {
        mountedRef.current = true;
        const chars = loadCharacters().filter(c => characterIds.includes(c.id));
        charsRef.current = chars;
        return () => { mountedRef.current = false; };
    }, [characterIds]);

    useEffect(() => { trackRef.current = track; }, [track]);
    useEffect(() => { currentTimeRef.current = currentTime; }, [currentTime]);
    useEffect(() => { intervalRef.current = { min: intervalMin, max: intervalMax }; }, [intervalMin, intervalMax]);

    // 切歌后清空弹幕与提议，重新计时；本首歌对所有参与者记一次"听过"
    useEffect(() => {
        setBubbles([]);
        removeTimersRef.current.forEach(t => clearTimeout(t));
        removeTimersRef.current.clear();
        proposalsRef.current.clear();
        votesRef.current.clear();
        askedRef.current.clear();
        lastAutoEvalRef.current = 0;
        setPendingSkip(null);
        markListenHeard(characterIds, track.id);
    }, [track.id, characterIds]);

    const pushBubble = useCallback((character: Character, text: string, action: Bubble["action"]): number => {
        const key = ++keyRef.current;
        setBubbles(prev => {
            const next = [...prev, { key, character, text, action }];
            return next.length > MAX_BUBBLES ? next.slice(next.length - MAX_BUBBLES) : next;
        });
        const timer = setTimeout(() => {
            setBubbles(prev => prev.filter(b => b.key !== key));
            removeTimersRef.current.delete(key);
            proposalsRef.current.delete(key);
        }, action === "propose" ? PROPOSE_TTL : BUBBLE_TTL);
        removeTimersRef.current.set(key, timer);
        return key;
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

    // 收到一张"想切"票后按人数决定打扰方式：
    // manual（用户主动点按钮）必弹窗；自动则凑够阈值才弹窗，
    // 单人自动最特殊——只在弹幕里软提议，绝不弹窗打断。
    const applySkipVote = useCallback((character: Character, reason: string, manual: boolean) => {
        markSkipWanted(character.id, trackRef.current.id);
        votesRef.current.set(character.id, { character, reason });
        const total = charsRef.current.length;
        const yes = votesRef.current.size;
        if (!manual && total === 1) {
            const key = pushBubble(character, reason, "propose");
            proposalsRef.current.set(key, { character, reason });
            return;
        }
        if (manual || reachesConsensus(total, yes)) {
            setPendingSkip({ proposers: [...votesRef.current.values()] });
        } else {
            // 票没凑够：只在弹幕里嘀咕一句，不弹窗
            pushBubble(character, reason, "comment");
            recordHistory(character, "comment", reason);
        }
    }, [pushBubble, recordHistory]);

    // 问一个（本首歌还没问过的）角色想不想切歌
    const evaluateSkip = useCallback(async (manual: boolean) => {
        const chars = charsRef.current;
        if (chars.length === 0) return;
        const pool = manual ? chars : chars.filter(c => !askedRef.current.has(c.id));
        if (pool.length === 0) return;
        const character = pool[Math.floor(Math.random() * pool.length)];
        askedRef.current.add(character.id);
        try {
            const recentMessages = loadListenHistory(trackRef.current.id);
            const decision = await decideListenSkip(character, trackRef.current, { recentMessages });
            if (!mountedRef.current) return;
            if (decision.skip) {
                applySkipVote(character, decision.reason || "想换一首", manual);
            } else if (manual) {
                onToast?.("TA 想继续听这首");
            }
        } catch {
            if (manual) setError("TA 没有回应，可能还没配置 API 或人设");
        }
    }, [applySkipVote, onToast]);

    // 单个角色冒一句点评（自动调度用，失败静默）
    const speakOne = useCallback(async () => {
        const chars = charsRef.current;
        if (chars.length === 0 || speakingRef.current) return;
        speakingRef.current = true;
        const character = chars[Math.floor(Math.random() * chars.length)];
        try {
            const recentMessages = loadListenHistory(trackRef.current.id);
            const text = await generateListenComment(character, trackRef.current, { recentMessages });
            if (!mountedRef.current) return;
            pushBubble(character, text, "comment");
            recordHistory(character, "comment", text);
        } catch {
            /* 自动模式下忽略失败，不打扰用户 */
        } finally {
            speakingRef.current = false;
        }
    }, [pushBubble, recordHistory]);

    // 随机自动发言调度器：偶尔不点评，改成琢磨要不要切歌
    const scheduleNext = useCallback(() => {
        if (scheduleTimerRef.current) clearTimeout(scheduleTimerRef.current);
        const { min, max } = intervalRef.current;
        const delay = randomBetween(Math.max(3, min), Math.max(min + 2, max)) * 1000;
        scheduleTimerRef.current = setTimeout(() => {
            const now = Date.now();
            const canProposeSkip =
                !autoSkipDisabledRef.current &&
                !pendingSkipRef.current &&
                !speakingRef.current &&
                currentTimeRef.current >= MIN_EVAL_PLAYED &&
                now >= cooldownUntilRef.current &&
                now - lastAutoEvalRef.current >= AUTO_EVAL_GAP_MS &&
                charsRef.current.some(c => !askedRef.current.has(c.id)) &&
                Math.random() < SKIP_PROBABILITY;
            if (canProposeSkip) {
                lastAutoEvalRef.current = now;
                void evaluateSkip(false);
            } else {
                void speakOne();
            }
            scheduleNext();
        }, delay);
    }, [speakOne, evaluateSkip]);

    useEffect(() => {
        scheduleNext();
        return () => {
            if (scheduleTimerRef.current) clearTimeout(scheduleTimerRef.current);
        };
    }, [scheduleNext, track.id]);

    // 手动：大家挨个评一句（串行执行，后面的角色能看到前面刚说的话，形成接话而非各说各的）
    const handleCommentAll = useCallback(async () => {
        const chars = charsRef.current;
        if (chars.length === 0 || busyAll) return;
        setBusyAll(true);
        setError(null);
        let failed = 0;
        for (const character of chars) {
            if (!mountedRef.current) break;
            try {
                const recentMessages = loadListenHistory(trackRef.current.id);
                const text = await generateListenComment(character, trackRef.current, { recentMessages });
                pushBubble(character, text, "comment");
                recordHistory(character, "comment", text);
            } catch {
                failed += 1;
            }
        }
        setBusyAll(false);
        if (failed === chars.length) {
            setError("角色们都没回应，可能还没配置 API 或人设");
        } else if (failed > 0) {
            onToast?.(`${failed} 位角色没回应`);
        }
    }, [busyAll, pushBubble, recordHistory, onToast]);

    // 手动：问问谁想切歌（用户主动问的，问到就说，直接弹窗）
    const handleAskSkip = useCallback(async () => {
        if (charsRef.current.length === 0 || busySkip) return;
        setBusySkip(true);
        setError(null);
        await evaluateSkip(true);
        setBusySkip(false);
    }, [busySkip, evaluateSkip]);

    const handleAllowSkip = useCallback(() => {
        const ps = pendingSkipRef.current;
        if (!ps || ps.proposers.length === 0) return;
        const first = ps.proposers[0];
        pushBubble(first.character, `（切歌）${ps.proposers.map(p => p.reason).join(" / ")}`, "skip");
        recordHistory(first.character, "skip", ps.proposers.map(p => p.reason).join(" / "));
        setPendingSkip(null);
        onSkip();
    }, [pushBubble, recordHistory, onSkip]);

    const handleDenySkip = useCallback(() => {
        // 被拒绝了就消停一会儿：3分钟冷却，本首歌的票作废
        cooldownUntilRef.current = Date.now() + DENY_COOLDOWN_MS;
        markSkipDenied([...votesRef.current.keys()], trackRef.current.id);
        denyCountRef.current += 1;
        // 同一次会话里连续拒3次：本层自动停用切歌提议，只保留点评
        if (denyCountRef.current >= AUTO_SKIP_DENY_LIMIT) {
            autoSkipDisabledRef.current = true;
            onToast?.("好吧，这次只听不切了");
        }
        votesRef.current.clear();
        askedRef.current.clear();
        setPendingSkip(null);
    }, [onToast]);

    // 单人模式的软确认：点弹幕气泡里的「切歌」小按钮才切，不点就自然超时消失
    const handleProposeAllow = useCallback((key: number) => {
        const proposal = proposalsRef.current.get(key);
        if (!proposal) return;
        proposalsRef.current.delete(key);
        const timer = removeTimersRef.current.get(key);
        if (timer) { clearTimeout(timer); removeTimersRef.current.delete(key); }
        setBubbles(prev => prev.filter(b => b.key !== key));
        pushBubble(proposal.character, `（切歌）${proposal.reason}`, "skip");
        recordHistory(proposal.character, "skip", proposal.reason);
        onSkip();
    }, [pushBubble, recordHistory, onSkip]);

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
                            {b.action === "propose" && (
                                <button
                                    className="lt-bubble-skip-btn"
                                    onClick={() => handleProposeAllow(b.key)}
                                >
                                    切歌
                                </button>
                            )}
                        </span>
                    </div>
                ))}
            </div>

            {/* 切歌确认弹窗（凑够票才出现） */}
            {pendingSkip && pendingSkip.proposers.length > 0 && (
                <div className="lt-skip-mask" onClick={handleDenySkip}>
                    <div className="lt-skip-card" onClick={e => e.stopPropagation()}>
                        <div className="lt-skip-head">
                            <span className="lt-skip-ava">
                                {pendingSkip.proposers[0].character.avatar
                                    ? <img src={pendingSkip.proposers[0].character.avatar} alt="" />
                                    : <i>{(pendingSkip.proposers[0].character.name || "?").slice(0, 1)}</i>}
                            </span>
                            <div className="lt-skip-title">
                                <b>{pendingSkip.proposers.map(p => p.character.name || "角色").join("、")}</b>
                                <span>想切掉这首</span>
                            </div>
                        </div>
                        {pendingSkip.proposers.map(p => (
                            <p className="lt-skip-reason" key={p.character.id}>{p.reason}</p>
                        ))}
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
