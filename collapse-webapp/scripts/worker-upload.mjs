#!/usr/bin/env node
/**
 * worker-upload.mjs
 * Uploads collapse-full.mp4 to R2 by streaming through the deployed Worker's
 * /admin/upload/:key endpoint (which uses the Worker's R2 binding — no credentials needed).
 *
 * Usage:
 *   node scripts/worker-upload.mjs
 */

import { createReadStream, statSync, existsSync } from 'fs';

const WORKER_URL = 'https://collapse-video-worker.thrive18.workers.dev';
const KEY = 'collapse.mp4';
const FILE_PATH = process.env.COLLAPSE_MP4 ?? 'C:\\Users\\banke\\OneDrive\\Desktop\\collapse-full.mp4';
const UPLOAD_SECRET = process.env.UPLOAD_SECRET ?? '';

if (!existsSync(FILE_PATH)) {
  console.error(`❌ File not found: ${FILE_PATH}`);
  process.exit(1);
}

const fileSize = statSync(FILE_PATH).size;
const sizeMB = (fileSize / 1024 / 1024).toFixed(1);

console.log(`📦 File: ${FILE_PATH}`);
console.log(`📏 Size: ${sizeMB} MB (${fileSize.toLocaleString()} bytes)`);
console.log(`🎯 Uploading via Worker: ${WORKER_URL}/admin/upload/${KEY}`);
console.log(`⏳ This will take several minutes for 1.4 GB...\n`);

const startTime = Date.now();

// Stream the file directly to the Worker
const fileStream = createReadStream(FILE_PATH);

const headers = {
  'Content-Type': 'video/mp4',
  'Content-Length': String(fileSize),
};
if (UPLOAD_SECRET) headers['x-upload-secret'] = UPLOAD_SECRET;

const res = await fetch(`${WORKER_URL}/admin/upload/${encodeURIComponent(KEY)}`, {
  method: 'PUT',
  headers,
  body: fileStream,
  duplex: 'half',
});

const data = await res.json();
const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

if (!res.ok || !data.success) {
  console.error(`❌ Upload failed (HTTP ${res.status}):`, JSON.stringify(data));
  process.exit(1);
}

const speedMBs = (fileSize / 1024 / 1024 / ((Date.now() - startTime) / 1000)).toFixed(1);
console.log(`\n🎉 Upload complete in ${totalTime}s (avg ${speedMBs} MB/s)`);
console.log(`   Key: ${data.key}`);
console.log(`   Size: ${data.size} bytes`);
console.log(`   ETag: ${data.etag}`);
console.log(`\n🌐 Worker: ${WORKER_URL}`);
console.log(`📺 Player: ${WORKER_URL}/`);
console.log(`🎬 Stream: ${WORKER_URL}/video`);
console.log(`📋 Info:   ${WORKER_URL}/info`);
