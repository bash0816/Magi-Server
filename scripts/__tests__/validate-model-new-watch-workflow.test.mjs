import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOW_FILE = path.join(ROOT, ".github/workflows/model-new-watch.yml");

/**
 * YAMLを簡易パースしてstepをカウント
 * 準備step（checkout, setup-node）と業務logic stepを分類する
 * @param {string} content YAMLファイルの内容
 * @returns {{ allSteps: any[], businessLogicSteps: any[] }} ステップ一覧
 */
function parseSteps(content) {
  const allSteps = [];
  // "- name:" で始まる行からステップ名を抽出
  const stepNamePattern = /^\s*-\s+name:\s*(.+?)$/gm;
  let match;
  while ((match = stepNamePattern.exec(content)) !== null) {
    allSteps.push({
      name: match[1].trim(),
      fullMatch: match[0]
    });
  }

  // checkout/setup-node は準備stepと見なす、それ以外は業務logic step
  const businessLogicSteps = allSteps.filter(step =>
    !step.name.includes("checkout") &&
    !step.name.includes("setup-node")
  );

  return { allSteps, businessLogicSteps };
}

/**
 * 本処理stepの env セクションを抽出
 * @param {string} content YAMLファイルの内容
 * @param {string} stepName ステップ名
 * @returns {Object} env の key-value
 */
function extractEnvFromStep(content, stepName) {
  // ステップ名の直後の env: ブロックを抽出する簡易パーサー
  const stepPattern = new RegExp(
    `- name: ${stepName}[\\s\\S]*?(?=(- name:|$))`,
    "i"
  );
  const stepMatch = content.match(stepPattern);
  if (!stepMatch) return {};

  const stepContent = stepMatch[0];
  const envPattern = /env:\s*\n((?:(?:\s{10,})[A-Z_]+:.*\n?)*)/;
  const envMatch = stepContent.match(envPattern);
  if (!envMatch) return {};

  const env = {};
  const lines = envMatch[1].split("\n").filter(l => l.trim());
  lines.forEach(line => {
    const [key, value] = line.trim().split(/:\s+/, 2);
    if (key) env[key] = value || "";
  });
  return env;
}

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

  // 4. concurrency が明記されていることを検証（二重稼働防止、STEP2レビュー5回目で確認済み）
  assert.match(content, /concurrency:/);
  assert.match(content, /group:\s*model-new-watch/);
  assert.match(content, /cancel-in-progress:\s*false/);

  // 5. permissions が明記されていることを検証
  assert.match(content, /permissions:/);
  assert.match(content, /contents:\s*write/);
  assert.match(content, /pull-requests:\s*write/);
  assert.match(content, /issues:\s*write/);
});

test("単一オーケストレーター: 本処理stepが1つのみであることを検証（checkout/setup-nodeは準備step）", () => {
  const content = readFileSync(WORKFLOW_FILE, "utf8");
  const { businessLogicSteps } = parseSteps(content);

  // 業務ロジックを実行するstepは1つのみ（checkout/setup-nodeは数えない）
  assert.strictEqual(
    businessLogicSteps.length,
    1,
    `業務ロジックstepが ${businessLogicSteps.length} 個。期待: 1個。step名一覧: ${businessLogicSteps.map(s => s.name).join(", ")}`
  );
});

test("単一オーケストレーター: 本処理stepが scripts/model-new-watch.mjs を呼び出していることを検証", () => {
  const content = readFileSync(WORKFLOW_FILE, "utf8");

  // ステップが model-new-watch.mjs を呼び出しているか確認
  assert.match(
    content,
    /scripts\/model-new-watch\.mjs/,
    "scripts/model-new-watch.mjs が見つかりません。単一オーケストレーター呼び出しが実装されていないか、パスが異なる可能性があります。"
  );
});

test("単一オーケストレーター: 本処理stepの env に必須3つが設定されていることを検証（MODEL_WATCH_ANTHROPIC_KEY は不要）", () => {
  const content = readFileSync(WORKFLOW_FILE, "utf8");
  const { businessLogicSteps } = parseSteps(content);

  assert.strictEqual(businessLogicSteps.length, 1, "業務logic stepが1つでない");
  const businessStepName = businessLogicSteps[0].name;

  // 本処理stepセクションを抽出
  const stepPattern = new RegExp(
    `- name: ${businessStepName}[\\s\\S]*?(?=\\n(?:\\s*-|\\s*$|jobs:))`,
  );
  const stepMatch = content.match(stepPattern);
  assert(stepMatch, `ステップ "${businessStepName}" のコンテンツが見つかりません`);
  const stepContent = stepMatch[0];

  // 必須の3つが明記されていることを確認
  assert.match(
    stepContent,
    /OPENAI_API_KEY:\s*\$\{\{\s*secrets\.MODEL_WATCH_OPENAI_KEY\s*\}\}/,
    "OPENAI_API_KEY が env に設定されていません"
  );
  assert.match(
    stepContent,
    /GEMINI_API_KEY:\s*\$\{\{\s*secrets\.MODEL_WATCH_GEMINI_KEY\s*\}\}/,
    "GEMINI_API_KEY が env に設定されていません"
  );
  assert.match(
    stepContent,
    /GITHUB_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/,
    "GITHUB_TOKEN が env に設定されていません"
  );

  // MODEL_WATCH_ANTHROPIC_KEY は設定されていないことを確認（スクレイピング方式のため不要）
  assert.doesNotMatch(
    stepContent,
    /MODEL_WATCH_ANTHROPIC_KEY/,
    "MODEL_WATCH_ANTHROPIC_KEY が env に設定されています。新設計ではスクレイピング方式のため不要です。"
  );
});
