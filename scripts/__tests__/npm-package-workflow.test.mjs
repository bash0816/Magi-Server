import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import test from "node:test";

// npm-package.yml が npm-publish-policy-cli.mjs を実際に呼んでいることを検証する
// 契約テスト。ロジック本体(scripts/npm-publish-policy.mjs)はユニットテスト済みだが、
// YAML側が古いインラインロジックへ差し戻された・呼び出しが欠落した、といった
// 配線ミスはYAMLを直接読まないと検出できないため別途用意する(terra指摘、条件7)。

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOW_FILE = path.join(ROOT, ".github/workflows/npm-package.yml");

test("checkout ステップが存在する(scripts/を読むために必須)", () => {
  const content = readFileSync(WORKFLOW_FILE, "utf8");
  assert.match(content, /actions\/checkout@/);
});

test("Verify build run authenticity ステップが npm-publish-policy-cli.mjs verify-run を呼んでいる", () => {
  const content = readFileSync(WORKFLOW_FILE, "utf8");
  const stepPattern = /- name: Verify build run authenticity[\s\S]*?(?=\n\s*- name:|\n\s*$)/;
  const stepMatch = content.match(stepPattern);
  assert(stepMatch, "Verify build run authenticity ステップが見つかりません");
  assert.match(
    stepMatch[0],
    /node scripts\/npm-publish-policy-cli\.mjs verify-run/,
    "verify-run コマンドの呼び出しが見つかりません（インラインロジックへ差し戻された可能性）",
  );
  // 条件1: staging を許可する記述(古い契約)が復活していないことも確認
  assert.doesNotMatch(
    stepMatch[0],
    /\[\s*"\$BRANCH"\s*=\s*"staging"\s*\]/,
    "staging ブランチを許可する古い条件が残っています",
  );
});

test("Verify candidate version is not a downgrade ステップが npm-publish-policy-cli.mjs verify-candidate-version を呼んでいる", () => {
  const content = readFileSync(WORKFLOW_FILE, "utf8");
  const stepPattern = /- name: Verify candidate version is not a downgrade[\s\S]*?(?=\n\s*- name:|\n\s*$)/;
  const stepMatch = content.match(stepPattern);
  assert(stepMatch, "Verify candidate version is not a downgrade ステップが見つかりません");
  assert.match(
    stepMatch[0],
    /node scripts\/npm-publish-policy-cli\.mjs verify-candidate-version/,
    "verify-candidate-version コマンドの呼び出しが見つかりません",
  );
});

test("Publish to npm ステップが --tag candidate を指定している(--tag staging ではない)", () => {
  const content = readFileSync(WORKFLOW_FILE, "utf8");
  const stepPattern = /- name: Publish to npm[\s\S]*?(?=\n\s*- name:|\n\s*$)/;
  const stepMatch = content.match(stepPattern);
  assert(stepMatch, "Publish to npm ステップが見つかりません");
  assert.match(stepMatch[0], /--tag candidate/, "--tag candidate の指定が見つかりません");
  assert.doesNotMatch(stepMatch[0], /--tag staging/, "--tag staging が残っています");
});

test("concurrency グループが維持されている", () => {
  const content = readFileSync(WORKFLOW_FILE, "utf8");
  assert.match(content, /group:\s*npm-publish-magi-server/);
  assert.match(content, /cancel-in-progress:\s*false/);
});

test("npm-publish environment が維持されている(承認ゲート)", () => {
  const content = readFileSync(WORKFLOW_FILE, "utf8");
  assert.match(content, /environment:\s*npm-publish/);
});
