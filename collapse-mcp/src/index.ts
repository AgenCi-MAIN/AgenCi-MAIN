#!/usr/bin/env node
/**
 * Collapse MCP Server
 * Exposes tools for managing the Collapse MP4 via Cloudflare R2:
 *  - upload_collapse_chunks   → multipart upload of the 57 chunks to R2
 *  - get_stream_url           → generate a presigned URL for streaming
 *  - get_video_info           → metadata about the stored video
 *  - delete_video             → remove the video from R2
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";
import { createReadStream, statSync, readdirSync } from "fs";
import { join, basename } from "path";

// ─── Config from env ──────────────────────────────────────────────────────────
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID ?? "";
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID ?? "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY ?? "";
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME ?? "collapse-video";
const WORKER_URL = (process.env.COLLAPSE_WORKER_URL ?? "").replace(/\/$/, "");
const CHUNK_DIR =
  process.env.COLLAPSE_CHUNK_DIR ??
  "C:\\Users\\banke\\OneDrive\\Desktop\\Collapse";

// ─── R2 S3-compatible client ───────────────────────────────────────────────────
function makeS3(): S3Client {
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error(
      "R2 credentials not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY."
    );
  }
  return new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getChunkFiles(dir: string): string[] {
  const files = readdirSync(dir).sort();
  return files
    .filter((f) => f.startsWith("collapse-"))
    .map((f) => join(dir, f));
}

// ─── MCP Server ───────────────────────────────────────────────────────────────
const server = new McpServer({
  name: "collapse-mcp",
  version: "1.0.0",
});

// ── Tool: upload_collapse_chunks ─────────────────────────────────────────────
server.registerTool(
  "upload_collapse_chunks",
  {
    description:
      "Upload the 57 Collapse video chunks from disk to Cloudflare R2 using S3 multipart upload. " +
      "Progress is reported per-part. Set dry_run=true to just validate chunk files exist.",
    inputSchema: {
      chunk_dir: z
        .string()
        .optional()
        .describe(
          "Directory containing collapse-00 through collapse-56. Defaults to COLLAPSE_CHUNK_DIR env var."
        ),
      key: z
        .string()
        .optional()
        .describe("R2 object key. Defaults to 'collapse.mp4'."),
      dry_run: z
        .boolean()
        .optional()
        .describe("If true, validate chunks exist without uploading."),
    },
  },
  async ({ chunk_dir, key = "collapse.mp4", dry_run = false }) => {
    const dir = chunk_dir ?? CHUNK_DIR;
    let chunks: string[];
    try {
      chunks = getChunkFiles(dir);
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `❌ Cannot read chunk dir: ${dir}\n${e}` }],
        isError: true,
      };
    }

    if (chunks.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `❌ No collapse-* files found in ${dir}`,
          },
        ],
        isError: true,
      };
    }

    const totalBytes = chunks.reduce((sum, f) => sum + statSync(f).size, 0);
    const lines: string[] = [
      `📦 Found ${chunks.length} chunks (${(totalBytes / 1024 / 1024).toFixed(1)} MB total)`,
      `🎯 Target: r2://${R2_BUCKET_NAME}/${key}`,
    ];

    if (dry_run) {
      lines.push(
        "✅ Dry run complete — all chunks found and readable.",
        `   Run without dry_run=true to start the upload.`
      );
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }

    let s3: S3Client;
    try {
      s3 = makeS3();
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `❌ ${e}` }],
        isError: true,
      };
    }

    // Start multipart upload
    const create = await s3.send(
      new CreateMultipartUploadCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
        ContentType: "video/mp4",
        Metadata: {
          "x-collapse-chunks": String(chunks.length),
          "x-collapse-total-bytes": String(totalBytes),
        },
      })
    );
    const uploadId = create.UploadId!;
    lines.push(`🚀 Multipart upload started (ID: ${uploadId.slice(0, 16)}…)`);

    const parts: { PartNumber: number; ETag: string }[] = [];

    try {
      for (let i = 0; i < chunks.length; i++) {
        const partNumber = i + 1;
        const chunkPath = chunks[i];
        const chunkSize = statSync(chunkPath).size;
        const body = createReadStream(chunkPath);

        const upload = await s3.send(
          new UploadPartCommand({
            Bucket: R2_BUCKET_NAME,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
            Body: body as unknown as Blob,
            ContentLength: chunkSize,
          })
        );
        parts.push({ PartNumber: partNumber, ETag: upload.ETag! });
        lines.push(
          `  ✅ Part ${String(partNumber).padStart(2, "0")}/${chunks.length} — ${basename(chunkPath)} (${(chunkSize / 1024 / 1024).toFixed(1)} MB)`
        );
      }

      await s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: R2_BUCKET_NAME,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts },
        })
      );
      lines.push(
        ``,
        `🎉 Upload complete! r2://${R2_BUCKET_NAME}/${key}`,
        WORKER_URL
          ? `🌐 Stream: ${WORKER_URL}/video/${key}`
          : `💡 Set COLLAPSE_WORKER_URL to get a stream URL.`
      );
    } catch (e) {
      // Abort the incomplete multipart upload to avoid storage charges
      await s3
        .send(
          new AbortMultipartUploadCommand({
            Bucket: R2_BUCKET_NAME,
            Key: key,
            UploadId: uploadId,
          })
        )
        .catch(() => {});
      lines.push(`❌ Upload failed and was aborted: ${e}`);
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        isError: true,
      };
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

// ── Tool: get_stream_url ──────────────────────────────────────────────────────
server.registerTool(
  "get_stream_url",
  {
    description:
      "Get the URL to stream or play the Collapse video. " +
      "Returns the public Worker URL if configured, otherwise a presigned R2 URL.",
    inputSchema: {
      key: z.string().optional().describe("R2 object key. Defaults to 'collapse.mp4'."),
      expires_in_seconds: z
        .number()
        .int()
        .min(60)
        .max(604800)
        .optional()
        .describe("Presigned URL expiry in seconds (60–604800). Defaults to 3600."),
    },
  },
  async ({ key = "collapse.mp4", expires_in_seconds = 3600 }) => {
    // If worker URL is set, return the public URL — no credentials needed
    if (WORKER_URL) {
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `🎬 Stream URL: ${WORKER_URL}/video/${key}`,
              `📺 Player: ${WORKER_URL}/`,
              `📋 Info: ${WORKER_URL}/info`,
              ``,
              `Served via Cloudflare Worker with HTTP 206 range-request support.`,
            ].join("\n"),
          },
        ],
      };
    }

    // Fall back to a presigned R2 URL
    let s3: S3Client;
    try {
      s3 = makeS3();
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `❌ ${e}` }],
        isError: true,
      };
    }

    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }),
      { expiresIn: expires_in_seconds }
    );

    return {
      content: [
        {
          type: "text" as const,
          text: [
            `🔗 Presigned stream URL (expires in ${expires_in_seconds}s):`,
            url,
            ``,
            `💡 Tip: Set COLLAPSE_WORKER_URL for a permanent public URL.`,
          ].join("\n"),
        },
      ],
    };
  }
);

// ── Tool: get_video_info ──────────────────────────────────────────────────────
server.registerTool(
  "get_video_info",
  {
    description:
      "Get metadata about the Collapse video stored in R2 — size, upload date, ETag, content type.",
    inputSchema: {
      key: z.string().optional().describe("R2 object key. Defaults to 'collapse.mp4'."),
    },
  },
  async ({ key = "collapse.mp4" }) => {
    let s3: S3Client;
    try {
      s3 = makeS3();
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `❌ ${e}` }],
        isError: true,
      };
    }

    try {
      const head = await s3.send(
        new HeadObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key })
      );
      const sizeMB = ((head.ContentLength ?? 0) / 1024 / 1024).toFixed(1);
      const lines = [
        `🎬 r2://${R2_BUCKET_NAME}/${key}`,
        `📦 Size: ${sizeMB} MB (${(head.ContentLength ?? 0).toLocaleString()} bytes)`,
        `📅 Last Modified: ${head.LastModified?.toISOString() ?? "unknown"}`,
        `🔖 ETag: ${head.ETag ?? "unknown"}`,
        `🎞️  Content-Type: ${head.ContentType ?? "unknown"}`,
      ];
      if (head.Metadata && Object.keys(head.Metadata).length > 0) {
        lines.push(`📋 Metadata: ${JSON.stringify(head.Metadata)}`);
      }
      if (WORKER_URL) {
        lines.push(``, `🌐 Stream: ${WORKER_URL}/video/${key}`);
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (e: any) {
      if (
        e?.name === "NotFound" ||
        e?.$metadata?.httpStatusCode === 404
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: `⚠️  '${key}' not found in bucket '${R2_BUCKET_NAME}'.\nRun upload_collapse_chunks first.`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: `❌ Failed: ${e}` }],
        isError: true,
      };
    }
  }
);

// ── Tool: delete_video ────────────────────────────────────────────────────────
server.registerTool(
  "delete_video",
  {
    description:
      "Delete the Collapse video from R2. Irreversible. Requires confirm='DELETE'.",
    inputSchema: {
      key: z.string().optional().describe("R2 object key. Defaults to 'collapse.mp4'."),
      confirm: z
        .literal("DELETE")
        .describe("Must be the exact string 'DELETE' to confirm deletion."),
    },
  },
  async ({ key = "collapse.mp4", confirm }) => {
    if (confirm !== "DELETE") {
      return {
        content: [
          {
            type: "text" as const,
            text: '❌ Confirmation required — pass confirm="DELETE" to proceed.',
          },
        ],
        isError: true,
      };
    }
    let s3: S3Client;
    try {
      s3 = makeS3();
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `❌ ${e}` }],
        isError: true,
      };
    }
    await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
    return {
      content: [
        {
          type: "text" as const,
          text: `🗑️  Deleted: r2://${R2_BUCKET_NAME}/${key}`,
        },
      ],
    };
  }
);

// ─── Start ────────────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🎬 collapse-mcp running on stdio");
}

main().catch((err) => {
  console.error("Fatal error in collapse-mcp:", err);
  process.exit(1);
});
