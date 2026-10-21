// lib/music-listen-together.ts — 「一起听」核心逻辑
// 选角色陪听歌：角色按人设评价当前歌曲，并可自主决定是否切歌。
// LLM 调用沿用 brief-persona 的模式：simpleLLMCall + 角色聊天绑定解析 API 配置，
// 不走预设系统组装（角色扮演预设会污染这类结构化/短评任务）。

import { simpleLLMCall } from "./api-helpers";
import { loadApiConfigs, loadBindingConfig, resolveBinding } from "./settings-storage";
import { getCharacterWorldGroup } from "./character-world-storage";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import type { ApiConfig } from "./settings-types";
import type { Character } from "./character-types";
import type { MusicTrack } from "./music-storage";

// ── Types ──

export type ListenTogetherAction = "comment" | "skip" | "keep";

export type ListenTogetherMessage = {
    characterId: string;
    characterName: string;
    characterAvatar: string | null;
    action: ListenTogetherAction;
    content: string;
    createdAt: string; // ISO
};

const HISTORY_KEY = "music-listen-together-v1";
const SELECTED_KEY = "music-listen-together-selected-v1";
registerKvMigration(HISTORY_KEY);
registerKvMigration(SELECTED_KEY);

const PER_TRACK_CAP = 50; // 每首歌最多保留的条数
const TRACK_CAP = 30;     // 最多保留多少首歌的历史

// ── Persistence ──

type HistoryMap = Record<string, ListenTogetherMessage[]>;

function loadHistoryMap(): HistoryMap {
    if (typeof window === "undefined") return {};
    try {
        const raw = kvGet(HISTORY_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        return parsed as HistoryMap;
    } catch {
        return {};
    }
}

function persistHistoryMap(map: HistoryMap): void {
    try {
        // 超出歌曲数上限时淘汰最早写入的（对象键序即插入序）
        const keys = Object.keys(map);
        const trimmed: HistoryMap = {};
        for (const key of keys.slice(-TRACK_CAP)) {
            trimmed[key] = map[key].slice(-PER_TRACK_CAP);
        }
        kvSet(HISTORY_KEY, JSON.stringify(trimmed));
    } catch { /* ignore */ }
}

/** 读取某首歌的评价历史（按时间正序） */
export function loadListenHistory(trackId: string): ListenTogetherMessage[] {
    const list = loadHistoryMap()[trackId];
    return Array.isArray(list) ? list : [];
}

/** 追加一条消息到某首歌的历史下 */
export function appendListenHistory(trackId: string, message: ListenTogetherMessage): void {
    const map = loadHistoryMap();
    const prev = Array.isArray(map[trackId]) ? map[trackId] : [];
    map[trackId] = [...prev, message].slice(-PER_TRACK_CAP);
    persistHistoryMap(map);
}

/** 记住用户上次选择的角色，下次开面板自动勾上 */
export function loadSelectedCharacterIds(): string[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(SELECTED_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw) as unknown;
        return Array.isArray(arr) ? arr.filter((v): v is string => typeof v === "string") : [];
    } catch {
        return [];
    }
}

export function saveSelectedCharacterIds(ids: string[]): void {
    try { kvSet(SELECTED_KEY, JSON.stringify(ids.slice(0, 12))); } catch { /* ignore */ }
}

// ── 一起听会话设置（角色 + 随机发言间隔） ──

const SESSION_KEY = "music-listen-together-session-v1";
registerKvMigration(SESSION_KEY);

export type ListenSession = {
    active: boolean;
    characterIds: string[];
    /** 随机自动发言的最小间隔（秒） */
    intervalMin: number;
    /** 随机自动发言的最大间隔（秒） */
    intervalMax: number;
};

export const DEFAULT_LISTEN_SESSION: ListenSession = {
    active: false,
    characterIds: [],
    intervalMin: 8,
    intervalMax: 20,
};

