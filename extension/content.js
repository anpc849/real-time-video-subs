/* Realtime Vietnamese dub — content script.
 * Every <video> on the page gets its own "VI" button. Clicking it processes THAT video only:
 * its URL goes to the local server, the video is muted, the dubbed audio plays (Web Audio) locked to
 * video.currentTime, the video stalls while the needed chunk is not ready, and Vietnamese subtitles
 * show in a draggable blurred bar. Clicking again, scrolling away, or switching videos stops it. */
(() => {
  if (window.__rtDub) return;
  window.__rtDub = true;

  const SERVER = "http://127.0.0.1:8765";
  const LS_BAR = "rtdub.bar";
  const TICK_MS = 50;
  const DRIFT_S = 0.15;
  const SELF_EVENT_MS = 400; // pause/play events this soon after our own call are ours
  const MIN_VIDEO_W = 150;
  const MIN_VISIBLE = 0.4;

  // ---------- styles injection ----------
  const STYLE_ID = "rtdub-styles";
  if (!document.getElementById(STYLE_ID)) {
    const st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent = `
      .rtdub-btn {
        position: fixed;
        display: none;
        pointer-events: auto;
        z-index: 2147483647;
        height: 32px;
        padding: 0 16px;
        border-radius: 9999px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        font-size: 12.5px;
        font-weight: 700;
        letter-spacing: 0.25px;
        cursor: pointer;
        white-space: nowrap;
        user-select: none;
        touch-action: manipulation;
        transition: transform 0.18s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.18s ease, filter 0.18s ease, background 0.18s ease;
        box-sizing: border-box;
        align-items: center;
        justify-content: center;
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        line-height: 1;
      }
      .rtdub-btn-idle {
        background: linear-gradient(135deg, #ef4444 0%, #dc2626 50%, #b91c1c 100%);
        color: #ffffff;
        border: 1px solid rgba(255, 255, 255, 0.32);
        box-shadow: 0 4px 14px rgba(220, 38, 38, 0.42), 0 2px 6px rgba(0, 0, 0, 0.35);
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
      }
      .rtdub-btn-idle:hover {
        transform: translateY(-1px) scale(1.04);
        filter: brightness(1.12);
        box-shadow: 0 6px 20px rgba(220, 38, 38, 0.58), 0 3px 8px rgba(0, 0, 0, 0.4);
      }
      .rtdub-btn-idle:active {
        transform: translateY(0) scale(0.97);
      }
      .rtdub-btn-active {
        background: linear-gradient(135deg, #10b981 0%, #059669 100%);
        color: #ffffff;
        border: 1px solid rgba(255, 255, 255, 0.38);
        box-shadow: 0 4px 16px rgba(16, 185, 129, 0.48), 0 2px 6px rgba(0, 0, 0, 0.35);
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
      }
      .rtdub-btn-active:hover {
        transform: translateY(-1px) scale(1.03);
        filter: brightness(1.1);
        box-shadow: 0 6px 20px rgba(16, 185, 129, 0.65), 0 3px 8px rgba(0, 0, 0, 0.4);
      }
      .rtdub-btn-active:active {
        transform: translateY(0) scale(0.97);
      }
      .rtdub-pulse {
        display: inline-block;
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #ffffff;
        margin-right: 6px;
        box-shadow: 0 0 8px #ffffff;
        animation: rtdub-blink 1.2s infinite ease-in-out;
      }
      @keyframes rtdub-blink {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.35; transform: scale(0.75); }
      }
      .rtdub-status {
        position: fixed;
        z-index: 2147483647;
        max-width: 320px;
        padding: 6px 16px;
        border-radius: 20px;
        background: rgba(15, 23, 42, 0.92);
        color: #f8fafc;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 12.5px;
        font-weight: 600;
        line-height: 22px;
        letter-spacing: 0.2px;
        text-align: center;
        display: none;
        pointer-events: none;
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(255, 255, 255, 0.18);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
        transition: opacity 0.2s ease, transform 0.2s ease;
      }
      .rtdub-bar {
        position: absolute;
        pointer-events: auto;
        cursor: move;
        display: none;
        box-sizing: border-box;
        width: auto;
        max-width: 84%;
        padding: 6px 14px;
        border-radius: 8px;
        text-align: center;
        color: #ffffff;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        font-weight: 600;
        letter-spacing: 0.25px;
        line-height: 1.4;
        text-shadow: 
          0 1px 2px rgba(0, 0, 0, 0.95),
          0 2px 4px rgba(0, 0, 0, 0.85),
          0 0 10px rgba(0, 0, 0, 0.7);
        background: rgba(0, 0, 0, 0.42);
        backdrop-filter: blur(5px);
        -webkit-backdrop-filter: blur(5px);
        border: 1px solid rgba(255, 255, 255, 0.08);
        box-shadow: 0 2px 12px rgba(0, 0, 0, 0.25);
        user-select: none;
        touch-action: none;
        transition: background 0.15s ease, border-color 0.15s ease;
      }
      .rtdub-bar:hover {
        background: rgba(0, 0, 0, 0.65);
        border-color: rgba(255, 255, 255, 0.2);
      }
      .rtdub-frame {
        position: fixed;
        display: none;
        box-sizing: border-box;
        border: 2.5px solid #10b981;
        border-radius: 8px;
        pointer-events: none;
        box-shadow: 0 0 16px rgba(16, 185, 129, 0.45);
      }
      .rtdub-strip {
        position: absolute;
        left: 0;
        right: 0;
        top: 0;
        height: 3.5px;
        border-radius: 6px 6px 0 0;
        background: rgba(255, 255, 255, 0.25);
        overflow: hidden;
      }
    `;
    (document.head || document.documentElement).appendChild(st);
  }

  // ---------- overlay root (moved into the fullscreen element when needed) ----------
  const root = document.createElement("div");
  root.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483646;";
  const status = document.createElement("div");
  status.className = "rtdub-status";
  const bar = document.createElement("div");
  bar.className = "rtdub-bar";
  bar.title = "Kéo để di chuyển • Cuộn chuột để đổi cỡ chữ • Nháy đúp để đặt lại";

  // Green frame around the video being dubbed, with a thin strip on top showing which parts are processed.
  const frame = document.createElement("div");
  frame.className = "rtdub-frame";
  const strip = document.createElement("div");
  strip.className = "rtdub-strip";
  frame.append(strip);
  root.append(frame, bar, status);

  const mount = () => {
    const host = document.fullscreenElement || document.documentElement;
    if (root.parentNode !== host) host.append(root);
  };
  mount();
  document.addEventListener("fullscreenchange", mount);

  // ---------- geometry helpers ----------
  function contentBox(v) {
    const r = v.getBoundingClientRect();
    let l = r.left, t = r.top, w = r.width, h = r.height;
    if (v.videoWidth && v.videoHeight && getComputedStyle(v).objectFit !== "cover") {
      const k = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
      w = v.videoWidth * k; h = v.videoHeight * k;
      l = r.left + (r.width - w) / 2; t = r.top + (r.height - h) / 2;
    }
    return { l, t, w, h };
  }
  function visibleFraction(b) {
    if (b.w <= 0 || b.h <= 0) return 0;
    const iw = Math.max(0, Math.min(b.l + b.w, innerWidth) - Math.max(b.l, 0));
    const ih = Math.max(0, Math.min(b.t + b.h, innerHeight) - Math.max(b.t, 0));
    return (iw * ih) / (b.w * b.h);
  }

  // ---------- server cancel helper ----------
  function cancelServerJob(jobId) {
    if (!jobId) return;
    try {
      fetch(`${SERVER}/jobs/${jobId}/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
      }).catch(() => {});
    } catch (_) {}
  }

  // ---------- per-video buttons ----------
  const buttons = new Map(); // video -> button element
  const sourceOf = (v) => v.currentSrc || v.src || v.querySelector("source")?.src || "";
  const isPreviewVideo = (v) => {
    if (!v) return false;
    if (v.closest && v.closest("ytd-thumbnail, #preview, ytd-moving-thumbnail-renderer, [id*='preview']")) return true;
    return false;
  };
  const isVerticalFeed = () => {
    return location.hostname.includes("douyin.com") ||
           location.hostname.includes("tiktok.com") ||
           location.pathname.includes("/shorts/");
  };

  const BTN_IDLE_HTML = `<span style="margin-right:5px;font-size:14px;">🇻🇳</span><span>VI · Thuyết minh</span>`;
  function activeLabel(s) {
    const n = s.info?.chunks.length;
    const progress = n ? ` ${s.ready.size}/${n}` : "…";
    return `<span class="rtdub-pulse"></span><span>Đang thuyết minh${progress}</span><span style="margin-left:7px;opacity:0.85;font-size:11px;">✕</span>`;
  }

  function makeButton(v) {
    const b = document.createElement("button");
    b.className = "rtdub-btn rtdub-btn-idle";
    b.__currentHtml = BTN_IDLE_HTML;
    b.innerHTML = BTN_IDLE_HTML;
    b.title = "Thuyết minh tiếng Việt cho video này";
    for (const ev of ["pointerdown", "mousedown", "mouseup", "dblclick"]) {
      b.addEventListener(ev, (e) => e.stopPropagation());
    }
    b.addEventListener("click", (e) => {
      e.stopPropagation(); e.preventDefault();
      if (act && act.video === v) {
        // Prevent accidental toggle-off within first 1.5s of starting
        if (performance.now() - (act.startedAt || 0) < 1500) return;
        stop(act);
      } else {
        start(v);
      }
    });
    // Video-specific play listener: if this video plays and another video is active, stop the other video
    v.addEventListener("play", () => {
      if (act && act.video !== v && !isPreviewVideo(v)) {
        if (performance.now() - (act.startedAt || 0) < 2000) return;
        const bRect = v.getBoundingClientRect();
        if (bRect.width > 250 && bRect.height > 180) {
          console.log("[rtdub] Video khác phát -> dừng video trước");
          stop(act, "Đã chuyển video");
        }
      }
    });
    root.append(b);
    buttons.set(v, b);
  }

  // Global capturing listener: stops previous video only when another substantial video plays
  document.addEventListener("play", (e) => {
    const v = e.target;
    if (v && v.tagName === "VIDEO" && act && act.video !== v && !isPreviewVideo(v)) {
      if (performance.now() - (act.startedAt || 0) < 2000) return;
      const r = v.getBoundingClientRect();
      if (r.width < 250 || r.height < 180) return; // Ignore small thumbnail previews
      console.log("[rtdub] Global play captured on another real video -> stopping active video");
      stop(act, "Đã chuyển video");
    }
  }, true);

  // Monitor SPA URL navigation by video ID / path (ignore irrelevant query params on Douyin, TikTok, YouTube, etc.)
  function videoPageKey(urlStr) {
    try {
      const u = new URL(urlStr, location.href);
      if (u.hostname.includes("youtube.com") || u.hostname.includes("youtu.be")) {
        const v = u.searchParams.get("v");
        if (v) return "yt:" + v;
        const m = u.pathname.match(/\/shorts\/([a-zA-Z0-9_-]+)/);
        if (m) return "yt-shorts:" + m[1];
      }
      if (u.hostname.includes("douyin.com")) {
        const mid = u.searchParams.get("modal_id");
        if (mid) return "douyin:" + mid;
        const m = u.pathname.match(/\/video\/(\d+)/);
        if (m) return "douyin:" + m[1];
      }
      if (u.hostname.includes("bilibili.com")) {
        const m = u.pathname.match(/\/(BV[a-zA-Z0-9]+)/);
        if (m) return "bili:" + m[1];
      }
      if (u.hostname.includes("tiktok.com")) {
        const m = u.pathname.match(/\/video\/(\d+)/);
        if (m) return "tiktok:" + m[1];
      }
      if (u.hostname.includes("coursera.org")) {
        const m = u.pathname.match(/\/lecture\/([a-zA-Z0-9_-]+)/);
        if (m) return "coursera:" + m[1];
        return "coursera:" + u.pathname;
      }
      return u.origin + u.pathname;
    } catch (_) {
      return (urlStr || "").split("?")[0];
    }
  }
  let lastPageKey = videoPageKey(location.href);
  function checkUrlChange() {
    const currentKey = videoPageKey(location.href);
    if (currentKey !== lastPageKey) {
      lastPageKey = currentKey;
      if (act) {
        console.log("[rtdub] Video ID/Path changed -> stopping previous video");
        stop(act, "Đã chuyển video");
      }
    }
  }
  window.addEventListener("popstate", checkUrlChange);
  window.addEventListener("hashchange", checkUrlChange);
  const origPushState = history.pushState;
  if (origPushState) {
    history.pushState = function () {
      origPushState.apply(this, arguments);
      checkUrlChange();
    };
  }
  const origReplaceState = history.replaceState;
  if (origReplaceState) {
    history.replaceState = function () {
      origReplaceState.apply(this, arguments);
      checkUrlChange();
    };
  }
  window.addEventListener("pagehide", () => { if (act) stop(act); });
  window.addEventListener("beforeunload", () => { if (act) stop(act); });

  function syncButtons() {
    mount();
    checkUrlChange();
    for (const v of document.querySelectorAll("video")) {
      if (isPreviewVideo(v)) continue;
      if (!buttons.has(v)) makeButton(v);
    }

    // If an active session exists, monitor whether it was scrolled away or replaced
    if (act && act.video.isConnected) {
      // Grace period: do not auto-stop during first 2.5s of starting
      const age = performance.now() - (act.startedAt || 0);
      if (age > 2500) {
        const actBox = contentBox(act.video);
        const actVis = visibleFraction(actBox);
        const isOffScreen = actBox.t + actBox.h <= 0 || actBox.t >= innerHeight ||
                            actBox.l + actBox.w <= 0 || actBox.l >= innerWidth;

        // On vertical swipe feeds (Douyin, TikTok, YouTube Shorts), auto-stop when scrolled away
        if (isVerticalFeed()) {
          if (isOffScreen || actVis < 0.05) {
            console.log("[rtdub] Video short đã bị cuộn khỏi màn hình -> dừng");
            stop(act, "Đã cuộn qua video khác");
          } else if (actVis < 0.2) {
            act.offScreenSince = act.offScreenSince || performance.now();
            if (performance.now() - act.offScreenSince > 300) {
              console.log("[rtdub] Video short chỉ còn hiển thị < 20% trong > 300ms -> dừng");
              stop(act, "Đã cuộn qua video khác");
            }
          } else {
            act.offScreenSince = 0;
          }
        }

        // Check if another real video has become dominant or is playing in viewport
        if (act) {
          for (const other of document.querySelectorAll("video")) {
            if (other !== act.video && other.isConnected && !isPreviewVideo(other)) {
              const obox = contentBox(other);
              if (obox.w < 250 || obox.h < 180) continue; // Ignore tiny preview videos
              const ovis = visibleFraction(obox);
              if ((!other.paused && ovis > 0.4) || (ovis > 0.65 && actVis < 0.3)) {
                console.log("[rtdub] Phát hiện video khác đang phát/chiếm khung nhìn -> dừng video trước");
                stop(act, "Đã chuyển video");
                break;
              }
            }
          }
        }
      }
    }

    for (const [v, b] of buttons) {
      if (!v.isConnected) {
        b.remove(); buttons.delete(v);
        if (act && act.video === v) stop(act);
        continue;
      }
      const box = contentBox(v);
      const isAct = act && act.video === v;
      if (!isAct && (box.w < MIN_VIDEO_W || visibleFraction(box) < MIN_VISIBLE)) {
        b.style.display = "none";
        continue;
      }
      b.style.display = "inline-flex";
      const pad = 12;
      b.style.left = Math.min(Math.max(pad, box.l + pad), innerWidth - 170) + "px";
      b.style.top = Math.min(Math.max(pad, box.t + pad), innerHeight - 48) + "px";

      const targetHtml = isAct ? activeLabel(act) : BTN_IDLE_HTML;
      if (b.__currentHtml !== targetHtml) {
        b.__currentHtml = targetHtml;
        b.innerHTML = targetHtml;
      }
      const targetClass = isAct ? "rtdub-btn rtdub-btn-active" : "rtdub-btn rtdub-btn-idle";
      if (b.className !== targetClass) b.className = targetClass;
      b.title = isAct ? "Bấm để tắt thuyết minh" : "Thuyết minh tiếng Việt cho video này";
    }
    layoutFrame();
    placeStatus();
  }

  function layoutFrame() {
    if (!act || !act.video.isConnected) { frame.style.display = "none"; return; }
    const { l, t, w, h } = contentBox(act.video);
    if (w < 10) { frame.style.display = "none"; return; }
    frame.style.display = "block";
    frame.style.left = l + "px"; frame.style.top = t + "px";
    frame.style.width = w + "px"; frame.style.height = h + "px";
    const info = act.info;
    const key = info ? act.ready.size + "/" + info.chunks.length : "";
    if (key !== act.stripKey) {
      act.stripKey = key;
      if (!info || !info.duration) { strip.style.background = "rgba(255,255,255,.25)"; return; }
      const stops = info.chunks.map((c) => {
        const a = (c.start / info.duration) * 100, b = (c.end / info.duration) * 100;
        const col = act.ready.has(c.i) ? "#10b981" : "rgba(255,255,255,.25)";
        return `${col} ${a}% ${b}%`;
      });
      strip.style.background = `linear-gradient(to right, ${stops.join(",")})`;
    }
  }

  // ---------- status text ----------
  let statusTimer = null;
  function setStatus(msg, ttl = 0) {
    status.textContent = msg || "";
    status.style.display = msg ? "block" : "none";
    clearTimeout(statusTimer);
    if (msg && ttl) statusTimer = setTimeout(() => setStatus(""), ttl);
    placeStatus();
  }
  function placeStatus() {
    if (status.style.display === "none") return;
    if (act && act.video.isConnected) { // centred on the video being dubbed
      const { l, t, w, h } = contentBox(act.video);
      status.style.left = l + w / 2 - status.offsetWidth / 2 + "px";
      status.style.top = t + h / 2 - status.offsetHeight / 2 + "px";
      return;
    }
    const b = lastVideo && buttons.get(lastVideo);
    if (!b || b.style.display === "none") return;
    const r = b.getBoundingClientRect();
    status.style.left = r.left + "px";
    status.style.top = r.bottom + 8 + "px";
  }
  let lastVideo = null;

  // ---------- subtitle bar (shared position preference) ----------
  let barCfg = { cx: 0.5, cy: 0.86, w: 0.84, fs: 0.034 }; // ratios of the video content box
  try { Object.assign(barCfg, JSON.parse(localStorage.getItem(LS_BAR) || "{}")); } catch (_) {}
  const saveBar = () => localStorage.setItem(LS_BAR, JSON.stringify(barCfg));

  function layoutBar() {
    if (!act || !act.video.isConnected) { bar.style.display = "none"; return; }
    const { l, t, w: cw, h: ch } = contentBox(act.video);
    if (cw < 10) return;
    const maxW = cw * (barCfg.w || 0.84);
    bar.style.maxWidth = maxW + "px";
    bar.style.width = "auto";
    bar.style.fontSize = Math.max(13, ch * barCfg.fs) + "px";
    const barW = bar.offsetWidth || 160;
    const barH = bar.offsetHeight || 32;
    bar.style.left = Math.round(l + cw * barCfg.cx - barW / 2) + "px";
    bar.style.top = Math.round(t + ch * barCfg.cy - barH / 2) + "px";
    bar.dataset.box = [l, t, cw, ch].join(",");
  }
  let drag = null;
  bar.addEventListener("pointerdown", (e) => {
    const [l, t, cw, ch] = bar.dataset.box.split(",").map(Number);
    drag = { box: [l, t, cw, ch], dx: e.clientX - (l + cw * barCfg.cx), dy: e.clientY - (t + ch * barCfg.cy) };
    bar.setPointerCapture(e.pointerId);
    e.preventDefault(); e.stopPropagation();
  });
  bar.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const [l, t, cw, ch] = drag.box;
    barCfg.cx = Math.min(1, Math.max(0, (e.clientX - drag.dx - l) / cw));
    barCfg.cy = Math.min(1, Math.max(0, (e.clientY - drag.dy - t) / ch));
    layoutBar();
  });
  bar.addEventListener("pointerup", () => { if (drag) { drag = null; saveBar(); } });
  bar.addEventListener("dblclick", () => { barCfg = { cx: 0.5, cy: 0.86, w: 0.84, fs: 0.034 }; saveBar(); layoutBar(); });
  bar.addEventListener("wheel", (e) => {
    e.preventDefault(); e.stopPropagation();
    barCfg.fs = Math.min(0.08, Math.max(0.018, barCfg.fs * (e.deltaY < 0 ? 1.08 : 0.93)));
    saveBar(); layoutBar();
  }, { passive: false });

  function renderSub() {
    if (!act || !act.info) { bar.style.display = "none"; return; }
    const t = act.video.currentTime;
    const sub = act.info.subs.find((s) => t >= s.start - 0.05 && t <= s.end + 0.35);
    if (sub) {
      if (bar.textContent !== sub.vi) bar.textContent = sub.vi;
      bar.style.display = "inline-block";
      layoutBar();
    } else {
      bar.style.display = "none";
    }
  }

  // ---------- media URL discovery & transcript extraction ----------
  const MEDIA_RE = /douyinvod|bytevod|zjcdn|\.mp4|\.m4s|\.m3u8|\.ts|\.webm|mime_type=video|video_mp4|\/video\/tos\/|googlevideo|videoplayback|cloudfront|coursera/i;
  const NOT_MEDIA_RE = /\.(js|css|jpe?g|png|webp|gif|svg|woff2?|json)(\?|$)|\/(image|img)\//i;

  let resolveSeq = 0;
  let lastInterceptedSubtitles = {};

  function parseVtt(text) {
    if (!text || typeof text !== "string") return [];
    const cues = [];
    const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    const timeRegex = /(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{3})/;
    const parseSec = (h, m, s, ms) => (parseInt(h || "0", 10) * 3600) + (parseInt(m, 10) * 60) + parseInt(s, 10) + (parseInt(ms, 10) / 1000);
    let currentCue = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        if (currentCue && currentCue.text) { cues.push(currentCue); currentCue = null; }
        continue;
      }
      const match = trimmed.match(timeRegex);
      if (match) {
        if (currentCue && currentCue.text) cues.push(currentCue);
        currentCue = { start: parseSec(match[1], match[2], match[3], match[4]), end: parseSec(match[5], match[6], match[7], match[8]), text: "" };
      } else if (currentCue && !trimmed.startsWith("NOTE") && !trimmed.startsWith("WEBVTT")) {
        if (/^\d+$/.test(trimmed)) continue;
        const cleanText = trimmed.replace(/<[^>]+>/g, "").trim();
        if (cleanText) currentCue.text = currentCue.text ? currentCue.text + " " + cleanText : cleanText;
      }
    }
    if (currentCue && currentCue.text) cues.push(currentCue);
    return cues;
  }

  function fetchPageSubtitles() {
    return new Promise((resolve) => {
      const id = ++resolveSeq;
      const done = (e) => {
        if (e.source !== window || !e.data || e.data.rtdub !== "subtitles_resolved" || e.data.id !== id) return;
        window.removeEventListener("message", done);
        if (e.data.subtitles) lastInterceptedSubtitles = e.data.subtitles;
        resolve(e.data.subtitles || {});
      };
      window.addEventListener("message", done);
      window.postMessage({ rtdub: "get_subtitles", id }, "*");
      setTimeout(() => { window.removeEventListener("message", done); resolve(lastInterceptedSubtitles); }, 400);
    });
  }

  async function extractVideoTranscript(v) {
    try {
      // Strategy 1: HTML5 textTracks on the video element
      if (v.textTracks && v.textTracks.length > 0) {
        const tracks = Array.from(v.textTracks);
        const viTrack = tracks.find((t) => (t.language || "").toLowerCase().startsWith("vi") || /vi[eệ]/i.test(t.label || ""));
        const enTrack = tracks.find((t) => (t.language || "").toLowerCase().startsWith("en") || /eng/i.test(t.label || ""));
        const targetTrack = viTrack || enTrack || tracks[0];
        if (targetTrack) {
          if (targetTrack.mode === "disabled") {
            try { targetTrack.mode = "hidden"; } catch (_) {}
          }
          if (!targetTrack.cues || targetTrack.cues.length === 0) {
            await new Promise((r) => setTimeout(r, 200));
          }
          if (targetTrack.cues && targetTrack.cues.length > 0) {
            const lang = (targetTrack === viTrack ? "vi" : (targetTrack === enTrack ? "en" : (targetTrack.language || "en"))).toLowerCase().slice(0, 2);
            const cues = Array.from(targetTrack.cues).map((c) => ({
              start: Number(c.startTime.toFixed(2)),
              end: Number(c.endTime.toFixed(2)),
              text: (c.text || "").replace(/<[^>]+>/g, "").trim()
            })).filter((c) => c.text);
            if (cues.length > 0) {
              console.log(`[rtdub] Extracted ${cues.length} cues from video.textTracks (${lang})`);
              return { lang, cues };
            }
          }
        }
      }

      // Strategy 2: <track> DOM elements inside the video
      const trackEls = Array.from(v.querySelectorAll("track"));
      if (trackEls.length > 0) {
        const viEl = trackEls.find((el) => (el.srclang || "").toLowerCase().startsWith("vi") || /vi[eệ]/i.test(el.label || ""));
        const enEl = trackEls.find((el) => (el.srclang || "").toLowerCase().startsWith("en") || /eng/i.test(el.label || ""));
        const targetEl = viEl || enEl || trackEls[0];
        if (targetEl && targetEl.src) {
          try {
            const res = await fetch(targetEl.src);
            if (res.ok) {
              const text = await res.text();
              const cues = parseVtt(text);
              if (cues.length > 0) {
                const lang = (targetEl === viEl ? "vi" : (targetEl === enEl ? "en" : (targetEl.srclang || "en"))).toLowerCase().slice(0, 2);
                console.log(`[rtdub] Extracted ${cues.length} cues from <track src> (${lang})`);
                return { lang, cues };
              }
            }
          } catch (e) {
            console.warn("[rtdub] Failed fetching track src:", e);
          }
        }
      }

      // Strategy 3: Intercepted network subtitles from page_hook
      const intercepted = await fetchPageSubtitles();
      const subEntries = Object.entries(intercepted);
      if (subEntries.length > 0) {
        const viEntry = subEntries.find(([url]) => /vi[-_]?(vn)?\.(vtt|srt)/i.test(url) || /vietnamese/i.test(url));
        const enEntry = subEntries.find(([url]) => /en[-_]?(us|uk)?\.(vtt|srt)/i.test(url) || /english/i.test(url));
        const [chosenUrl, chosenText] = viEntry || enEntry || subEntries[0];
        const cues = parseVtt(chosenText);
        if (cues.length > 0) {
          const lang = viEntry ? "vi" : (enEntry ? "en" : "auto");
          console.log(`[rtdub] Extracted ${cues.length} cues from intercepted subtitle (${lang})`);
          return { lang, cues };
        }
      }

      // Strategy 4: Coursera interactive transcript DOM elements
      const transcriptCues = document.querySelectorAll(
        ".rc-TranscriptCue, button[data-testid='transcript-cue'], .rc-TranscriptSegment, .c-transcript-line"
      );
      if (transcriptCues.length > 0) {
        const cues = [];
        const parseTimeStr = (tStr) => {
          const parts = tStr.trim().split(":").map(Number);
          if (parts.some(isNaN)) return null;
          if (parts.length === 2) return parts[0] * 60 + parts[1];
          if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
          return null;
        };

        let sampleText = "";
        for (let i = 0; i < transcriptCues.length; i++) {
          const el = transcriptCues[i];
          const timeEl = el.querySelector(".rc-TranscriptCue__timestamp, .timestamp, [class*='timestamp'], [class*='time']");
          let start = null;
          let text = "";
          if (timeEl) {
            start = parseTimeStr(timeEl.textContent);
            const clone = el.cloneNode(true);
            const cloneTime = clone.querySelector(".rc-TranscriptCue__timestamp, .timestamp, [class*='timestamp'], [class*='time']");
            if (cloneTime) cloneTime.remove();
            text = clone.textContent.replace(/\s+/g, " ").trim();
          } else {
            const match = el.textContent.match(/(\d{1,2}:\d{2}(?::\d{2})?)/);
            if (match) {
              start = parseTimeStr(match[1]);
              text = el.textContent.replace(match[0], "").replace(/\s+/g, " ").trim();
            } else {
              text = el.textContent.replace(/\s+/g, " ").trim();
            }
          }
          if (text) {
            sampleText += " " + text;
            cues.push({ start, text });
          }
        }

        for (let i = 0; i < cues.length; i++) {
          if (cues[i].start === null) cues[i].start = i > 0 ? cues[i - 1].end : 0;
          cues[i].end = (i + 1 < cues.length && cues[i + 1].start !== null)
            ? cues[i + 1].start
            : cues[i].start + Math.max(2.0, cues[i].text.split(" ").length * 0.35);
        }

        if (cues.length > 0 && cues[0].start !== null) {
          const isVi = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i.test(sampleText);
          const lang = isVi ? "vi" : "en";
          console.log(`[rtdub] Extracted ${cues.length} cues from Coursera transcript DOM (${lang})`);
          return { lang, cues };
        }
      }
    } catch (e) {
      console.warn("[rtdub] Error extracting transcript:", e);
    }
    return null;
  }

  // Ask page_hook.js (page world) which URLs fed this blob video's MediaSource: exact, no guessing.
  function resolveBlob(blob) {
    return new Promise((resolve) => {
      const id = ++resolveSeq;
      const done = (e) => {
        if (e.source !== window || !e.data || e.data.rtdub !== "resolved" || e.data.id !== id) return;
        window.removeEventListener("message", done);
        if (e.data.subtitles) lastInterceptedSubtitles = e.data.subtitles;
        resolve(e.data);
      };
      window.addEventListener("message", done);
      window.postMessage({ rtdub: "resolve", id, blob }, "*");
      setTimeout(() => { window.removeEventListener("message", done); resolve({ urls: [] }); }, 1000);
    });
  }

  // Direct URL when the element has one; otherwise the exact URLs behind its blob (MSE) source; the
  // Resource Timing scan is only a last resort.
  async function mediaCandidates(v) {
    // YouTube: send video URL directly to local server (resolved via yt-dlp to avoid 403)
    if (location.hostname.includes("youtube.com") || location.hostname.includes("youtu.be")) {
      const vidMatch = location.href.match(/[?&]v=([a-zA-Z0-9_-]+)/) || location.pathname.match(/\/shorts\/([a-zA-Z0-9_-]+)/);
      const url = vidMatch ? (location.origin + (vidMatch[0].startsWith("/shorts") ? vidMatch[0] : `/watch?v=${vidMatch[1]}`)) : location.href;
      return { urls: [url], exact: true };
    }

    const direct = [v.currentSrc, v.src, ...[...v.querySelectorAll("source")].map((s) => s.src)]
      .filter((u) => u && !u.startsWith("blob:"));
    if (direct.length) return { urls: [...new Set(direct)], exact: true };
    const blob = v.currentSrc || v.src;
    if (blob.startsWith("blob:")) {
      const r = await resolveBlob(blob);
      console.log("[rtdub] MSE buffers:", r.buffers, "urls:", r.urls);
      if (r.urls?.length) return { urls: r.urls, exact: true };
    }
    const seen = new Set(), out = [];
    const entries = performance.getEntriesByType("resource")
      .filter((e) => MEDIA_RE.test(e.name) && !NOT_MEDIA_RE.test(e.name));
    for (const e of entries.reverse()) {
      const u = e.name.startsWith("//") ? location.protocol + e.name : e.name;
      const key = u.split("?")[0];
      if (!seen.has(key)) { seen.add(key); out.push(u); }
      if (out.length >= 6) break;
    }
    return { urls: out, exact: false };
  }

  // ---------- active session (only one video at a time) ----------
  let act = null;
  let ctx = null;
  const audioCtx = () => {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  };

  function isAdPlaying(v) {
    const player = v?.closest(".html5-video-player") || document.getElementById("movie_player");
    if (player && (player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting"))) {
      return true;
    }
    const adOverlay = document.querySelector(".ytp-ad-player-overlay, .ytp-ad-text, .ytp-ad-preview-container");
    if (adOverlay && adOverlay.offsetParent !== null) {
      return true;
    }
    return false;
  }

  function pauseSelf(s) {
    s.waiting = true;
    s.selfAt = performance.now();
    if (s.video.paused) return;
    s.video.pause();
  }
  function resumeSelf(s) {
    s.waiting = false;
    s.selfAt = performance.now();
    if (!s.video.paused) return;
    s.video.play().catch(() => {});
  }

  function start(v) {
    if (act) stop(act);
    audioCtx(); // created inside the click gesture so playback is allowed
    const inAd = isAdPlaying(v);
    const s = {
      video: v, srcKey: sourceOf(v), jobId: null, creating: false, info: null, ready: new Set(),
      buffers: new Map(), decoding: new Set(), playing: null, muteBackup: v.muted,
      userPaused: false, waiting: false, prerolled: false, lastPoll: 0, lastTry: 0, lastSeekSent: -1, selfAt: 0,
      seekAt: 0, stripKey: "", offScreenSince: 0, startedAt: performance.now(), adPlaying: inAd,
    };
    // A pause fired by the page while the user drags the progress bar or while waiting for chunks is not a user paused intent.
    s.onPause = () => {
      if (s.waiting || s.adPlaying) return;
      if (performance.now() - s.selfAt > 800 && !v.seeking && performance.now() - s.seekAt > 600) {
        s.userPaused = true;
      }
    };
    s.onPlay = () => { if (performance.now() - s.selfAt > 800) s.userPaused = false; };
    s.onSeeking = () => { s.seekAt = performance.now(); stopAudio(s); maybeSeek(s, v.currentTime); };
    v.addEventListener("pause", s.onPause);
    v.addEventListener("play", s.onPlay);
    v.addEventListener("seeking", s.onSeeking);
    act = s;
    lastVideo = v;
    if (!inAd) {
      v.muted = true;
      pauseSelf(s); // hold the video until the first dubbed chunk is ready
      if (v.currentTime <= 1.5 && v.currentTime > 0.05) v.currentTime = 0;
      setStatus("Đang chuẩn bị thuyết minh…");
    } else {
      v.muted = false;
      setStatus("Đang phát quảng cáo… Thuyết minh sẽ tự bật khi vào video");
    }
    createJob(s);
    syncButtons();
  }

  function stop(s, msg = "") {
    if (!s) return;
    const jobId = s.jobId;
    stopAudio(s);
    const v = s.video;
    try {
      v.removeEventListener("pause", s.onPause);
      v.removeEventListener("play", s.onPlay);
      v.removeEventListener("seeking", s.onSeeking);
    } catch (_) {}
    v.muted = s.muteBackup;
    if (v.isConnected && !s.userPaused && visibleFraction(contentBox(v)) > 0.2) {
      resumeSelf(s);
    }
    if (act === s) act = null;
    s.jobId = null;
    s.buffers.clear();
    s.decoding.clear();
    bar.style.display = "none";
    frame.style.display = "none";
    setStatus(msg, msg ? 3000 : 0);
    syncButtons();

    // Notify server to cancel GPU/ASR/TTS processing immediately
    if (jobId) {
      cancelServerJob(jobId);
    }
  }

  async function createJob(s) {
    s.lastTry = performance.now();
    const v = s.video;
    s.creating = true;
    const { urls, exact } = await mediaCandidates(v);
    if (act !== s) { s.creating = false; return; }
    console.log("[rtdub] video src:", s.srcKey, "candidates:", urls, "exact:", exact);
    if (!urls.length) {
      s.creating = false;
      if (act === s) setStatus("Chưa tìm thấy URL media (" + (s.srcKey.startsWith("blob:") ? "blob/MSE" : "chưa có nguồn") + "), đang thử lại…");
      return;
    }
    // Look for existing transcript on page (Coursera, YouTube, etc.)
    const transcriptData = await extractVideoTranscript(v);
    if (act !== s) { s.creating = false; return; }
    if (transcriptData && transcriptData.cues.length > 0) {
      console.log(`[rtdub] Sử dụng transcript có sẵn (${transcriptData.cues.length} đoạn, ngôn ngữ: ${transcriptData.lang})`);
      setStatus(`Tìm thấy transcript (${transcriptData.lang === "vi" ? "Tiếng Việt" : "Gốc"})… Đang gửi tới server`);
    } else {
      setStatus("Đang gửi video tới server…");
    }

    try {
      const startSec = v.currentTime > 1.5 ? v.currentTime : 0;
      const res = await fetch(`${SERVER}/jobs`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          urls,
          exact,
          duration: isFinite(v.duration) ? v.duration : 0,
          referer: location.origin + "/",
          start: startSec,
          transcript: transcriptData ? transcriptData.cues : null,
          transcript_lang: transcriptData ? transcriptData.lang : null,
        }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const id = (await res.json()).job_id;
      if (act === s) {
        s.jobId = id;
      } else {
        // Cancel if user already stopped/switched while request was in-flight
        cancelServerJob(id);
      }
    } catch (e) {
      console.warn("[rtdub] create job failed", e);
      if (act === s) setStatus("Không kết nối được server local (127.0.0.1:8765)");
    } finally { s.creating = false; }
  }

  async function poll(s) {
    if (!s.jobId || act !== s) return;
    try {
      const info = await (await fetch(`${SERVER}/jobs/${s.jobId}`)).json();
      if (act !== s) return;
      s.info = info;
      s.ready = new Set(info.chunks.filter((c) => c.ready).map((c) => c.i));
    } catch (_) { if (act === s) setStatus("Không kết nối được server local (127.0.0.1:8765)"); }
  }

  function maybeSeek(s, t) {
    s.lastSeekSent = t;
    if (s.jobId) {
      fetch(`${SERVER}/jobs/${s.jobId}/seek`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ t }),
      }).catch(() => {});
    }
  }

  // ---------- audio playback ----------
  const chunkAt = (s, t) => s.info?.chunks.find((c) => t >= c.start && t < c.end) || null;

  function stopAudio(s) {
    if (s.playing) { try { s.playing.src.stop(); } catch (_) {} s.playing = null; }
  }

  async function loadChunk(s, i) {
    if (s.buffers.has(i) || s.decoding.has(i) || act !== s) return;
    s.decoding.add(i);
    const job = s.jobId;
    try {
      const res = await fetch(`${SERVER}/jobs/${job}/chunks/${i}.wav`);
      if (!res.ok) throw new Error("chunk " + res.status);
      const buf = await audioCtx().decodeAudioData(await res.arrayBuffer());
      if (act === s && job === s.jobId) s.buffers.set(i, buf);
    } catch (e) { console.warn("[rtdub] chunk load failed", i, e); }
    finally { s.decoding.delete(i); }
  }

  function playFrom(s, c, t) {
    stopAudio(s);
    const buf = s.buffers.get(c.i);
    if (!buf) return;
    const cx = audioCtx();
    const src = cx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = s.video.playbackRate || 1;
    src.connect(cx.destination);
    src.start(0, Math.min(Math.max(0, t - c.start), buf.duration - 0.01));
    s.playing = { src, chunk: c.i, ctx0: cx.currentTime, vt0: t, rate: src.playbackRate.value };
  }

  // ---------- main loop ----------
  function tick() {
    const s = act;
    if (!s) return;
    const v = s.video;
    if (!v.isConnected) { stop(s); return; }

    // Check if an ad is currently playing (YouTube pre-roll / mid-roll ads)
    const inAd = isAdPlaying(v);
    if (inAd) {
      if (!s.adPlaying) {
        console.log("[rtdub] Phát hiện quảng cáo -> tạm dừng thuyết minh, giữ nguyên tiến trình");
        s.adPlaying = true;
        stopAudio(s);
        v.muted = false; // Let user hear ad audio normally
        bar.style.display = "none";
        frame.style.display = "none";
        setStatus("Đang phát quảng cáo… Thuyết minh sẽ tự tiếp tục sau khi hết quảng cáo");
      }
      return; // Do not process main video chunks while ad is playing
    } else if (s.adPlaying) {
      console.log("[rtdub] Quảng cáo kết thúc -> khôi phục thuyết minh video chính");
      s.adPlaying = false;
      s.srcKey = sourceOf(v); // Re-bind to main video source in case ad changed it
      v.muted = true;
      setStatus("");
      layoutFrame();
    }

    const cur = sourceOf(v);
    if (!s.srcKey && cur) s.srcKey = cur;
    else if (cur !== s.srcKey) {
      const isYt = location.hostname.includes("youtube.com") || location.hostname.includes("youtu.be");
      if (inAd || isYt) {
        s.srcKey = cur;
      } else {
        stop(s, "Đã đổi nguồn video");
        return;
      }
    } // the page loaded a different video into this element

    // Immediate check if video scrolled completely off screen (only on vertical short feeds)
    if (isVerticalFeed()) {
      const box = contentBox(v);
      if (box.t + box.h <= 0 || box.t >= innerHeight || box.l + box.w <= 0 || box.l >= innerWidth) {
        stop(s, "Đã cuộn qua video khác");
        return;
      }
    }

    v.muted = true;
    layoutBar();
    layoutFrame();

    const now = performance.now();
    if (!s.jobId && !s.creating && now - s.lastTry > 1500) createJob(s);
    if (s.jobId && now - s.lastPoll > 700) { s.lastPoll = now; poll(s); }
    const info = s.info;
    if (!info) return;
    if (info.state === "error") { stop(s, "Lỗi server: " + info.error); return; }

    const t = v.currentTime;
    const c = chunkAt(s, t);
    if (!c) return;
    if (s.ready.has(c.i)) loadChunk(s, c.i);
    for (let k = 1; k <= 2; k++) if (s.ready.has(c.i + k)) loadChunk(s, c.i + k);

    if (!s.buffers.has(c.i)) { // needed chunk not decoded yet -> stall (unless the user paused)
      if (!s.userPaused) pauseSelf(s);
      stopAudio(s);
      setStatus(s.prerolled ? `Đang xử lý đoạn ${c.i + 1}/${info.chunks.length}…` : "Đang chuẩn bị thuyết minh…");
      if (Math.abs(t - s.lastSeekSent) > 1) maybeSeek(s, t);
      return;
    }
    if (!s.prerolled) s.prerolled = true;
    setStatus("");
    if (s.waiting && !s.userPaused) resumeSelf(s);

    if (v.paused || v.seeking) { stopAudio(s); return; }
    const a = s.playing;
    if (!a || a.chunk !== c.i) { playFrom(s, c, t); return; }
    const expected = a.vt0 + (ctx.currentTime - a.ctx0) * a.rate;
    if (Math.abs(expected - t) > DRIFT_S || a.rate !== (v.playbackRate || 1)) playFrom(s, c, t);
  }

  setInterval(syncButtons, 200);
  setInterval(() => { tick(); renderSub(); }, TICK_MS);
  window.addEventListener("resize", () => { syncButtons(); layoutBar(); });
})();
