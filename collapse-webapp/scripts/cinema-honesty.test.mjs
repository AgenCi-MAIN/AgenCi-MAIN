import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const workerPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "worker.ts");
const src = readFileSync(workerPath, "utf8");
const player = src.slice(src.indexOf("const INLINE_PLAYER"));

test("cinema player labels collapse.mp4 as Collapse (master), not Coherence", () => {
  assert.match(player, /<h2>Collapse \(master\)/);
  assert.match(player, /download="collapse-master\.mp4"/);
  assert.match(player, /key:\s*'collapse\.mp4'/);
  assert.match(src, /const VIDEO_KEY = "collapse\.mp4"/);
  assert.doesNotMatch(player, /<h2>Coherence/);
  assert.doesNotMatch(player, /download="coherence-master\.mp4"/);
  assert.doesNotMatch(player, /key:\s*'coherence\.mp4'/);
  assert.match(
    player,
    /Coherence asset not uploaded|Coherence asset is not uploaded/
  );
});

test("keeps working Collapse web and Breath panels and does not invent a coherence R2 key", () => {
  assert.match(player, /src="\/video\/collapse-web\.mp4"/);
  assert.match(player, /download="collapse\.mp4"/);
  assert.match(player, /<h2>Breath /);
  assert.match(player, /src="\/video\/breath\.mp4"/);
  assert.match(player, /key:\s*'breath\.mp4'/);
  assert.match(player, /href="\/video"/);
});
