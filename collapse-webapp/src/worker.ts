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

    // ── Admin upload routes — fail closed: 403 unless a valid UPLOAD_SECRET is set ──
    if (pathname.startsWith("/admin/")) {
      const auth = request.headers.get("x-upload-secret") ?? "";
      if (!env.UPLOAD_SECRET || auth !== env.UPLOAD_SECRET) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
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

    // ── GET /info[?key=] ───────────────────────────────────────────────────────
    if (pathname === "/info") {
      const infoKey = url.searchParams.get("key") ?? VIDEO_KEY;
      const obj = await env.COLLAPSE_BUCKET.head(infoKey);
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
            key: infoKey,
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
<title>Cinema</title>
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
  html, body { height: 100%; color: var(--text); font-family: -apple-system, "Segoe UI", system-ui, sans-serif; }
  html { background: #07030f; }
  body {
    display: flex; flex-direction: column; align-items: center; justify-content: flex-start; padding: 0;
    min-height: 100%;
    background:
      radial-gradient(1100px 750px at 12% 8%, rgba(139, 92, 246, 0.30), transparent 62%),
      radial-gradient(950px 700px at 88% 18%, rgba(109, 40, 217, 0.26), transparent 60%),
      radial-gradient(850px 850px at 72% 88%, rgba(168, 85, 247, 0.20), transparent 62%),
      radial-gradient(700px 520px at 22% 82%, rgba(76, 29, 149, 0.28), transparent 60%),
      radial-gradient(520px 420px at 50% 45%, rgba(88, 28, 135, 0.14), transparent 65%),
      #07030f;
    background-attachment: fixed;
  }
  /* purple galaxy: fixed star fields above the nebula, below the content */
  body::before, body::after {
    content: ""; position: fixed; top: 0; left: 0; pointer-events: none; z-index: 0;
    border-radius: 50%;
  }
  body::before {
    width: 1px; height: 1px;
    box-shadow:
      298px 94px 0 rgba(255,255,255,0.26), 938px 1035px 0 rgba(255,255,255,0.84),
      147px 235px 0 rgba(255,255,255,0.51), 1010px 462px 0 rgba(255,255,255,0.34),
      1674px 1438px 0 rgba(255,255,255,0.29), 1269px 1465px 0 rgba(255,255,255,0.63),
      823px 1187px 0 rgba(255,255,255,0.67), 1847px 1426px 0 rgba(255,255,255,0.36),
      510px 1073px 0 rgba(255,255,255,0.48), 1028px 489px 0 rgba(255,255,255,0.49),
      1734px 732px 0 rgba(255,255,255,0.88), 2261px 513px 0 rgba(255,255,255,0.89),
      99px 182px 0 rgba(255,255,255,0.38), 1543px 1392px 0 rgba(255,255,255,0.59),
      716px 845px 0 rgba(255,255,255,0.73), 2252px 306px 0 rgba(255,255,255,0.53),
      642px 359px 0 rgba(255,255,255,0.76), 781px 166px 0 rgba(255,255,255,0.86),
      166px 1149px 0 rgba(255,255,255,0.83), 248px 946px 0 rgba(255,255,255,0.82),
      951px 555px 0 rgba(255,255,255,0.9), 1227px 878px 0 rgba(255,255,255,0.71),
      159px 1407px 0 rgba(255,255,255,0.33), 1434px 1535px 0 rgba(255,255,255,0.32),
      2243px 1185px 0 rgba(255,255,255,0.29), 907px 446px 0 rgba(255,255,255,0.7),
      1864px 811px 0 rgba(255,255,255,0.3), 573px 66px 0 rgba(255,255,255,0.5),
      1758px 1312px 0 rgba(255,255,255,0.59), 1911px 770px 0 rgba(255,255,255,0.79),
      1277px 1158px 0 rgba(255,255,255,0.92), 2108px 1143px 0 rgba(255,255,255,0.88),
      134px 870px 0 rgba(255,255,255,0.92), 2249px 346px 0 rgba(255,255,255,0.34),
      54px 1177px 0 rgba(255,255,255,0.26), 2304px 106px 0 rgba(255,255,255,0.46),
      2015px 349px 0 rgba(255,255,255,0.38), 1972px 1367px 0 rgba(255,255,255,0.67),
      88px 180px 0 rgba(255,255,255,0.57), 1072px 1103px 0 rgba(255,255,255,0.46),
      2407px 1018px 0 rgba(255,255,255,0.63), 736px 795px 0 rgba(255,255,255,0.27),
      76px 1196px 0 rgba(255,255,255,0.76), 2031px 1583px 0 rgba(255,255,255,0.45),
      738px 684px 0 rgba(255,255,255,0.94), 1021px 41px 0 rgba(255,255,255,0.5),
      2498px 1041px 0 rgba(255,255,255,0.64), 1995px 117px 0 rgba(255,255,255,0.91),
      1724px 755px 0 rgba(255,255,255,0.88), 1474px 1478px 0 rgba(255,255,255,0.61),
      1072px 792px 0 rgba(255,255,255,0.8), 70px 1174px 0 rgba(255,255,255,0.56),
      2343px 639px 0 rgba(255,255,255,0.56), 488px 856px 0 rgba(255,255,255,0.26),
      1911px 949px 0 rgba(255,255,255,0.68), 617px 906px 0 rgba(255,255,255,0.83),
      1669px 1230px 0 rgba(255,255,255,0.79), 2px 257px 0 rgba(255,255,255,0.29),
      590px 173px 0 rgba(255,255,255,0.3), 1538px 541px 0 rgba(255,255,255,0.45),
      590px 863px 0 rgba(255,255,255,0.37), 802px 1245px 0 rgba(255,255,255,0.58),
      5px 139px 0 rgba(255,255,255,0.84), 11px 1586px 0 rgba(255,255,255,0.76),
      1513px 831px 0 rgba(255,255,255,0.65), 2167px 22px 0 rgba(255,255,255,0.33),
      1600px 1234px 0 rgba(255,255,255,0.79), 2339px 88px 0 rgba(255,255,255,0.91),
      1600px 873px 0 rgba(255,255,255,0.85), 2127px 1383px 0 rgba(255,255,255,0.65),
      660px 222px 0 rgba(255,255,255,0.95), 94px 1002px 0 rgba(255,255,255,0.67),
      108px 530px 0 rgba(255,255,255,0.75), 2158px 353px 0 rgba(255,255,255,0.8),
      354px 1026px 0 rgba(255,255,255,0.94), 106px 950px 0 rgba(255,255,255,0.25),
      2553px 382px 0 rgba(255,255,255,0.87), 1286px 59px 0 rgba(255,255,255,0.42),
      802px 198px 0 rgba(255,255,255,0.54), 596px 848px 0 rgba(255,255,255,0.65),
      217px 894px 0 rgba(255,255,255,0.46), 870px 1307px 0 rgba(255,255,255,0.69),
      471px 441px 0 rgba(255,255,255,0.9), 1448px 42px 0 rgba(255,255,255,0.8),
      2483px 176px 0 rgba(255,255,255,0.6), 1641px 981px 0 rgba(255,255,255,0.76),
      1139px 864px 0 rgba(255,255,255,0.78), 446px 319px 0 rgba(255,255,255,0.29),
      2110px 1595px 0 rgba(255,255,255,0.68), 2426px 63px 0 rgba(255,255,255,0.62),
      2173px 930px 0 rgba(255,255,255,0.57), 252px 725px 0 rgba(255,255,255,0.66),
      1607px 794px 0 rgba(255,255,255,0.89), 50px 1582px 0 rgba(255,255,255,0.38),
      1791px 624px 0 rgba(255,255,255,0.57), 2294px 413px 0 rgba(255,255,255,0.32),
      1082px 439px 0 rgba(255,255,255,0.92), 1166px 963px 0 rgba(255,255,255,0.86),
      838px 301px 0 rgba(255,255,255,0.8), 2117px 515px 0 rgba(255,255,255,0.91),
      1468px 1600px 0 rgba(255,255,255,0.3), 834px 137px 0 rgba(255,255,255,0.8),
      1863px 220px 0 rgba(255,255,255,0.41), 797px 1302px 0 rgba(255,255,255,0.47),
      199px 223px 0 rgba(255,255,255,0.76), 162px 105px 0 rgba(255,255,255,0.76),
      2327px 909px 0 rgba(255,255,255,0.34), 2422px 479px 0 rgba(255,255,255,0.75),
      954px 415px 0 rgba(255,255,255,0.7), 450px 1513px 0 rgba(255,255,255,0.84),
      81px 798px 0 rgba(255,255,255,0.54), 2190px 305px 0 rgba(255,255,255,0.39),
      1666px 897px 0 rgba(255,255,255,0.68), 2062px 574px 0 rgba(255,255,255,0.65),
      2334px 683px 0 rgba(255,255,255,0.39), 469px 1524px 0 rgba(255,255,255,0.61),
      2182px 931px 0 rgba(255,255,255,0.66), 623px 687px 0 rgba(255,255,255,0.68),
      612px 1052px 0 rgba(255,255,255,0.52), 2507px 792px 0 rgba(255,255,255,0.48),
      1664px 797px 0 rgba(255,255,255,0.94), 1622px 513px 0 rgba(255,255,255,0.92),
      2342px 276px 0 rgba(255,255,255,0.94), 1294px 1202px 0 rgba(255,255,255,0.44),
      1062px 1427px 0 rgba(255,255,255,0.26), 586px 666px 0 rgba(255,255,255,0.61),
      844px 1399px 0 rgba(255,255,255,0.35), 787px 412px 0 rgba(255,255,255,0.76),
      1260px 1539px 0 rgba(255,255,255,0.71), 46px 1510px 0 rgba(255,255,255,0.37);
  }
  body::after {
    width: 2px; height: 2px;
    box-shadow:
      282px 1383px 0 rgba(255,255,255,0.74), 2500px 244px 0 rgba(255,255,255,0.51),
      239px 368px 0 rgba(255,255,255,0.41), 2456px 1262px 0 rgba(255,255,255,0.76),
      1012px 232px 0 rgba(255,255,255,0.59), 1251px 1286px 0 rgba(255,255,255,0.37),
      1607px 266px 0 rgba(255,255,255,0.8), 404px 314px 0 rgba(255,255,255,0.36),
      864px 196px 0 rgba(255,255,255,0.39), 1049px 1579px 0 rgba(255,255,255,0.7),
      1657px 1570px 0 rgba(255,255,255,0.73), 1377px 218px 0 rgba(255,255,255,0.59),
      1640px 1059px 0 rgba(255,255,255,0.31), 2140px 1424px 0 rgba(255,255,255,0.67),
      2545px 645px 0 rgba(255,255,255,0.54), 1340px 1475px 0 rgba(255,255,255,0.51),
      2065px 843px 0 rgba(255,255,255,0.51), 157px 56px 0 rgba(255,255,255,0.7),
      1162px 435px 0 rgba(255,255,255,0.32), 974px 984px 0 rgba(255,255,255,0.62),
      1493px 1005px 0 rgba(255,255,255,0.37), 696px 1296px 0 rgba(255,255,255,0.4),
      1910px 1556px 0 rgba(255,255,255,0.69), 1906px 920px 0 rgba(255,255,255,0.9),
      953px 1089px 0 rgba(255,255,255,0.74), 2441px 879px 0 rgba(255,255,255,0.74),
      1849px 1382px 0 rgba(255,255,255,0.9), 583px 1375px 0 rgba(255,255,255,0.92),
      96px 339px 0 rgba(255,255,255,0.76), 1133px 910px 0 rgba(255,255,255,0.74),
      1161px 473px 0 rgba(255,255,255,0.26), 375px 599px 0 rgba(255,255,255,0.68),
      11px 356px 0 rgba(255,255,255,0.31), 703px 185px 0 rgba(255,255,255,0.37),
      967px 443px 0 rgba(255,255,255,0.92), 1676px 811px 0 rgba(255,255,255,0.66),
      2306px 778px 0 rgba(255,255,255,0.32), 1623px 710px 0 rgba(255,255,255,0.62),
      722px 389px 0 rgba(255,255,255,0.7), 782px 242px 0 rgba(255,255,255,0.34),
      1817px 656px 0 rgba(255,255,255,0.25), 2507px 633px 0 rgba(255,255,255,0.36),
      740px 189px 0 rgba(255,255,255,0.71), 875px 1344px 0 rgba(255,255,255,0.86),
      339px 669px 0 rgba(255,255,255,0.47);
    animation: twinkle 4.5s ease-in-out infinite alternate;
  }
  @keyframes twinkle { from { opacity: 0.35; } to { opacity: 1; } }
  header, .player-wrap, .film { position: relative; z-index: 1; }

  header {
    width: 100%;
    padding: 18px 32px;
    display: flex;
    align-items: center;
    gap: 16px;
    background: rgba(13, 7, 25, 0.72);
    -webkit-backdrop-filter: blur(14px);
    backdrop-filter: blur(14px);
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
  }
  header h1 { font-size: 22px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 700; }
  .pill {
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
    padding: 0 24px 48px;
    display: flex;
    flex-direction: column;
  }

  .film {
    display: flex;
    flex-direction: column;
    gap: 20px;
    padding: 40px 0 48px;
  }
  .film + .film { border-top: 1px solid var(--border); }
  .film h2 {
    font-size: 15px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .film h2 .sub { font-size: 12px; color: var(--muted); letter-spacing: 0.04em; text-transform: none; }
  .film .note { font-size: 12px; color: var(--muted); margin-top: -8px; }

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
  .dl-btn {
    background: var(--border); border: none; color: var(--text); border-radius: 8px;
    padding: 8px 16px; font-size: 13px; cursor: pointer; text-decoration: none;
    font-family: inherit; display: inline-block; transition: background 0.15s;
  }
  .dl-btn:hover { background: #333; }

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

  .status {
    font-size: 13px;
    color: var(--accent);
    min-height: 20px;
  }
</style>
</head>
<body>
<header>
  <h1>Cinema</h1>
  <span class="pill">H.264 · MP4</span>
  <span class="meta" id="header-meta">Collapse · Collapse (master)</span>
</header>

<div class="player-wrap">

  <section class="film">
    <h2>Collapse <span class="sub" id="sub-collapse"></span></h2>
    <div class="video-container">
      <video id="vid-collapse" controls preload="metadata" playsinline>
        <source src="/video/collapse-web.mp4" type="video/mp4" />
        Your browser does not support HTML5 video.
      </video>
    </div>
    <div class="controls">
      <button class="rate-btn" data-film="collapse" data-rate="0.5">0.5×</button>
      <button class="rate-btn active" data-film="collapse" data-rate="1">1×</button>
      <button class="rate-btn" data-film="collapse" data-rate="1.5">1.5×</button>
      <button class="rate-btn" data-film="collapse" data-rate="2">2×</button>
      <button data-film="collapse" data-act="pip">⊞ PiP</button>
      <button data-film="collapse" data-act="fs">⛶ Fullscreen</button>
      <a class="dl-btn" href="/video/collapse-web.mp4" download="collapse.mp4">⬇ Collapse file</a>
      <span class="status" id="status-collapse"></span>
    </div>
    <div class="info-bar" id="info-collapse">
      <span><strong>—</strong> Size</span>
      <span><strong>—</strong> Uploaded</span>
      <span><strong>—</strong> Duration</span>
    </div>
  </section>

  <section class="film">
    <h2>Collapse (master) <span class="sub" id="sub-master"></span></h2>
    <p class="note">Coherence isn't uploaded yet — this player shows the Collapse master (collapse.mp4).</p>
    <div class="video-container">
      <video id="vid-master" controls preload="metadata" playsinline>
        <source src="/video/collapse.mp4" type="video/mp4" />
        Your browser does not support HTML5 video.
      </video>
    </div>
    <div class="controls">
      <button class="rate-btn" data-film="master" data-rate="0.5">0.5×</button>
      <button class="rate-btn active" data-film="master" data-rate="1">1×</button>
      <button class="rate-btn" data-film="master" data-rate="1.5">1.5×</button>
      <button class="rate-btn" data-film="master" data-rate="2">2×</button>
      <button data-film="master" data-act="pip">⊞ PiP</button>
      <button data-film="master" data-act="fs">⛶ Fullscreen</button>
      <a class="dl-btn" href="/video/collapse.mp4" download="collapse-master.mp4">⬇ Collapse master file</a>
      <span class="status" id="status-master"></span>
    </div>
    <div class="info-bar" id="info-master">
      <span><strong>—</strong> Size</span>
      <span><strong>—</strong> Uploaded</span>
      <span><strong>—</strong> Duration</span>
    </div>
  </section>

</div>

<script>
const FILMS = {
  collapse:  { key: 'collapse-web.mp4' },
  master:    { key: 'collapse.mp4' },
};
function $(id) { return document.getElementById(id); }

function setupFilm(id) {
  const vid = $('vid-' + id);
  const status = $('status-' + id);
  const key = FILMS[id].key;
  fetch('/info?key=' + encodeURIComponent(key)).then(r => r.json()).then(info => {
    $('info-' + id).innerHTML =
      '<span><strong>' + info.sizeMB + ' MB</strong> Size</span>' +
      '<span><strong>' + (info.uploaded ? info.uploaded.slice(0, 10) : '—') + '</strong> Uploaded</span>' +
      '<span><strong id="dur-' + id + '">—</strong> Duration</span>';
    $('sub-' + id).textContent = info.sizeMB + ' MB · H.264';
  }).catch(() => {});
  vid.addEventListener('loadedmetadata', () => {
    const d = vid.duration;
    const h = Math.floor(d / 3600);
    const m = Math.floor((d % 3600) / 60);
    const s = Math.floor(d % 60);
    const dEl = $('dur-' + id);
    if (dEl) dEl.textContent = (h ? h + 'h ' : '') + (m ? m + 'm ' : '') + s + 's';
  });
  vid.addEventListener('waiting', () => { status.textContent = '⏳ Buffering…'; });
  vid.addEventListener('playing', () => { status.textContent = ''; });
  vid.addEventListener('error', () => { status.textContent = '❌ Stream error — check R2 upload.'; });
}

document.querySelectorAll('button.rate-btn').forEach(b => {
  b.addEventListener('click', () => {
    const id = b.getAttribute('data-film');
    const r = parseFloat(b.getAttribute('data-rate'));
    $('vid-' + id).playbackRate = r;
    document.querySelectorAll('button.rate-btn[data-film="' + id + '"]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    const status = $('status-' + id);
    status.textContent = 'Speed: ' + r + '×';
    setTimeout(() => { status.textContent = ''; }, 1500);
  });
});

document.querySelectorAll('button[data-act="pip"]').forEach(b => {
  b.addEventListener('click', () => {
    const vid = $('vid-' + b.getAttribute('data-film'));
    if (document.pictureInPictureElement) { document.exitPictureInPicture(); }
    else if (vid.requestPictureInPicture) { vid.requestPictureInPicture(); }
  });
});

document.querySelectorAll('button[data-act="fs"]').forEach(b => {
  b.addEventListener('click', () => {
    const vid = $('vid-' + b.getAttribute('data-film'));
    if (!document.fullscreenElement) { if (vid.requestFullscreen) vid.requestFullscreen(); }
    else { document.exitFullscreen(); }
  });
});

setupFilm('collapse');
setupFilm('master');
</script>
</body>
</html>`;
