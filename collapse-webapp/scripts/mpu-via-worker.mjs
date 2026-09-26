#!/usr/bin/env node
/**
 * mpu-via-worker.mjs
 * Uploads collapse-full.mp4 to R2 using the Worker's multipart upload endpoints.
 * No credentials needed — the Worker uses its R2 binding.
 *
 * Uses 50MB parts (Cloudflare Workers: 100MB request body limit per invocation).
 *
 * Usage:
 *   node scripts/mpu-via-worker.mjs
 */

import { createReadStream, statSync, existsSync } from 'fs';

const WORKER_URL = 'https://collapse-video-worker.thrive18.workers.dev';
const KEY = 'collapse.mp4';
const FILE_PATH = process.env.COLLAPSE_MP4 ?? 'C:\\Users\\banke\\OneDrive\\Desktop\\collapse-full.mp4';
const UPLOAD_SECRET = process.env.UPLOAD_SECRET ?? '';

// 50MB parts — safely under the 100MB Worker body limit
const PART_SIZE = 50 * 1024 * 1024;

function headers(extra = {}) {
  const h = { ...extra };
  if (UPLOAD_SECRET) h['x-upload-secret'] = UPLOAD_SECRET;
  return h;
}

async function workerFetch(method, path, opts = {}) {
  const res = await fetch(`${WORKER_URL}${path}`, {
    method,
    headers: headers(opts.headers ?? {}),
    body: opts.body,
    duplex: opts.duplex,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text }; }
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}: ${JSON.stringify(data)}`);
  return data;
}

async function readChunk(filePath, start, length) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = createReadStream(filePath, { start, end: start + length - 1 });
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
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
console.log(`📏 Size: ${sizeMB} MB`);
console.log(`🔢 Parts: ${partCount} × ${PART_SIZE / 1024 / 1024} MB`);
console.log(`🎯 Via: ${WORKER_URL}`);
console.log(`🗄️  R2 bucket: collapse-video/${KEY}\n`);

// 1. Create multipart upload
console.log('🚀 Creating multipart upload…');
const createData = await workerFetch(
  'POST',
  `/admin/mpu/create?key=${encodeURIComponent(KEY)}&contentType=video%2Fmp4`
);
const uploadId = createData.uploadId;
console.log(`   Upload ID: ${uploadId.slice(0, 24)}…\n`);

// 2. Upload parts
const parts = [];
const startTime = Date.now();

for (let i = 0; i < partCount; i++) {
  const partNumber = i + 1;
  const start = i * PART_SIZE;
  const length = Math.min(PART_SIZE, fileSize - start);

  const chunk = await readChunk(FILE_PATH, start, length);
  const partUrl = `/admin/mpu/part?key=${encodeURIComponent(KEY)}&uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`;

  const partData = await workerFetch('PUT', partUrl, {
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(length) },
    body: chunk,
  });

  parts.push({ partNumber: partData.partNumber, etag: partData.etag });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  const pct = ((partNumber / partCount) * 100).toFixed(0);
  const uploadedMB = ((start + length) / 1024 / 1024).toFixed(0);
  const speed = ((start + length) / 1024 / 1024 / Math.max(1, (Date.now() - startTime) / 1000)).toFixed(1);
  console.log(`  ✅ Part ${String(partNumber).padStart(2,'0')}/${partCount}  ${pct}%  ${uploadedMB}MB  ${speed} MB/s  (${elapsed}s)`);
}

// 3. Complete
console.log('\n⚙️  Completing multipart upload…');
const completeData = await workerFetch(
  'POST',
  `/admin/mpu/complete?key=${encodeURIComponent(KEY)}&uploadId=${encodeURIComponent(uploadId)}`,
  {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parts }),
  }
).catch(async (e) => {
  // Abort on failure
  console.error('Complete failed, aborting:', e.message);
  await workerFetch('DELETE', `/admin/mpu/abort?key=${encodeURIComponent(KEY)}&uploadId=${encodeURIComponent(uploadId)}`).catch(() => {});
  process.exit(1);
});

const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
const avgSpeed = (fileSize / 1024 / 1024 / Math.max(1, (Date.now() - startTime) / 1000)).toFixed(1);

console.log(`\n🎉 Upload complete!`);
console.log(`   Time: ${totalTime}s  Avg: ${avgSpeed} MB/s`);
console.log(`   Key: ${completeData.key}`);
console.log(`   ETag: ${completeData.etag}`);
console.log(`   Size: ${completeData.size} bytes`);
console.log(`\n🌐 Worker: ${WORKER_URL}`);
console.log(`📺 Player: ${WORKER_URL}/`);
console.log(`🎬 Stream: ${WORKER_URL}/video`);
console.log(`📋 Info:   ${WORKER_URL}/info`);
