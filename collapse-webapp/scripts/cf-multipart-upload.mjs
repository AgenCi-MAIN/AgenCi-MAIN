#!/usr/bin/env node
/**
 * cf-multipart-upload.mjs
 * Uploads collapse-full.mp4 to R2 using Cloudflare's REST API multipart upload.
 * Uses your wrangler OAuth token — no R2 API token needed.
 *
 * Usage:
 *   node scripts/cf-multipart-upload.mjs
 *
 * The wrangler token is read automatically from:
 *   %APPDATA%\xdg.config\.wrangler\config\default.toml
 */

import { createReadStream, statSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ── Config ────────────────────────────────────────────────────────────────────
const ACCOUNT_ID = "f39f3a77e56b28e4dfae29489a997014";
const BUCKET = "collapse-video";
const KEY = "collapse.mp4";
const FILE_PATH =
  process.env.COLLAPSE_MP4 ??
  "C:\\Users\\banke\\OneDrive\\Desktop\\collapse-full.mp4";

// 100 MB parts — CF REST API supports up to 5 GB per part
const PART_SIZE = 100 * 1024 * 1024;

// ── Read wrangler token ───────────────────────────────────────────────────────
function readWranglerToken() {
  const configPath = join(
    process.env.APPDATA ?? homedir(),
    "xdg.config",
    ".wrangler",
    "config",
    "default.toml"
  );
  if (!existsSync(configPath)) {
    throw new Error(
      `Wrangler config not found at ${configPath}.\nRun: npx wrangler login`
    );
  }
  const content = readFileSync(configPath, "utf8");
  const match = content.match(/oauth_token\s*=\s*"([^"]+)"/);
  if (!match) throw new Error("oauth_token not found in wrangler config.");
  return match[1];
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET}`;

async function cfFetch(method, path, options = {}) {
  const token = readWranglerToken();
  const url = BASE + path;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers ?? {}),
    },
    body: options.body ?? undefined,
    duplex: "half",
    ...options,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
  }
  return res;
}

async function readChunk(filePath, start, length) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = createReadStream(filePath, {
      start,
      end: start + length - 1,
    });
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
if (!existsSync(FILE_PATH)) {
  console.error(`❌ File not found: ${FILE_PATH}`);
  process.exit(1);
}

const fileSize = statSync(FILE_PATH).size;
const sizeMB = (fileSize / 1024 / 1024).toFixed(1);
const partCount = Math.ceil(fileSize / PART_SIZE);

console.log(`📦 File: ${FILE_PATH}`);
console.log(`📏 Size: ${sizeMB} MB (${fileSize.toLocaleString()} bytes)`);
console.log(`🔢 Parts: ${partCount} × ${PART_SIZE / 1024 / 1024} MB`);
console.log(`🎯 Destination: r2://${BUCKET}/${KEY}\n`);

// 1. Create multipart upload
console.log("🚀 Creating multipart upload…");
const createRes = await cfFetch("POST", `/objects/${encodeURIComponent(KEY)}/uploads`, {
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({}),
});
const createData = await createRes.json();
const uploadId = createData.result?.uploadId;
if (!uploadId) {
  console.error("❌ Failed to get uploadId:", JSON.stringify(createData));
  process.exit(1);
}
console.log(`   Upload ID: ${uploadId.slice(0, 20)}…\n`);

// 2. Upload parts
const parts = [];
const startTime = Date.now();

for (let i = 0; i < partCount; i++) {
  const partNumber = i + 1;
  const start = i * PART_SIZE;
  const length = Math.min(PART_SIZE, fileSize - start);

  const chunk = await readChunk(FILE_PATH, start, length);

  const partRes = await cfFetch(
    "PUT",
    `/objects/${encodeURIComponent(KEY)}/uploads/${uploadId}/parts/${partNumber}`,
    {
      headers: { "Content-Type": "application/octet-stream", "Content-Length": String(length) },
      body: chunk,
    }
  );
  const partData = await partRes.json();
  const etag = partData.result?.etag;
  if (!etag) {
    console.error(`❌ No ETag for part ${partNumber}:`, JSON.stringify(partData));
    // Abort
    await cfFetch(
      "DELETE",
      `/objects/${encodeURIComponent(KEY)}/uploads/${uploadId}`
    ).catch(() => {});
    process.exit(1);
  }
  parts.push({ partNumber, etag });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  const pct = ((partNumber / partCount) * 100).toFixed(0);
  const uploadedMB = ((start + length) / 1024 / 1024).toFixed(0);
  const speed = ((start + length) / 1024 / 1024 / ((Date.now() - startTime) / 1000)).toFixed(1);
  console.log(
    `  ✅ Part ${String(partNumber).padStart(2, "0")}/${partCount}  ${pct}%  ${uploadedMB}MB  ${speed} MB/s  (${elapsed}s)`
  );
}

// 3. Complete multipart upload
console.log("\n⚙️  Completing multipart upload…");
const completeRes = await cfFetch(
  "POST",
  `/objects/${encodeURIComponent(KEY)}/uploads/${uploadId}/complete`,
  {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parts }),
  }
);
const completeData = await completeRes.json();

if (!completeData.success) {
  console.error("❌ Complete failed:", JSON.stringify(completeData));
  process.exit(1);
}

const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
const avgSpeed = (fileSize / 1024 / 1024 / ((Date.now() - startTime) / 1000)).toFixed(1);

console.log(`\n🎉 Upload complete in ${totalTime}s (avg ${avgSpeed} MB/s)`);
console.log(`   r2://${BUCKET}/${KEY}`);
console.log(`   Size: ${completeData.result?.size ?? sizeMB + " MB"}`);
console.log(`   ETag: ${completeData.result?.etag ?? "—"}`);
console.log(`\n🌐 Worker live at: https://collapse-video-worker.thrive18.workers.dev`);
console.log(`📺 Player: https://collapse-video-worker.thrive18.workers.dev/`);
console.log(`🎬 Stream: https://collapse-video-worker.thrive18.workers.dev/video`);
