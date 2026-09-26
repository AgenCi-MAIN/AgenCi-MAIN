#!/usr/bin/env node
/**
 * multipart-upload.mjs
 * Uploads collapse-full.mp4 to Cloudflare R2 using S3 multipart API.
 * R2 requires API tokens — get from:
 *   Cloudflare Dashboard → R2 → Manage R2 API Tokens → Create API Token
 *
 * Usage:
 *   R2_ACCOUNT_ID=xxx R2_ACCESS_KEY_ID=xxx R2_SECRET_ACCESS_KEY=xxx node scripts/multipart-upload.mjs
 *
 * Or with a .env file:
 *   node -r dotenv/config scripts/multipart-upload.mjs
 */

import { createReadStream, statSync, existsSync } from "fs";
import { basename } from "path";

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const BUCKET = process.env.R2_BUCKET_NAME ?? "collapse-video";
const KEY = "collapse.mp4";
const FILE_PATH =
  process.env.COLLAPSE_MP4 ??
  "C:\\Users\\banke\\OneDrive\\Desktop\\collapse-full.mp4";

// 50MB parts (R2 minimum is 5MB, max 5GB per part, max 10000 parts)
const PART_SIZE = 50 * 1024 * 1024;

if (!ACCOUNT_ID || !ACCESS_KEY_ID || !SECRET_ACCESS_KEY) {
  console.error(`
❌ Missing R2 credentials.

Set these environment variables:
  R2_ACCOUNT_ID       — your Cloudflare account ID
  R2_ACCESS_KEY_ID    — R2 Access Key ID
  R2_SECRET_ACCESS_KEY — R2 Secret Access Key

Get them from: Cloudflare Dashboard → R2 → Manage R2 API Tokens

Example:
  $env:R2_ACCOUNT_ID="abc123"
  $env:R2_ACCESS_KEY_ID="key123"
  $env:R2_SECRET_ACCESS_KEY="secret123"
  node scripts/multipart-upload.mjs
`);
  process.exit(1);
}

if (!existsSync(FILE_PATH)) {
  console.error(`❌ File not found: ${FILE_PATH}`);
  process.exit(1);
}

const fileSize = statSync(FILE_PATH).size;
const sizeMB = (fileSize / 1024 / 1024).toFixed(1);
const partCount = Math.ceil(fileSize / PART_SIZE);

console.log(`📦 File: ${FILE_PATH}`);
console.log(`📏 Size: ${sizeMB} MB`);
console.log(`🔢 Parts: ${partCount} × ${PART_SIZE / 1024 / 1024} MB each`);
console.log(`🎯 Destination: r2://${BUCKET}/${KEY}\n`);

// Dynamically import S3 client (avoids needing top-level await)
const { S3Client, CreateMultipartUploadCommand, UploadPartCommand,
        CompleteMultipartUploadCommand, AbortMultipartUploadCommand } = await import("@aws-sdk/client-s3");

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
  },
});

// Create multipart upload
const create = await s3.send(new CreateMultipartUploadCommand({
  Bucket: BUCKET,
  Key: KEY,
  ContentType: "video/mp4",
  Metadata: {
    "x-collapse-size": String(fileSize),
    "x-collapse-parts": String(partCount),
  },
}));
const uploadId = create.UploadId;
console.log(`🚀 Multipart upload started: ${uploadId.slice(0, 20)}…\n`);

const parts = [];
const startTime = Date.now();

try {
  for (let i = 0; i < partCount; i++) {
    const partNumber = i + 1;
    const start = i * PART_SIZE;
    const end = Math.min(start + PART_SIZE, fileSize);
    const length = end - start;

    const stream = createReadStream(FILE_PATH, { start, end: end - 1 });
    const res = await s3.send(new UploadPartCommand({
      Bucket: BUCKET,
      Key: KEY,
      UploadId: uploadId,
      PartNumber: partNumber,
      Body: stream,
      ContentLength: length,
    }));

    parts.push({ PartNumber: partNumber, ETag: res.ETag });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const pct = ((partNumber / partCount) * 100).toFixed(0);
    const uploaded = (partNumber * PART_SIZE / 1024 / 1024).toFixed(0);
    console.log(`  ✅ Part ${String(partNumber).padStart(2, "0")}/${partCount}  ${pct}%  ${uploaded}MB uploaded  (${elapsed}s elapsed)`);
  }

  await s3.send(new CompleteMultipartUploadCommand({
    Bucket: BUCKET,
    Key: KEY,
    UploadId: uploadId,
    MultipartUpload: { Parts: parts },
  }));

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n🎉 Upload complete in ${totalTime}s`);
  console.log(`   r2://${BUCKET}/${KEY}`);
  console.log(`\nNext: npm run deploy  →  deploys the Cloudflare Worker`);

} catch (err) {
  console.error(`\n❌ Upload failed: ${err}`);
  console.error(`   Aborting multipart upload ${uploadId}…`);
  await s3.send(new AbortMultipartUploadCommand({
    Bucket: BUCKET, Key: KEY, UploadId: uploadId,
  })).catch(() => {});
  process.exit(1);
}