export function loadListenSession(): ListenSession {
    if (typeof window === "undefined") return { ...DEFAULT_LISTEN_SESSION };
    try {
        const raw = kvGet(SESSION_KEY);
        if (!raw) return { ...DEFAULT_LISTEN_SESSION };
        const parsed = JSON.parse(raw) as Partial<ListenSession>;
        const min = Number(parsed.intervalMin);
        const max = Number(parsed.intervalMax);
        return {
            active: parsed.active === true,
            characterIds: Array.isArray(parsed.characterIds)
                ? parsed.characterIds.filter((v): v is string => typeof v === "string")
                : [],
            intervalMin: Number.isFinite(min) && min > 0 ? min : DEFAULT_LISTEN_SESSION.intervalMin,
            intervalMax: Number.isFinite(max) && max >= min ? max : DEFAULT_LISTEN_SESSION.intervalMax,
        };
    } catch {
        return { ...DEFAULT_LISTEN_SESSION };
    }
}

export function saveListenSession(session: ListenSession): void {
    try { kvSet(SESSION_KEY, JSON.stringify(session)); } catch { /* ignore */ }
}

// ── API config resolution ──

/** 解析角色的 API 配置（沿用角色聊天绑定，取不到则抛可读错误） */
export function resolveCharacterApiConfig(characterId: string): ApiConfig {
    const bindings = loadBindingConfig();
    const slot = resolveBinding(bindings, characterId, "chat");
    if (!slot.apiConfigId) {
        throw new Error("尚未绑定 API 配置，请先在绑定设置中为角色配置");
    }
    const apiConfig = loadApiConfigs().find(c => c.id === slot.apiConfigId);
    if (!apiConfig) {
        throw new Error("绑定的 API 配置不存在，请检查绑定设置");
    }
    return apiConfig;
}

// ── Prompt helpers ──

/** 去掉 LRC 时间戳，截取前若干字作为歌词片段 */
export function extractLyricSnippet(lyrics: string | undefined, maxChars = 240): string {
    if (!lyrics?.trim()) return "";
    const plain = lyrics
        .replace(/\[\d+:\d+(?:[.:]\d+)?\]/g, "")
        .split("\n")
        .map(line => line.trim())
        .filter(Boolean)
        .join(" / ");
    return plain.length > maxChars ? `${plain.slice(0, maxChars)}…` : plain;
}

function buildTrackBrief(track: MusicTrack): string {
    const lines = [`歌名：${track.title}`];
    if (track.artist) lines.push(`歌手：${track.artist}`);
    if (track.album) lines.push(`专辑：${track.album}`);
    const snippet = extractLyricSnippet(track.lyrics);
    if (snippet) lines.push(`歌词片段：${snippet}`);
    return lines.join("\n");
}

/** 取出角色所属的世界观（名称 + 描述），没有则返回空串 */
function buildWorldBlock(characterId: string): string {
    const group = getCharacterWorldGroup(characterId);
    if (!group) return "";
    const name = group.name?.trim();
    const desc = group.description?.trim();
    if (!name && !desc) return "";
    if (!desc) return `【世界观】\n${name}`;
    return `【世界观】\n${name}\n${desc}`;
}

/**
 * 组装「一起听」的扮演上下文：世界观 + 角色人设 + 性格。
 * 这是沉浸感的关键——只喂歌名会让模型退化成客服腔。
 */
function buildListenContext(character: Character): string {
    const parts: string[] = [];
    const world = buildWorldBlock(character.id);
    if (world) parts.push(world);
    parts.push(`【角色人设】\n${character.persona?.trim() || "（暂无）"}`);
    if (character.personality?.trim()) {
        parts.push(`【性格】\n${character.personality.trim()}`);
    }
    return parts.join("\n\n");
}

function ensureContent(result: { error?: string; content?: string | null }): string {
    if (result.error || !result.content) {
        throw new Error(result.error || "模型返回了空内容，请重试");
    }
    const text = result.content.trim();
    if (!text) throw new Error("模型返回了空内容，请重试");
    return text;
}

