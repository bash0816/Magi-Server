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

/** ステップ名一覧を出現順で抽出する(YAML簡易パース、model-new-watch-workflow.test.mjsと同型) */
function extractStepOrder(content) {
  const pattern = /^\s*-\s+(?:name:\s*(.+?)|uses:\s*(.+?))\s*$/gm;
  const steps = [];
  let match;
  while ((match = pattern.exec(content)) !== null) {
    steps.push(match[1] ?? `uses:${match[2]}`);
  }
  return steps;
}

test("STEP8指摘1: checkout/setup-node が Verify build run authenticity より前にある(scripts/実行に必須)", () => {
  const content = readFileSync(WORKFLOW_FILE, "utf8");
  const order = extractStepOrder(content);
  const checkoutIdx = order.findIndex((s) => s.startsWith("uses:actions/checkout"));
  const setupNodeIdx = order.findIndex((s) => s.startsWith("uses:actions/setup-node"));
  const verifyRunIdx = order.indexOf("Verify build run authenticity");
  assert.notEqual(checkoutIdx, -1, "checkoutステップが見つかりません");
  assert.notEqual(setupNodeIdx, -1, "setup-nodeステップが見つかりません");
  assert.notEqual(verifyRunIdx, -1, "Verify build run authenticityステップが見つかりません");
  assert(checkoutIdx < verifyRunIdx, "checkoutがVerify build run authenticityより後にあります");
  assert(setupNodeIdx < verifyRunIdx, "setup-nodeがVerify build run authenticityより後にあります");
});

test("STEP8指摘1: checkout/setup-node が Verify candidate version より前にある", () => {
  const content = readFileSync(WORKFLOW_FILE, "utf8");
  const order = extractStepOrder(content);
  const checkoutIdx = order.findIndex((s) => s.startsWith("uses:actions/checkout"));
  const setupNodeIdx = order.findIndex((s) => s.startsWith("uses:actions/setup-node"));
  const verifyCandidateIdx = order.indexOf("Verify candidate version is not a downgrade");
  assert.notEqual(verifyCandidateIdx, -1, "Verify candidate versionステップが見つかりません");
  assert(checkoutIdx < verifyCandidateIdx);
  assert(setupNodeIdx < verifyCandidateIdx);
});

test("STEP8指摘4: Publish to npm as @candidate が Verify candidate version より後にある(検証をすり抜けてpublishできない)", () => {
  const content = readFileSync(WORKFLOW_FILE, "utf8");
  const order = extractStepOrder(content);
  const verifyCandidateIdx = order.indexOf("Verify candidate version is not a downgrade");
  const publishIdx = order.indexOf("Publish to npm as @candidate");
  assert.notEqual(publishIdx, -1, "Publish to npm as @candidateステップが見つかりません");
  assert(verifyCandidateIdx < publishIdx, "publishがcandidateダウングレード検証より前で実行され得ます");
});

test("STEP8指摘2: verify-run 呼び出しに --head-sha と --main-sha が渡っている", () => {
  const content = readFileSync(WORKFLOW_FILE, "utf8");
  const stepPattern = /- name: Verify build run authenticity[\s\S]*?(?=\n\s*- name:|\n\s*$)/;
  const stepMatch = content.match(stepPattern);
  assert(stepMatch, "Verify build run authenticity ステップが見つかりません");
  const callPattern = /node scripts\/npm-publish-policy-cli\.mjs verify-run[\s\S]*?(?=\n\s*echo|\n\s*$)/;
  const callMatch = stepMatch[0].match(callPattern);
  assert(callMatch, "verify-run 呼び出し全体が見つかりません");
  assert.match(callMatch[0], /--head-sha="\$HEAD_SHA"/, "--head-sha が渡されていません");
  assert.match(callMatch[0], /--main-sha="\$MAIN_SHA"/, "--main-sha が渡されていません");
  // head_shaがMagi-Systemのmain先端から取得されていることも確認(なりすまし防止)
  assert.match(
    stepMatch[0],
    /MAIN_SHA=\$\(gh api repos\/bash0816\/Magi-System\/commits\/main --jq '\.sha'\)/,
    "MAIN_SHAがMagi-Systemのmain先端から取得されていません",
  );
});

test("STEP8指摘3: policy CLI呼び出しが失敗を握りつぶしていない(|| true 等が付いていない)", () => {
  const content = readFileSync(WORKFLOW_FILE, "utf8");
  const callSites = [
    ...content.matchAll(/node scripts\/npm-publish-policy-cli\.mjs[^\n]*(?:\\\n\s*[^\n]*)*/g),
  ];
  assert(callSites.length >= 2, `policy CLI呼び出しが2箇所(verify-run, verify-candidate-version)未満: ${callSites.length}`);
  for (const call of callSites) {
    assert.doesNotMatch(
      call[0],
      /\|\|\s*true\s*$/m,
      `policy CLI呼び出しが失敗を握りつぶしています: ${call[0]}`,
    );
  }
  // set -eu が各該当stepで有効であること(コマンド自体の失敗がstep失敗に伝播する前提)
  const verifyRunStep = content.match(/- name: Verify build run authenticity[\s\S]*?(?=\n\s*- name:|\n\s*$)/)[0];
  const verifyCandidateStep = content.match(
    /- name: Verify candidate version is not a downgrade[\s\S]*?(?=\n\s*- name:|\n\s*$)/,
  )[0];
  assert.match(verifyRunStep, /set -eu/, "Verify build run authenticity に set -eu がありません");
  assert.match(verifyCandidateStep, /set -eu/, "Verify candidate version is not a downgrade に set -eu がありません");
});
