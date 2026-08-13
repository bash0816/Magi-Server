import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOW_FILE = path.join(ROOT, ".github/workflows/model-new-watch.yml");

test("model-new-watch.yml の基本構造を検証", () => {
  const content = readFileSync(WORKFLOW_FILE, "utf8");

  // 1. checkout が main を明示指定していることを検証（workflow_dispatch での任意ブランチ選択対策）
  assert.match(content, /actions\/checkout@v4/);
  assert.match(content, /with:\s*[\s\S]*?ref:\s*main/);

  // 2. cron トリガーが定義されていることを検証
  assert.match(content, /schedule:/);
  assert.match(content, /cron:/);
  assert.match(content, /17 0 \* \* \*/);  // cron時刻: 17 0（毎日0:17）

  // 3. workflow_dispatch トリガーが定義されていることを検証
  assert.match(content, /workflow_dispatch:/);

  // 4. concurrency が明記されていることを検証（二重稼働防止）
  assert.match(content, /concurrency:/);
  assert.match(content, /group:\s*model-new-watch/);
  assert.match(content, /cancel-in-progress:\s*false/);

  // 5. permissions が明記されていることを検証
  assert.match(content, /permissions:/);
  assert.match(content, /contents:\s*write/);
  assert.match(content, /pull-requests:\s*write/);
  assert.match(content, /issues:\s*write/);
});

test("model-new-watch.yml で secrets が参照されていることを検証", () => {
  const content = readFileSync(WORKFLOW_FILE, "utf8");

  assert.match(content, /MODEL_WATCH_ANTHROPIC_KEY/);
  assert.match(content, /MODEL_WATCH_OPENAI_KEY/);
  assert.match(content, /MODEL_WATCH_GEMINI_KEY/);
});

test("model-new-watch.yml で GITHUB_TOKEN が参照されていることを検証", () => {
  const content = readFileSync(WORKFLOW_FILE, "utf8");
  assert.match(content, /GITHUB_TOKEN/);
});
