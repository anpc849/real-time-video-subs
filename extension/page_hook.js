/* Runs in the page's own JS world at document_start (see manifest). For blob:/MSE players it records which
 * network response fed which SourceBuffer, so a <video> can be traced to the exact URL(s) it plays:
 *   video.src (blob:) -> MediaSource -> SourceBuffer(s) -> request whose first bytes equal the appended bytes.
 * content.js asks through window.postMessage ({rtdub:"resolve", id, blob}) and gets {rtdub:"resolved", id, urls}. */
(() => {
  if (window.__rtDubHook) return;
  window.__rtDubHook = true;

  const FP_BYTES = 128;
  const fpToUrl = new Map(); // fingerprint -> url (bounded)
  const pending = []; // appended data waiting for its request to be recorded: {info, fp}
  const msByBlob = new Map(); // blob URL -> MediaSource
  const buffersOf = new WeakMap(); // MediaSource -> [info]
  const infoOf = new WeakMap(); // SourceBuffer -> info {mime, url}

  function fingerprint(u8) {
    if (!u8 || u8.length < FP_BYTES) return null;
    let h = 2166136261;
    for (let i = 0; i < FP_BYTES; i++) h = Math.imul(h ^ u8[i], 16777619) >>> 0;
    return h + ":" + u8[0] + u8[1] + u8[2] + u8[3];
  }

  function register(fp, url) {
    if (!fp || !url) return;
    fpToUrl.set(fp, url);
    if (fpToUrl.size > 400) fpToUrl.delete(fpToUrl.keys().next().value);
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i].fp === fp) { pending[i].info.url ||= url; pending.splice(i, 1); }
    }
  }

  // ---- MediaSource bookkeeping ----
  const origCreate = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const url = origCreate.apply(this, arguments);
    if (typeof MediaSource !== "undefined" && obj instanceof MediaSource) msByBlob.set(url, obj);
    return url;
  };

  const origAdd = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    const sb = origAdd.apply(this, arguments);
    const info = { mime: String(mime), url: "" };
    infoOf.set(sb, info);
    if (!buffersOf.has(this)) buffersOf.set(this, []);
    buffersOf.get(this).push(info);
    return sb;
  };

  const origAppend = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    const info = infoOf.get(this);
    if (info && !info.url) {
      try {
        const u8 = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const fp = fingerprint(u8);
        if (fp) {
          if (fpToUrl.has(fp)) info.url = fpToUrl.get(fp);
          else if (pending.length < 50) pending.push({ info, fp });
        }
      } catch (_) {}
    }
    return origAppend.apply(this, arguments);
  };

  // ---- record the first bytes of media responses and capture subtitles ----
  const MEDIA_TYPE = /video|audio|octet-stream|mp4|mpegurl|binary/i;
  const SUBTITLE_RE = /\.(vtt|srt)($|\?)|subtitles|timedtext/i;
  window.__rtDubSubtitles = window.__rtDubSubtitles || {};

  const origFetch = window.fetch;
  window.fetch = function (input) {
    const p = origFetch.apply(this, arguments);
    p.then((res) => {
      try {
        const url = res.url || (typeof input === "string" ? input : input?.url || "");
        if (url && SUBTITLE_RE.test(url)) {
          res.clone().text().then((txt) => {
            if (txt && (txt.includes("WEBVTT") || txt.includes("-->"))) {
              window.__rtDubSubtitles[url] = txt;
            }
          }).catch(() => {});
        }
        if (!res.ok || !MEDIA_TYPE.test(res.headers.get("content-type") || "")) return;
        const reader = res.clone().body.getReader();
        const parts = [];
        let n = 0;
        const step = () => reader.read().then(({ done, value }) => {
          if (value) { parts.push(value); n += value.length; }
          if (done || n >= FP_BYTES) {
            const u8 = new Uint8Array(Math.min(n, FP_BYTES));
            let o = 0;
            for (const part of parts) { const k = Math.min(part.length, u8.length - o); u8.set(part.subarray(0, k), o); o += k; if (o >= u8.length) break; }
            register(fingerprint(u8), url);
            reader.cancel().catch(() => {});
          } else step();
        });
        step().catch(() => {});
      } catch (_) {}
    }).catch(() => {});
    return p;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__rtUrl = url;
    this.addEventListener("load", () => {
      try {
        const fullUrl = new URL(this.responseURL || this.__rtUrl, location.href).href;
        if (SUBTITLE_RE.test(fullUrl) && typeof this.responseText === "string") {
          const txt = this.responseText;
          if (txt && (txt.includes("WEBVTT") || txt.includes("-->"))) {
            window.__rtDubSubtitles[fullUrl] = txt;
          }
        }
        if (this.responseType === "arraybuffer" && this.response instanceof ArrayBuffer) {
          register(fingerprint(new Uint8Array(this.response, 0, Math.min(FP_BYTES, this.response.byteLength))),
            fullUrl);
        }
      } catch (_) {}
    });
    return origOpen.apply(this, arguments);
  };

  // ---- answer content.js ----
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.rtdub === "get_subtitles") {
      window.postMessage({ rtdub: "subtitles_resolved", id: e.data.id, subtitles: window.__rtDubSubtitles }, "*");
      return;
    }
    if (e.data.rtdub !== "resolve") return;
    const ms = msByBlob.get(e.data.blob);
    const infos = (ms && buffersOf.get(ms)) || [];
    const rank = (i) => (/^audio/i.test(i.mime) ? 0 : /video/i.test(i.mime) && /mp4a|opus|aac/i.test(i.mime) ? 1 : 2);
    const urls = infos.filter((i) => i.url).sort((a, b) => rank(a) - rank(b)).map((i) => i.url);
    window.postMessage({
      rtdub: "resolved", id: e.data.id, urls, known: !!ms, buffers: infos.map((i) => i.mime),
      subtitles: window.__rtDubSubtitles
    }, "*");
  });
})();
