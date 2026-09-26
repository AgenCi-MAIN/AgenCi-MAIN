/**
 * Collapse Video Worker
 * Serves collapse.mp4 from R2 with:
 *  - HTTP 206 Partial Content (range requests) for seeking
 *  - CORS headers for cross-origin player embeds
 *  - Caching via Cloudflare cache API
 *  - /video/collapse.mp4  → video stream
 *  - /info               → JSON video metadata
 *  - /                   → the webapp player (served from static assets or inline)
 */

export interface Env {
  COLLAPSE_BUCKET: R2Bucket;
  UPLOAD_SECRET?: string;
}

const VIDEO_KEY = "collapse.mp4";
const CACHE_MAX_AGE = 31536000; // 1 year

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return corsHeaders(new Response(null, { status: 204 }));
    }

    // ── Admin upload routes — no credentials needed (uses R2 binding directly) ──
    // All /admin/* routes are protected by optional UPLOAD_SECRET
    if (pathname.startsWith("/admin/")) {
      if (env.UPLOAD_SECRET) {
        const auth = request.headers.get("x-upload-secret") ?? "";
        if (auth !== env.UPLOAD_SECRET) {
          return new Response(JSON.stringify({ error: "Forbidden" }), {
            status: 403,
            headers: { "content-type": "application/json" },
          });
        }
      }

      // POST /admin/mpu/create?key=collapse.mp4 → { uploadId }
      if (request.method === "POST" && pathname === "/admin/mpu/create") {
        const key = url.searchParams.get("key") ?? VIDEO_KEY;
        const contentType = url.searchParams.get("contentType") ?? "video/mp4";
        const mpu = await env.COLLAPSE_BUCKET.createMultipartUpload(key, {
          httpMetadata: { contentType },
        });
        return corsHeaders(
          new Response(JSON.stringify({ uploadId: mpu.uploadId, key: mpu.key }), {
            headers: { "content-type": "application/json" },
          })
        );
      }

      // PUT /admin/mpu/part?key=...&uploadId=...&partNumber=N → { etag }
      if (request.method === "PUT" && pathname === "/admin/mpu/part") {
        const key = url.searchParams.get("key") ?? VIDEO_KEY;
        const uploadId = url.searchParams.get("uploadId") ?? "";
        const partNumber = parseInt(url.searchParams.get("partNumber") ?? "1");
        if (!uploadId) return new Response(JSON.stringify({ error: "Missing uploadId" }), { status: 400 });

        const mpu = env.COLLAPSE_BUCKET.resumeMultipartUpload(key, uploadId);
        const part = await mpu.uploadPart(partNumber, request.body!);
        return corsHeaders(
          new Response(JSON.stringify({ partNumber: part.partNumber, etag: part.etag }), {
            headers: { "content-type": "application/json" },
          })
        );
      }

      // POST /admin/mpu/complete?key=...&uploadId=... body: { parts: [{partNumber, etag}] }
      if (request.method === "POST" && pathname === "/admin/mpu/complete") {
        const key = url.searchParams.get("key") ?? VIDEO_KEY;
        const uploadId = url.searchParams.get("uploadId") ?? "";
        if (!uploadId) return new Response(JSON.stringify({ error: "Missing uploadId" }), { status: 400 });

        const body = await request.json() as { parts: { partNumber: number; etag: string }[] };
        const mpu = env.COLLAPSE_BUCKET.resumeMultipartUpload(key, uploadId);
        const obj = await mpu.complete(body.parts);
        return corsHeaders(
          new Response(
            JSON.stringify({ success: true, key: obj.key, etag: obj.etag, size: obj.size }),
            { headers: { "content-type": "application/json" } }
          )
        );
      }

      // DELETE /admin/mpu/abort?key=...&uploadId=...
      if (request.method === "DELETE" && pathname === "/admin/mpu/abort") {
        const key = url.searchParams.get("key") ?? VIDEO_KEY;
        const uploadId = url.searchParams.get("uploadId") ?? "";
        if (!uploadId) return new Response(JSON.stringify({ error: "Missing uploadId" }), { status: 400 });
        const mpu = env.COLLAPSE_BUCKET.resumeMultipartUpload(key, uploadId);
        await mpu.abort();
        return corsHeaders(
          new Response(JSON.stringify({ success: true }), {
            headers: { "content-type": "application/json" },
          })
        );
      }

      // PUT /admin/upload/:key — single-part upload (files < 100MB)
      if (request.method === "PUT" && pathname.startsWith("/admin/upload/")) {
        const key = decodeURIComponent(pathname.slice("/admin/upload/".length));
        const contentType = request.headers.get("content-type") ?? "application/octet-stream";
        await env.COLLAPSE_BUCKET.put(key, request.body, { httpMetadata: { contentType } });
        const obj = await env.COLLAPSE_BUCKET.head(key);
        return corsHeaders(
          new Response(
            JSON.stringify({ success: true, key, size: obj?.size ?? 0, etag: obj?.etag ?? "" }),
            { headers: { "content-type": "application/json" } }
          )
        );
      }

      return new Response(JSON.stringify({ error: "Unknown admin route" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }

    // ── GET /info ──────────────────────────────────────────────────────────────
    if (pathname === "/info") {
      const obj = await env.COLLAPSE_BUCKET.head(VIDEO_KEY);
      if (!obj) {
        return corsHeaders(
          new Response(JSON.stringify({ error: "Video not found. Upload first." }), {
            status: 404,
            headers: { "content-type": "application/json" },
          })
        );
      }
      return corsHeaders(
        new Response(
          JSON.stringify({
            key: VIDEO_KEY,
            size: obj.size,
            sizeMB: (obj.size / 1024 / 1024).toFixed(1),
            contentType: obj.httpMetadata?.contentType ?? "video/mp4",
            uploaded: obj.uploaded.toISOString(),
            etag: obj.etag,
          }),
          { headers: { "content-type": "application/json" } }
        )
      );
    }

    // ── GET /video/:key ────────────────────────────────────────────────────────
    if (pathname.startsWith("/video/")) {
      const key = decodeURIComponent(pathname.slice("/video/".length));
      return handleVideoRequest(request, env, key);
    }

    // ── GET /video (shorthand) ─────────────────────────────────────────────────
    if (pathname === "/video") {
      return handleVideoRequest(request, env, VIDEO_KEY);
    }

    // ── GET / → redirect to player ─────────────────────────────────────────────
    if (pathname === "/" || pathname === "") {
      // The webapp is deployed via Cloudflare Pages — redirect there or serve inline player
      return corsHeaders(
        new Response(INLINE_PLAYER, {
          headers: { "content-type": "text/html; charset=utf-8" },
        })
      );
    }

    return corsHeaders(new Response("Not found", { status: 404 }));
  },
};

async function handleVideoRequest(
  request: Request,
  env: Env,
  key: string
): Promise<Response> {
  // Check cache first
  const cacheUrl = new URL(request.url);
  cacheUrl.pathname = `/video/${key}`;
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
  const cache = caches.default;

  // Only cache non-range requests (full file)
  const rangeHeader = request.headers.get("Range");

  if (!rangeHeader) {
    const cached = await cache.match(cacheKey);
    if (cached) return corsHeaders(cached);
  }

  const obj = await env.COLLAPSE_BUCKET.get(key, {
    range: rangeHeader ? parseRange(rangeHeader) : undefined,
  });

  if (!obj) {
    return corsHeaders(
      new Response("Video not found. Run upload_collapse_chunks first.", {
        status: 404,
      })
    );
  }

  const fileSize = obj.size;
  const contentType = obj.httpMetadata?.contentType ?? "video/mp4";

  let status = 200;
  const headers: Record<string, string> = {
    "content-type": contentType,
    "accept-ranges": "bytes",
    etag: obj.etag,
    "cache-control": `public, max-age=${CACHE_MAX_AGE}`,
    "last-modified": obj.uploaded.toUTCString(),
  };

  if (rangeHeader) {
    const range = parseRangeFull(rangeHeader, fileSize);
    if (!range) {
      return corsHeaders(
        new Response("Invalid range", {
          status: 416,
          headers: { "content-range": `bytes */${fileSize}` },
        })
      );
    }
    headers["content-range"] = `bytes ${range.start}-${range.end}/${fileSize}`;
    headers["content-length"] = String(range.end - range.start + 1);
    status = 206;
  } else {
    headers["content-length"] = String(fileSize);
  }

  const response = new Response(obj.body as ReadableStream, { status, headers });

  // Cache full responses in the background
  if (!rangeHeader) {
    ctx_store.waitUntil?.(cache.put(cacheKey, response.clone()));
  }

  return corsHeaders(response);
}

// Hack: store ctx in module scope during request handling so handleVideoRequest can use it
const ctx_store: { waitUntil?: (p: Promise<any>) => void } = {};

function parseRange(header: string): R2Range | undefined {
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return undefined;
  const start = match[1] ? parseInt(match[1]) : undefined;
  const end = match[2] ? parseInt(match[2]) : undefined;
  if (start !== undefined && end !== undefined) return { offset: start, length: end - start + 1 };
  if (start !== undefined) return { offset: start };
  if (end !== undefined) return { suffix: end };
  return undefined;
}

function parseRangeFull(
  header: string,
  fileSize: number
): { start: number; end: number } | null {
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  let start = match[1] ? parseInt(match[1]) : fileSize - parseInt(match[2]);
  let end = match[2] ? parseInt(match[2]) : fileSize - 1;
  start = Math.max(0, start);
  end = Math.min(fileSize - 1, end);
  if (start > end) return null;
  return { start, end };
}

function corsHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, HEAD, OPTIONS");
  headers.set("access-control-allow-headers", "Range, Content-Type");
  headers.set("access-control-expose-headers", "Content-Range, Content-Length, Accept-Ranges");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ─── Inline Player HTML (served at /) ─────────────────────────────────────────
// This is served when hitting the Worker root — a polished standalone player.
const INLINE_PLAYER = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Collapse</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0a0a0a;
    --surface: #111;
    --border: #222;
    --text: #e8e8e8;
    --muted: #666;
    --accent: #c8ff00;
  }
  html, body { height: 100%; background: var(--bg); color: var(--text); font-family: -apple-system, "Segoe UI", system-ui, sans-serif; }
  body { display: flex; flex-direction: column; align-items: center; justify-content: flex-start; padding: 0; }

  header {
    width: 100%;
    padding: 18px 32px;
    display: flex;
    align-items: center;
    gap: 16px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  header h1 { font-size: 22px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 700; }
  header .pill {
    font-size: 11px;
    padding: 3px 10px;
    border-radius: 99px;
    background: var(--accent);
    color: #000;
    font-weight: 700;
    letter-spacing: 0.05em;
  }
  header .meta { margin-left: auto; font-size: 12px; color: var(--muted); }

  .player-wrap {
    width: 100%;
    max-width: 1200px;
    padding: 32px 24px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .video-container {
    position: relative;
    width: 100%;
    background: #000;
    border-radius: 12px;
    overflow: hidden;
    border: 1px solid var(--border);
    box-shadow: 0 24px 80px rgba(0,0,0,0.6);
  }
  video {
    width: 100%;
    display: block;
    max-height: 72vh;
    background: #000;
  }

  .controls {
    display: flex;
    gap: 12px;
    align-items: center;
    padding: 16px 20px;
    background: var(--surface);
    border-radius: 12px;
    border: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .controls button {
    background: var(--border);
    border: none;
    color: var(--text);
    border-radius: 8px;
    padding: 8px 16px;
    font-size: 13px;
    cursor: pointer;
    transition: background 0.15s;
    font-family: inherit;
  }
  .controls button:hover { background: #333; }
  .controls button.active { background: var(--accent); color: #000; font-weight: 700; }

  .info-bar {
    display: flex;
    gap: 24px;
    font-size: 12px;
    color: var(--muted);
    padding: 12px 0;
    border-top: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .info-bar span strong { color: var(--text); }

  #status {
    font-size: 13px;
    color: var(--accent);
    min-height: 20px;
  }
</style>
</head>
<body>
<header>
  <h1>Collapse</h1>
  <span class="pill">H.264 · MP4</span>
  <span class="meta" id="header-meta">Loading…</span>
</header>

<div class="player-wrap">
  <div class="video-container">
    <video id="vid" controls preload="metadata" playsinline>
      <source id="vid-src" src="/video" type="video/mp4" />
      Your browser does not support HTML5 video.
    </video>
  </div>

  <div class="controls">
    <button onclick="setRate(0.5)">0.5×</button>
    <button onclick="setRate(1)" class="active" id="btn-1x">1×</button>
    <button onclick="setRate(1.5)">1.5×</button>
    <button onclick="setRate(2)">2×</button>
    <button onclick="togglePip()">⊞ PiP</button>
    <button onclick="toggleFullscreen()">⛶ Fullscreen</button>
    <span id="status"></span>
  </div>

  <div class="info-bar" id="info-bar">
    <span><strong>—</strong> Size</span>
    <span><strong>—</strong> Format</span>
    <span><strong>—</strong> Uploaded</span>
    <span><strong>—</strong> Duration</span>
  </div>
</div>

<script>
const vid = document.getElementById('vid');
const status = document.getElementById('status');

// Fetch video info
fetch('/info').then(r => r.json()).then(info => {
  document.getElementById('header-meta').textContent = info.sizeMB + ' MB · ' + (info.uploaded ? info.uploaded.slice(0,10) : '');
  document.getElementById('info-bar').innerHTML =
    '<span><strong>' + info.sizeMB + ' MB</strong> Size</span>' +
    '<span><strong>H.264 MP4</strong> Format</span>' +
    '<span><strong>' + (info.uploaded ? info.uploaded.slice(0,10) : '—') + '</strong> Uploaded</span>' +
    '<span><strong id="dur">—</strong> Duration</span>';
}).catch(() => {
  document.getElementById('header-meta').textContent = 'Cloudflare R2';
});

vid.addEventListener('loadedmetadata', () => {
  const d = vid.duration;
  const h = Math.floor(d / 3600);
  const m = Math.floor((d % 3600) / 60);
  const s = Math.floor(d % 60);
  const durEl = document.getElementById('dur');
  if (durEl) durEl.textContent = (h ? h + 'h ' : '') + (m ? m + 'm ' : '') + s + 's';
});

vid.addEventListener('waiting', () => { status.textContent = '⏳ Buffering…'; });
vid.addEventListener('playing', () => { status.textContent = ''; });
vid.addEventListener('error', () => { status.textContent = '❌ Stream error — check R2 upload.'; });

const rateBtns = document.querySelectorAll('.controls button');
function setRate(r) {
  vid.playbackRate = r;
  rateBtns.forEach(b => b.classList.remove('active'));
  const btns = document.querySelectorAll('.controls button');
  btns.forEach(b => { if (b.textContent === r + '×') b.classList.add('active'); });
  status.textContent = 'Speed: ' + r + '×';
  setTimeout(() => { status.textContent = ''; }, 1500);
}

function togglePip() {
  if (document.pictureInPictureElement) {
    document.exitPictureInPicture();
  } else if (vid.requestPictureInPicture) {
    vid.requestPictureInPicture();
  }
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    vid.requestFullscreen();
  } else {
    document.exitFullscreen();
  }
}
</script>
</body>
</html>`;
