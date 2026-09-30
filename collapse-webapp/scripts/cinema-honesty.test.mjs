/**
 * Honesty invariants for the Cinema inline player.
 * The UI must not claim a film name that R2 does not serve.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workerSrc = readFileSync(join(root, "src/worker.ts"), "utf8");
const playerMatch = workerSrc.match(/const INLINE_PLAYER = `([\s\S]*)`;\s*$/m);

test("worker.ts embeds an INLINE_PLAYER HTML string", () => {
  assert.ok(playerMatch, "expected const INLINE_PLAYER = `...` in worker.ts");
});

const player = playerMatch?.[1] ?? "";

test("Cinema does not label the collapse.mp4 stream as Coherence", () => {
  assert.equal(/<h2>\s*Coherence\b/.test(player), false, "heading must not say Coherence");
  assert.equal(/download="coherence-master\.mp4"/.test(player), false, "download must not claim coherence-master.mp4");
  assert.equal(/⬇ Coherence file/.test(player), false, "download label must not say Coherence file");
  assert.equal(/Collapse · Coherence/.test(player), false, "header must not list Coherence as a film");
  assert.equal(/coherence:\s*\{\s*key:\s*'collapse\.mp4'/.test(player), false, "FILMS must not alias coherence → collapse.mp4");
});

test("master panel heading, download name, and R2 key match collapse.mp4", () => {
  assert.match(player, /<h2>Collapse \(master\)/);
  assert.match(player, /download="collapse-master\.mp4"/);
  assert.match(player, /master:\s*\{\s*key:\s*'collapse\.mp4'\s*\}/);
  assert.match(player, /setupFilm\('master'\)/);
});

test("player states that the Coherence asset is not uploaded", () => {
  assert.match(player, /Coherence asset not uploaded/i);
});

test("Breath panel keeps the working breath.mp4 key", () => {
  assert.match(player, /<h2>Breath\b/);
  assert.match(player, /breath:\s*\{\s*key:\s*'breath\.mp4'\s*\}/);
  assert.match(player, /src="\/video\/breath\.mp4"/);
  assert.match(player, /download="breath\.mp4"/);
});