// ── LLM tasks ──

/** 角色对当前歌曲发表一句听感评价（沉浸扮演，会带上世界观与人设） */
export async function generateListenComment(character: Character, track: MusicTrack): Promise<string> {
    if (!character.persona?.trim() && !character.personality?.trim()) {
        throw new Error("角色还没有设定内容，先填写人设");
    }
    const apiConfig = resolveCharacterApiConfig(character.id);
    const name = character.name?.trim() || "该角色";

    const systemPrompt = [
        `你是角色「${name}」，正和你的主人（用户）一起用这台小手机听歌。请完全沉浸到你所属的世界观与自身人设里，用第一人称、口语、符合你性格的方式，对正在播放的歌曲说一句听感。`,
        "",
        buildListenContext(character),
        "",
        "【输出要求】",
        "- 这就是你这个角色本人在随口点评，不是客服、不是乐评人；别用「为您」「为您推荐」这类客套",
        "- 可以自然地把歌曲和你的世界观、你认识的人、你的经历关联起来（但别生硬硬塞）",
        "- 1~2 句话，像发弹幕一样短而自然；可以提到歌名、歌手、歌词意象或曲风",
        "- 只输出这句点评本身：不要加角色名前缀、不要加引号、不要写任何解释或括号说明",
    ].join("\n");

    const result = await simpleLLMCall(
        apiConfig,
        [
            { role: "system", content: systemPrompt },
            { role: "user", content: `正在播放的歌曲：\n${buildTrackBrief(track)}` },
        ],
        // 思考模型会先烧隐藏思考 token，max_tokens 给足余量避免正文被截空
        { temperature: 0.85, max_tokens: 2048 },
    );
    return ensureContent(result);
}

export type SkipDecision = {
    skip: boolean;
    reason: string;
};

/** 角色自主决定是否切歌（LLM 输出 JSON），reason 即切歌/留歌的理由评价 */
export async function decideListenSkip(character: Character, track: MusicTrack): Promise<SkipDecision> {
    if (!character.persona?.trim() && !character.personality?.trim()) {
        throw new Error("角色还没有设定内容，先填写人设");
    }
    const apiConfig = resolveCharacterApiConfig(character.id);
    const name = character.name?.trim() || "该角色";

    const systemPrompt = [
        `你是角色「${name}」，正和主人一起听歌。请完全按你的人设与世界观判断：这首歌听到现在，你想不想切到下一首？`,
        "",
        buildListenContext(character),
        "",
        "【输出要求】",
        `- 想切歌：{\"skip\": true, \"reason\": \"一句符合你人设与世界观的、想切这首歌的理由/吐槽，第一人称口语\"}`,
        `- 想继续听：{\"skip\": false, \"reason\": \"一句符合你人设的、想留着这首歌的话\"}`,
        "- reason 用第一人称口语，2 句以内，可以结合世界观里的设定或你的喜好",
        "- 只输出 JSON 本身，不要输出任何其他内容",
    ].join("\n");

    const result = await simpleLLMCall(
        apiConfig,
        [
            { role: "system", content: systemPrompt },
            { role: "user", content: `正在播放的歌曲：\n${buildTrackBrief(track)}` },
        ],
        { temperature: 0.7, max_tokens: 2048 },
    );
    const text = ensureContent(result);

    // 容错解析：直接 parse → 提取 {...} → 兜底按「不切」处理
    let parsed: unknown = null;
    try {
        parsed = JSON.parse(text);
    } catch {
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
            try { parsed = JSON.parse(match[0]); } catch { parsed = null; }
        }
    }
    if (parsed && typeof parsed === "object") {
        const obj = parsed as { skip?: unknown; reason?: unknown };
        const reason = typeof obj.reason === "string" ? obj.reason.trim() : "";
        return { skip: obj.skip === true, reason };
    }
    // 模型没按 JSON 输出：把原文当理由，默认不切歌（避免误切）
    return { skip: false, reason: text.slice(0, 60) };
}
