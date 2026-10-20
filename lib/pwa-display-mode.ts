export type PwaDisplayPreference = "fullscreen" | "standalone";
export type RuntimePwaDisplayMode = "fullscreen" | "standalone" | "minimal-ui" | "browser";
export type PwaHostedSurface = "custom-app" | "game";

export type PwaHostedSafeArea = {
  top: string;
  right: string;
  bottom: string;
  left: string;
  /* 宿主顶部浮层（胶囊按钮/悬浮返回钮）所在行的几何：想跟宿主按钮同排摆自己
     顶栏的应用用这组值贴行对齐，只需避开水平占位，不必整体让到 top 之下。 */
  barTop: string;
  barHeight: string;
  barClearLeft: string;
  barClearRight: string;
};

/** 宿主实测的浮层几何（px）；缺项用各表面的估算值兜底。 */
export type PwaHostedOverlayMetrics = {
  topPx?: number | null;
  barTopPx?: number | null;
  barHeightPx?: number | null;
  barClearLeftPx?: number | null;
  barClearRightPx?: number | null;
};

export const PWA_DISPLAY_MODE_COOKIE = "pwa_display_mode";
export const PWA_DISPLAY_MODE_CHANGED_EVENT = "pwa-display-mode-changed";
export const DEFAULT_PWA_DISPLAY_PREFERENCE: PwaDisplayPreference = "fullscreen";

