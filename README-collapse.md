# Collapse — Video MCP + Webapp

A **Cloudflare Workers** + **MCP Server** stack for hosting and streaming the **Collapse** video (1.4 GB H.264 MP4) directly from **Cloudflare R2**.

```
┌─────────────────┐     MCP tools      ┌─────────────────────┐
│   Bob / Agent   │ ◄──────────────── │   collapse-mcp      │
│                 │  upload / stream   │   (stdio MCP server)│
└─────────────────┘                    └──────────┬──────────┘
                                                   │ S3 API
                                     ┌─────────────▼──────────┐
                                     │   Cloudflare R2        │
                                     │   collapse-video bucket│
                                     └─────────────┬──────────┘
                                                   │ R2 binding
                                     ┌─────────────▼──────────┐
                                     │  collapse-video-worker │
                                     │  (Cloudflare Worker)   │
                                     │  - Range requests      │
                                     │  - CORS headers        │
                                     │  - Cache API           │
                                     │  - Inline player UI    │
                                     └────────────────────────┘
                                              ▲
                                     Browser visits /
```

## Structure

```
collapse-mcp/          MCP server (Node.js, stdio)
  src/index.ts         Tools: upload_collapse_chunks, get_stream_url, get_video_info, delete_video
  package.json
  tsconfig.json
  .env.example

collapse-webapp/       Cloudflare Worker + upload script
  src/worker.ts        Worker: range-request video streaming + inline player
  wrangler.toml        R2 bucket binding config
  scripts/upload.mjs   One-shot upload script using wrangler CLI
  package.json
```

## Quick Start

### 1. Login to Cloudflare

```bash
npx wrangler login
```

### 2. Create the R2 bucket

```bash
cd collapse-webapp
npm install
npm run r2:create
```

### 3. Upload the video to R2

```bash
npm run upload
# Uploads C:\Users\banke\OneDrive\Desktop\collapse-full.mp4 → r2://collapse-video/collapse.mp4
# ~1.4 GB — takes a few minutes
```

### 4. Deploy the Worker

```bash
npm run deploy
# → https://collapse-video-worker.<your-subdomain>.workers.dev
```

### 5. Build & Register the MCP Server

```bash
cd ../collapse-mcp
npm install
npm run build
```

Copy `.env.example` to `.env` and fill in your R2 credentials (or just set `COLLAPSE_WORKER_URL` to your deployed Worker URL for public streaming — no R2 credentials needed for playback).

Add to Bob's `mcp.json`:

```json
{
  "mcpServers": {
    "collapse-mcp": {
      "command": "node",
      "args": ["C:/Users/banke/AgenCi-MAIN/collapse-mcp/build/index.js"],
      "env": {
        "R2_ACCOUNT_ID": "${env:R2_ACCOUNT_ID}",
        "R2_ACCESS_KEY_ID": "${env:R2_ACCESS_KEY_ID}",
        "R2_SECRET_ACCESS_KEY": "${env:R2_SECRET_ACCESS_KEY}",
        "R2_BUCKET_NAME": "collapse-video",
        "COLLAPSE_WORKER_URL": "https://collapse-video-worker.<your-subdomain>.workers.dev",
        "COLLAPSE_CHUNK_DIR": "C:\\Users\\banke\\OneDrive\\Desktop\\Collapse"
      }
    }
  }
}
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `upload_collapse_chunks` | Multipart upload of all 57 chunks to R2 |
| `get_stream_url` | Get public Worker URL or presigned R2 URL |
| `get_video_info` | R2 object metadata (size, upload date, ETag) |
| `delete_video` | Remove from R2 (requires `confirm: "DELETE"`) |

## Worker Endpoints

| Path | Description |
|------|-------------|
| `GET /` | Inline video player (dark theme, speed controls, PiP, fullscreen) |
| `GET /video` | Stream `collapse.mp4` with range-request support |
| `GET /video/:key` | Stream any R2 object by key |
| `GET /info` | JSON metadata (size, upload date, ETag) |

## Video Details

- **Source:** 57 × 25 MB chunks → `collapse-full.mp4`
- **Total size:** 1,423.6 MB
- **Format:** H.264 AVC1 / ISO Base Media (MP4)
- **Container:** `ftypisom iso2 avc1 mp41`
