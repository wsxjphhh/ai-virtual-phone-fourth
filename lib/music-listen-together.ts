// lib/music-listen-together.ts — 「一起听」核心逻辑
// 选角色陪听歌：角色按人设评价当前歌曲，并可自主决定是否切歌。
// LLM 调用沿用 brief-persona 的模式：simpleLLMCall + 角色聊天绑定解析 API 配置，
// 不走预设系统组装（角色扮演预设会污染这类结构化/短评任务）。

import { simpleLLMCall } from "./api-helpers";
import { loadApiConfigs, loadBindingConfig, resolveBinding, resolveUserIdentity } from "./settings-storage";
import { formatCharacterRelationsForPrompt } from "./character-world-storage";
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
    // 点评同步进角色×歌的情绪记忆（保留最近两句，供下次做"缘分"回灌）
    if (message.action === "comment" && message.content?.trim()) {
        updateMoodEntry(message.characterId, trackId, m => ({
            ...m,
            lastComments: [...m.lastComments, message.content.trim()].slice(-MOOD_COMMENT_KEEP),
        }));
    }
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

// ── 情绪记忆（只记可观测行为信号，不做主观情绪推断） ──
// 记录：这首歌一起听过几次 / 角色上次对它说过什么 / 角色提过几次切歌、被拒几次。
// 这些会喂回 prompt，让角色的态度有连续性，而不是每首都像第一次听。

const MOOD_KEY = "music-listen-together-mood-v1";
registerKvMigration(MOOD_KEY);

export type CharacterTrackMood = {
    listens: number;        // 一起听会话里听到这首歌的次数
    lastHeardAt: string;    // ISO
    lastComments: string[]; // 角色对这首歌最近两句点评
    skipWants: number;      // 角色对这首歌表达过想切的次数（含被拒的）
    deniedSkips: number;    // 其中被用户拒绝的次数
};

type MoodStore = Record<string, Record<string, CharacterTrackMood>>; // characterId -> trackId -> mood

const MOOD_ENTRY_CAP = 300;   // 全部角色的 角色×歌 条目上限
const MOOD_COMMENT_KEEP = 2;  // 每对 角色×歌 保留的点评条数

