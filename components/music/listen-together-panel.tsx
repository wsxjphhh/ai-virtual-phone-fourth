// components/music/listen-together-panel.tsx — 「一起听」面板
// 选角色（可多选）陪听当前歌曲：角色按人设发表评价，并可自主决定是否切歌。
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import type { MusicTrack } from "@/lib/music-storage";
import {
    loadListenHistory, appendListenHistory,
    loadSelectedCharacterIds, saveSelectedCharacterIds,
    generateListenComment, decideListenSkip,
    type ListenTogetherMessage,
} from "@/lib/music-listen-together";

type Props = {
    track: MusicTrack;
    onClose: () => void;
    /** 执行切歌（由播放器执行 next） */
    onSkip: () => void;
    onToast?: (text: string) => void;
};

const ACTION_LABEL: Record<ListenTogetherMessage["action"], string> = {
    comment: "评价",
    skip: "想切歌",
    keep: "想继续听",
};

function formatMsgTime(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function ListenTogetherPanel({ track, onClose, onSkip, onToast }: Props) {
    const [characters, setCharacters] = useState<Character[]>([]);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [messages, setMessages] = useState<ListenTogetherMessage[]>([]);
    const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
    const [actionBusy, setActionBusy] = useState<"comment" | "skip" | null>(null);
    const [errors, setErrors] = useState<{ id: string; name: string; message: string }[]>([]);
    const trackIdRef = useRef(track.id);
    const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => { trackIdRef.current = track.id; }, [track.id]);

    // Load characters once; restore last selection (intersected with existing ids)
    useEffect(() => {
        const chars = loadCharacters();
        setCharacters(chars);
        const saved = loadSelectedCharacterIds().filter(id => chars.some(c => c.id === id));
        setSelected(new Set(saved));
    }, []);

    // Reload history when the current track changes
    useEffect(() => {
        setMessages(loadListenHistory(track.id));
    }, [track.id]);

    // Persist selection
    useEffect(() => {
        saveSelectedCharacterIds([...selected]);
    }, [selected]);

    useEffect(() => () => {
        if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    }, []);

    const showErrors = useCallback((list: { id: string; name: string; message: string }[]) => {
        if (list.length === 0) return;
        setErrors(list);
        if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
        errorTimerRef.current = setTimeout(() => setErrors([]), 4000);
    }, []);

    const toggleRole = useCallback((id: string) => {
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const selectedChars = characters.filter(c => selected.has(c.id));
    const busy = actionBusy !== null;

    const runForSelected = useCallback(async (
        task: (character: Character) => Promise<ListenTogetherMessage>,
    ): Promise<boolean> => {
        if (selectedChars.length === 0) return false;
        setBusyIds(new Set(selectedChars.map(c => c.id)));
        const failed: { id: string; name: string; message: string }[] = [];
        const succeeded: ListenTogetherMessage[] = [];
        await Promise.all(selectedChars.map(async character => {
            try {
                const message = await task(character);
                succeeded.push(message);
                appendListenHistory(trackIdRef.current, message);
            } catch (err) {
                failed.push({
                    id: character.id,
                    name: character.name || "角色",
                    message: err instanceof Error ? err.message : "生成失败",
                });
            }
        }));
        // 按角色条顺序排列，避免并行完成时序打乱阅读顺序
        succeeded.sort((a, b) => (
            selectedChars.findIndex(c => c.id === a.characterId) -
            selectedChars.findIndex(c => c.id === b.characterId)
        ));
        setBusyIds(new Set());
        if (succeeded.length > 0) {
            // 只在面板仍停留在请求时的那首歌时同步本地列表；否则历史已随切歌重载
            setMessages(prev => (
                trackIdRef.current === track.id ? [...prev, ...succeeded] : prev
            ));
        }
        showErrors(failed);
        return succeeded.length > 0;
    }, [selectedChars, showErrors, track.id]);

    const handleComment = useCallback(async () => {
        if (busy || selectedChars.length === 0) return;
        setActionBusy("comment");
        const ok = await runForSelected(async character => {
            const content = await generateListenComment(character, track);
            return {
                characterId: character.id,
                characterName: character.name || "角色",
                characterAvatar: character.avatar ?? null,
                action: "comment" as const,
                content,
                createdAt: new Date().toISOString(),
            };
        });
        setActionBusy(null);
        if (ok) onToast?.(selectedChars.length > 1 ? "角色们已发表听感" : "TA 已发表听感");
    }, [busy, selectedChars, runForSelected, track, onToast]);

    const handleSkip = useCallback(async () => {
        if (busy || selectedChars.length === 0) return;
        setActionBusy("skip");
        setBusyIds(new Set(selectedChars.map(c => c.id)));
        const requestTrack = track;
        const decisions = await Promise.all(selectedChars.map(async character => {
            try {
                const decision = await decideListenSkip(character, requestTrack);
                return { character, decision, error: null as string | null };
            } catch (err) {
                return {
                    character,
                    decision: null,
                    error: err instanceof Error ? err.message : "生成失败",
                };
            }
        }));

        const succeeded: ListenTogetherMessage[] = [];
        const failed: { id: string; name: string; message: string }[] = [];
        const wantSkip: string[] = [];
        for (const { character, decision, error } of decisions) {
            if (error || !decision) {
                failed.push({
                    id: character.id,
                    name: character.name || "角色",
                    message: error || "生成失败",
                });
                continue;
            }
            succeeded.push({
                characterId: character.id,
                characterName: character.name || "角色",
                characterAvatar: character.avatar ?? null,
                action: decision.skip ? "skip" : "keep",
                content: decision.reason || (decision.skip ? "想切歌" : "想继续听"),
                createdAt: new Date().toISOString(),
            });
            if (decision.skip) wantSkip.push(character.name || "角色");
        }
        for (const message of succeeded) {
            appendListenHistory(requestTrack.id, message);
        }
        // 用户等待期间没有手动切歌，才代劳执行
        if (wantSkip.length > 0 && trackIdRef.current === requestTrack.id) {
            onSkip();
        }
        setMessages(prev => (
            trackIdRef.current === requestTrack.id ? [...prev, ...succeeded] : prev
        ));
        setBusyIds(new Set());
        setActionBusy(null);
        showErrors(failed);
        if (wantSkip.length > 0) {
            onToast?.(`${wantSkip.slice(0, 3).join("、")}${wantSkip.length > 3 ? " 等" : ""}想切歌，已切到下一首`);
        } else if (failed.length === 0) {
            onToast?.("大家想继续听这首");
        }
    }, [busy, selectedChars, track, showErrors, onSkip, onToast]);

    return (
        <div className="lt-page">
            {/* Header */}
            <div className="lt-nav">
                <button className="music-player-close" onClick={onClose}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                        <path d="M15 19 8 12l7-7" />
                    </svg>
                </button>
                <b>一起听</b>
                <span className="lt-nav-sub">选角色陪你听歌</span>
            </div>

            {/* Current track */}
            <div className="lt-song">
                <div className="lt-song-cover">
                    {track.coverUrl ? <img src={track.coverUrl} alt="" /> : (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
                    )}
                </div>
                <div className="lt-song-info">
                    <b>{track.title}</b>
                    <span>{track.artist || "未知歌手"}</span>
                </div>
                <span className="lt-song-wave">{[0, 1, 2].map(i => <i key={i} style={{ animationDelay: `${i * 0.15}s` }} />)}</span>
            </div>

            {/* Role picker */}
            <div className="lt-roles">
                {characters.length === 0 ? (
                    <span className="lt-roles-empty">还没有角色，先去创建一个吧</span>
                ) : (
                    characters.map(c => {
                        const on = selected.has(c.id);
                        const isBusy = busyIds.has(c.id);
                        return (
                            <button
                                key={c.id}
                                className="lt-role"
                                {...(on ? { "data-on": "" } : {})}
                                onClick={() => toggleRole(c.id)}
                                disabled={busy}
                            >
                                <span className="lt-role-ava">
                                    {c.avatar ? <img src={c.avatar} alt="" /> : <i>{(c.name || "?").slice(0, 1)}</i>}
                                    {isBusy && <span className="lt-role-loading" />}
                                </span>
                                <span className="lt-role-name">{c.name || "未命名"}</span>
                            </button>
                        );
                    })
                )}
            </div>

            {/* Actions */}
            <div className="lt-actions">
                <button
                    className="lt-action lt-action-comment"
                    onClick={handleComment}
                    disabled={busy || selectedChars.length === 0}
                >
                    {actionBusy === "comment" ? "评价中…" : "一起评价"}
                </button>
                <button
                    className="lt-action lt-action-skip"
                    onClick={handleSkip}
                    disabled={busy || selectedChars.length === 0}
                >
                    {actionBusy === "skip" ? "决定中…" : "让Ta决定切歌"}
                </button>
            </div>

            {/* Message stream */}
            <div className="lt-stream">
                {messages.length === 0 ? (
                    <div className="lt-empty">
                        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
                        <span>选上面的角色，让TA陪你听这首歌</span>
                    </div>
                ) : (
                    messages.map((m, i) => (
                        <div key={`${m.characterId}-${m.createdAt}-${i}`} className="lt-msg" data-action={m.action}>
                            <div className="lt-msg-ava">
                                {m.characterAvatar ? <img src={m.characterAvatar} alt="" /> : <i>{m.characterName.slice(0, 1)}</i>}
                            </div>
                            <div className="lt-msg-body">
                                <div className="lt-msg-head">
                                    <b>{m.characterName}</b>
                                    <span className="lt-msg-tag">{ACTION_LABEL[m.action]}</span>
                                </div>
                                <div className="lt-msg-text">{m.content}</div>
                                <div className="lt-msg-time">{formatMsgTime(m.createdAt)}</div>
                            </div>
                        </div>
                    ))
                )}
            </div>

            {/* Per-character errors (transient) */}
            {errors.length > 0 && (
                <div className="lt-errors">
                    {errors.map(e => (
                        <div key={e.id} className="lt-error">{e.name} 没有回应：{e.message}</div>
                    ))}
                </div>
            )}
        </div>
    );
}