function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function readPwaDisplayPreference(cookie: string): PwaDisplayPreference | null {
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${PWA_DISPLAY_MODE_COOKIE}=([^;]+)`));
  if (!match) return null;
  const value = decodeCookieValue(match[1]);
  return value === "fullscreen" || value === "standalone" ? value : null;
}

export function writePwaDisplayPreference(preference: PwaDisplayPreference) {
  if (typeof document === "undefined") return;
  document.cookie = `${PWA_DISPLAY_MODE_COOKIE}=${preference}; path=/; max-age=31536000; samesite=lax`;
  window.dispatchEvent(new CustomEvent(PWA_DISPLAY_MODE_CHANGED_EVENT, { detail: preference }));
}

/** Preserve the upstream default: mobile browsers request fullscreen unless Edge or explicitly disabled. */
export function shouldRequestPwaFullscreen(): boolean {
  if (typeof document === "undefined" || typeof navigator === "undefined") return false;
  const preference = readPwaDisplayPreference(document.cookie);
  if (preference === "standalone") return false;
  if (preference === "fullscreen") return true;
  return !/Edg/i.test(navigator.userAgent);
}

/** ── 手机端布局判定（唯一入口，CSS 的 phone-shell 媒体查询与此保持同源） ──
 *  竖屏看视口宽度；横屏改看"矮视口 + 触摸"：手机横屏高约 390，平板横屏 600 以上，
 *  用 max-height 能把平板留在桌面舞台。
 *  刻意拆成两条 Level 3 查询而不是用 `or` 分组——老内核解析不了整条查询时会整条判 false，
 *  手机布局会被直接丢掉（这正是"横屏后掉回 390×844 桌面壳、只看得见一小截"的成因）。 */
export const MOBILE_PORTRAIT_MEDIA = "(max-width: 500px) and (hover: none) and (pointer: coarse)";
export const MOBILE_LANDSCAPE_MEDIA =
  "(max-height: 500px) and (orientation: landscape) and (hover: none) and (pointer: coarse)";

export function isMobilePhoneViewport(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia(MOBILE_PORTRAIT_MEDIA).matches
    || window.matchMedia(MOBILE_LANDSCAPE_MEDIA).matches;
}

/** 当前视口是否横向；screen.orientation.type 更准，拿不到时退回宽高比较。 */
function isViewportLandscape(): boolean {
  if (typeof window === "undefined") return false;
  const type = screen?.orientation?.type;
  if (type) return type.startsWith("landscape");
  return window.innerWidth > window.innerHeight;
}

/** 进全屏后把方向锁回竖屏。全屏态才允许 lock，所以只能在 requestFullscreen 成功后调；
 *  iOS Safari 与老内核没有 screen.orientation.lock，catch 掉即可，不影响全屏本身。 */
function lockPortraitIfSupported(): void {
  if (typeof screen === "undefined") return;
  const orientation = screen.orientation as
    (ScreenOrientation & { lock?: (value: string) => Promise<void> }) | undefined;
  if (!orientation?.lock) return;
  try {
    orientation.lock("portrait").catch(() => { });
  } catch {
    /* 部分浏览器在非用户手势里调用会直接 throw，忽略 */
  }
}

/** 沉浸全屏请求：偏好关闭、已在全屏、或视口本来就是横向的（说明方向不归我们管，
 *  再请求只会把画面推进全屏横屏这种没法用的状态）都跳过。 */
export function requestMobileImmersiveFullscreen(): void {
  if (typeof document === "undefined") return;
  if (!shouldRequestPwaFullscreen()) return;
  if (document.fullscreenElement) return;
  if (isViewportLandscape()) return;
  const doc = document.documentElement;
  const request = doc.requestFullscreen?.();
  if (request && typeof request.then === "function") {
    request.then(lockPortraitIfSupported).catch(() => { });
  } else {
    lockPortraitIfSupported();
  }
}

export function getRuntimePwaDisplayMode(): RuntimePwaDisplayMode {
  if (typeof window === "undefined" || typeof document === "undefined") return "browser";
  if (document.fullscreenElement || window.matchMedia("(display-mode: fullscreen)").matches) {
    return "fullscreen";
  }
  if (window.matchMedia("(display-mode: standalone)").matches) {
    return "standalone";
  }
  if (window.matchMedia("(display-mode: minimal-ui)").matches) {
    return "minimal-ui";
  }

  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
  return navigatorWithStandalone.standalone ? "standalone" : "browser";
}

/** 非沉浸布局是否生效：必须用户显式开了「显示系统状态栏」且运行时确实不在全屏。
 *  只看运行时模式是不行的——iOS 装到桌面永远报 standalone，会把没碰过开关的
 *  用户也误判成非沉浸（这正是 pwa-manifest-injector 挂标记前要先过这道门的原因）。 */
export function isNonImmersiveLayoutActive(): boolean {
  if (typeof document === "undefined") return false;
  return readPwaDisplayPreference(document.cookie) === "standalone"
    && getRuntimePwaDisplayMode() !== "fullscreen";
}

/** Safe-area values injected into sandboxed apps, which cannot inherit host CSS variables.
 *  measured：宿主实测的浮层几何，优先于估算值——壳布局以后再调整时数字不会失真。
 *  top 是"完全让开浮层"的保守值；bar* 描述浮层那一行本身，供想同排摆按钮的应用用。 */
export function getPwaHostedSafeArea(surface: PwaHostedSurface, embedded = false, measured?: PwaHostedOverlayMetrics): PwaHostedSafeArea {
  if (embedded) {
    return { top: "0px", right: "0px", bottom: "0px", left: "0px", barTop: "0px", barHeight: "0px", barClearLeft: "0px", barClearRight: "0px" };
  }

  const nonImmersive = isNonImmersiveLayoutActive();
  const px = (value: number | null | undefined, fallback: number) =>
    `${value != null && value > 0 ? Math.round(value) : fallback}px`;
  // 兜底估算与两个浮层的 CSS 定位保持一致（app-market.css 胶囊 / game.css 悬浮返回钮）：
  // top = 浮层 top + 浮层高 + 4px 间隙。浮层的 top 偏移与这段间隙都已从 8px 收到 4px，
  // 兜底值同步跟着减，免得实测拿不到时又冒出一条比实际更宽的留白。
  const isGame = surface === "game";
  return {
    top: px(measured?.topPx, nonImmersive ? (isGame ? 52 : 40) : (isGame ? 84 : 80)),
    right: "16px",
    bottom: "24px",
    left: "16px",
    barTop: px(measured?.barTopPx, isGame ? 38 : (nonImmersive ? 4 : 52)),
    barHeight: px(measured?.barHeightPx, isGame ? 44 : 30),
    barClearLeft: px(measured?.barClearLeftPx, isGame ? 66 : 0),
    barClearRight: px(measured?.barClearRightPx, isGame ? 0 : 96),
  };
}