function loadMoodStore(): MoodStore {
    if (typeof window === "undefined") return {};
    try {
        const raw = kvGet(MOOD_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        return parsed as MoodStore;
    } catch {
        return {};
    }
}

function saveMoodStore(store: MoodStore): void {
    try {
        // 展平后按 lastHeardAt 保留最新的 MOOD_ENTRY_CAP 条
        const flat: Array<{ cid: string; tid: string; mood: CharacterTrackMood }> = [];
        for (const [cid, byTrack] of Object.entries(store)) {
            for (const [tid, mood] of Object.entries(byTrack)) {
                flat.push({ cid, tid, mood });
            }
        }
        if (flat.length > MOOD_ENTRY_CAP) {
            flat.sort((a, b) => Date.parse(b.mood.lastHeardAt) - Date.parse(a.mood.lastHeardAt));
            flat.length = MOOD_ENTRY_CAP;
        }
        const trimmed: MoodStore = {};
        for (const { cid, tid, mood } of flat) {
            (trimmed[cid] ??= {})[tid] = mood;
        }
        kvSet(MOOD_KEY, JSON.stringify(trimmed));
    } catch { /* ignore */ }
}

function getMoodEntry(characterId: string, trackId: string): CharacterTrackMood | null {
    return loadMoodStore()[characterId]?.[trackId] ?? null;
}

function updateMoodEntry(
    characterId: string,
    trackId: string,
    patch: (mood: CharacterTrackMood) => CharacterTrackMood,
): void {
    const store = loadMoodStore();
    const now = new Date().toISOString();
    const prev = store[characterId]?.[trackId] ?? {
        listens: 0, lastHeardAt: now, lastComments: [], skipWants: 0, deniedSkips: 0,
    };
    const next = patch(prev);
    (store[characterId] ??= {})[trackId] = { ...next, lastHeardAt: now };
    saveMoodStore(store);
}

/** 一起听会话里听到这首歌（每个 角色×歌 在一次会话内只应记一次，由调用方去重） */
export function markListenHeard(characterIds: string[], trackId: string): void {
    for (const cid of characterIds) {
        updateMoodEntry(cid, trackId, m => ({ ...m, listens: m.listens + 1 }));
    }
}

/** 角色对这首歌表达了想切（无论最终切没切） */
export function markSkipWanted(characterId: string, trackId: string): void {
    updateMoodEntry(characterId, trackId, m => ({ ...m, skipWants: m.skipWants + 1 }));
}

/** 用户拒绝了切歌提议（对本轮所有提议者记账） */
export function markSkipDenied(characterIds: string[], trackId: string): void {
    for (const cid of characterIds) {
        updateMoodEntry(cid, trackId, m => ({ ...m, deniedSkips: m.deniedSkips + 1 }));
    }
}

/** 把角色的"缘分"组装成 prompt 片段；第一次听这首歌时不占 token，返回空串 */
function buildMoodBlock(character: Character, trackId: string): string {
    const mood = getMoodEntry(character.id, trackId);
    if (!mood) return "";
    const lines: string[] = [];
    if (mood.listens > 1) {
        lines.push(`你和主人已经一起听过这首歌 ${mood.listens} 次了。`);
    }
    const lastComment = mood.lastComments[mood.lastComments.length - 1];
    if (lastComment) {
        lines.push(`你上次对它的评论是：「${lastComment}」`);
    }
    if (mood.deniedSkips > 0) {
        lines.push(`你这歌提过 ${mood.skipWants} 次想切，被主人拒了 ${mood.deniedSkips} 次——这次除非真的忍不了，别再主动提。`);
    }
    if (lines.length === 0) return "";
    return `【你和这首歌的缘分】\n${lines.join("\n")}`;
}

/** 切歌决策的额外倾向提示（只调语气，不替角色做决定） */
function buildSkipBiasBlock(character: Character, trackId: string): string {
    const mood = getMoodEntry(character.id, trackId);
    if (!mood) return "";
    const lines: string[] = [];
    if (mood.listens >= 3) {
        lines.push("听了这么多遍，腻了是正常的，想切不用不好意思。");
    }
    if (mood.deniedSkips > 0 && mood.deniedSkips >= mood.skipWants) {
        lines.push("上次你提切歌被主人拒了，这次真没那么讨厌就别再提。");
    }
    return lines.join("\n");
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

/**
 * 组装「一起听」的扮演上下文：完整世界观+人物关系 + 角色人设 + 性格。
 * 与聊天引擎同源（formatCharacterRelationsForPrompt），之前只喂世界观名称+描述
 * 是角色退化成客服腔的根因。
 */
function buildListenContext(character: Character): string {
    const parts: string[] = [];
    const relations = formatCharacterRelationsForPrompt(character.id);
    if (relations) parts.push(`【你的世界与身边人】\n${relations}`);
    parts.push(`【你是谁】\n${character.persona?.trim() || "（暂无）"}`);
    if (character.personality?.trim()) {
        parts.push(`【你的性格】\n${character.personality.trim()}`);
    }
    return parts.join("\n\n");
}

/** 和角色一起听歌的主人是谁——评论是对 TA 说的，得知道对方是谁 */
function buildUserBlock(characterId: string): string {
    const user = resolveUserIdentity(characterId, "chat");
    const name = user?.name?.trim();
    if (!user || (!name && !user.bio?.trim())) {
        return "【和你一起听歌的人】\n坐在你身边听歌的，是你最亲近的主人。";
    }
    const lines: string[] = [];
    if (name) lines.push(`称呼：${name}`);
    if (user.gender?.trim()) lines.push(`性别：${user.gender.trim()}`);
    if (user.occupation?.trim()) lines.push(`职业：${user.occupation.trim()}`);
    if (user.bio?.trim()) lines.push(`近况：${user.bio.trim().slice(0, 200)}`);
    return `【和你一起听歌的人】\n${lines.join("\n")}`;
}

const EMOTION_KEYWORDS: Array<{ label: string; pattern: RegExp }> = [
    { label: "悲伤低落", pattern: /(悲伤|哭泣|眼泪|泪|伤心|孤独|寂寞|离别|失去|再也)/ },
    { label: "欢快明亮", pattern: /(快乐|开心|欢笑|阳光|温暖|旅行|奔跑|恋爱|喜欢|心动)/ },
    { label: "热血激昂", pattern: /(愤怒|战斗|燃烧|冲破|反抗|不屈|梦想|征服|绝不)/ },
    { label: "温柔舒缓", pattern: /(温柔|轻抚|月光|星空|晚安|微风|宁静|守候)/ },
    { label: "迷茫沉思", pattern: /(迷茫|徘徊|寻找|追问|困惑|为什么|意义|归途)/ },
];

/** 从歌词提取情绪基调；纯音乐/无歌词时明确告知，避免模型瞎引歌词 */
function analyzeSongEmotion(track: MusicTrack): string {
    const plain = (track.lyrics ?? "")
        .replace(/\[\d+:\d+(?:[.:]\d+)?\]/g, "")
        .trim();
    if (!plain) {
        return "没有歌词（纯音乐或歌词未加载），别引用歌词，凭曲名、歌手和旋律氛围来说感受。";
    }
    const hits = EMOTION_KEYWORDS
        .filter(e => e.pattern.test(plain))
        .map(e => e.label);
    const base = hits.length > 0
        ? `歌词整体透着${hits.join("、")}的情绪。`
        : "歌词情绪不明显，偏叙事或抽象。";
    const minutes = Math.max(1, Math.round((track.duration || 0) / 60));
    return `${base}整首大约 ${minutes} 分钟。`;
}

/** 把本首歌已发生的弹幕作为对话上下文，角色才能接话茬而不是各说各的 */
function buildRecentMessagesBlock(messages: ListenTogetherMessage[] | undefined, selfName: string): string {
    const recent = (messages ?? []).filter(m => m.content?.trim()).slice(-4);
    if (recent.length === 0) return "";
    const lines = recent.map(m =>
        m.characterName === selfName ? `你（刚才）：${m.content}` : `${m.characterName}：${m.content}`);
    return [
        `【刚才飘过的弹幕】`,
        ...lines,
        "你可以顺着谁的话茬接一句、抬个杠，也可以只管自己吐槽，别像没听见一样每句都从头评价歌曲。",
    ].join("\n");
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

export type ListenCommentContext = {
    /** 本首歌已发生的一起听弹幕（含角色自己的和别人的），用于接话 */
    recentMessages?: ListenTogetherMessage[];
};

/** 角色对当前歌曲发表一句听感评价（沉浸扮演：完整世界观 + 人设 + 主人信息 + 弹幕上下文） */
export async function generateListenComment(
    character: Character,
    track: MusicTrack,
    ctx?: ListenCommentContext,
): Promise<string> {
    if (!character.persona?.trim() && !character.personality?.trim()) {
        throw new Error("角色还没有设定内容，先填写人设");
    }
    const apiConfig = resolveCharacterApiConfig(character.id);
    const name = character.name?.trim() || "该角色";

    const systemPrompt = [
        `你是「${name}」，此刻正和主人一起窝着用这台小手机放歌听，这不是任务，就是你们俩的日常。`,
        "",
        buildListenContext(character),
        "",
        buildUserBlock(character.id),
        "",
        `【正在放的歌】\n${buildTrackBrief(track)}`,
        analyzeSongEmotion(track),
        buildMoodBlock(character, track.id),
        "",
        buildRecentMessagesBlock(ctx?.recentMessages, name),
        "",
        "想到什么就随口冒一句什么，1~2 句，像发弹幕一样短。",
        "可以哼半句旋律、可以扯到你自己经历或世界观里的事、可以只对主人说话、也可以懒得评价只是叹口气；",
        "别用「为您」「值得一听」这种乐评腔，别每句都在总结歌曲。",
        "只输出这句话本身：不要角色名前缀、不要引号、不要括号说明。",
    ].filter(line => line !== null).join("\n");

    const result = await simpleLLMCall(
        apiConfig,
        [
            { role: "system", content: systemPrompt },
            { role: "user", content: "（音乐正在播放，你说一句。）" },
        ],
        // 思考模型会先烧隐藏思考 token，max_tokens 给足余量避免正文被截空
        { temperature: 0.95, max_tokens: 2048 },
    );
    return ensureContent(result);
}

export type SkipDecision = {
    skip: boolean;
    reason: string;
};

/** 角色自主决定是否切歌（LLM 输出 JSON），reason 即切歌/留歌的理由评价 */
export async function decideListenSkip(
    character: Character,
    track: MusicTrack,
    ctx?: ListenCommentContext,
): Promise<SkipDecision> {
    if (!character.persona?.trim() && !character.personality?.trim()) {
        throw new Error("角色还没有设定内容，先填写人设");
    }
    const apiConfig = resolveCharacterApiConfig(character.id);
    const name = character.name?.trim() || "该角色";

    const systemPrompt = [
        `你是「${name}」，正和主人一起用这台小手机听歌，马上要放到下一首了。`,
        "",
        buildListenContext(character),
        "",
        buildUserBlock(character.id),
        "",
        `【正在放的歌】\n${buildTrackBrief(track)}`,
        analyzeSongEmotion(track),
        buildMoodBlock(character, track.id),
        buildSkipBiasBlock(character, track.id),
        "",
        buildRecentMessagesBlock(ctx?.recentMessages, name),
        "",
        "按你自己的真实喜好决定：这首歌你还想继续听，还是想换下一首？别考虑「客观上」好不好听，就想你自己此刻想不想听。",
        `- 想切歌：{"skip": true, "reason": "你为什么想切，第一人称口语，2句以内"}`,
        `- 想继续听：{"skip": false, "reason": "你想留着它的理由，第一人称口语，2句以内"}`,
        "- 只输出 JSON 本身，不要输出任何其他内容",
    ].join("\n");

    const result = await simpleLLMCall(
        apiConfig,
        [
            { role: "system", content: systemPrompt },
            { role: "user", content: "（下一首要来了，切还是留？）" },
        ],
        { temperature: 0.8, max_tokens: 2048 },
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
