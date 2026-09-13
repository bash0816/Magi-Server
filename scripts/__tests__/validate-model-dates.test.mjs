import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const ALLOWED_SOURCE_DOMAINS = {
  openai: ["platform.openai.com", "openai.com", "help.openai.com"],
  gemini: ["ai.google.dev", "developers.google.com", "blog.google"],
  claude: ["platform.claude.com", "anthropic.com", "docs.anthropic.com"],
  copilot: ["github.blog", "docs.github.com"],
};

function isValidSourceUrl(url, provider) {
  if (typeof url !== "string" || !url.startsWith("https://")) return false;
  try {
    const { hostname } = new URL(url);
    return (ALLOWED_SOURCE_DOMAINS[provider] ?? []).some(
      (domain) => hostname === domain || hostname.endsWith("." + domain)
    );
  } catch {
    return false;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const REQUIRED_FIELDS = ["deprecated_at", "deprecated_source", "shutdown_at", "shutdown_source"];

test("全モデルエントリにdeprecated_at/deprecated_source/shutdown_at/shutdown_sourceの4フィールドが存在し、日付を設定する場合は対応するsourceが公式ドメインのURLであること", () => {
  const data = JSON.parse(readFileSync(new URL("../../data/models.json", import.meta.url), "utf8"));
  const violations = [];

  for (const [provider, info] of Object.entries(data.providers)) {
    for (const model of info.models) {
      // STEP2レビュー2回目Non-blocker対応: 全エントリに4フィールドが揃っている
      // ことを構造的に検証する（buildEntry()がsourceフィールドを生成し忘れる
      // ような回帰を検出するため）
      for (const field of REQUIRED_FIELDS) {
        if (!(field in model)) {
          violations.push(`${provider}/${model.id}: ${field} フィールドが存在しません`);
        }
      }

      for (const [dateField, sourceField] of [
        ["deprecated_at", "deprecated_source"],
        ["shutdown_at", "shutdown_source"],
      ]) {
        const dateValue = model[dateField];
        // STEP2レビュー2回目Non-blocker対応: `!dateValue`だと空文字列も
        // 「未設定」として通ってしまうため、null判定とISO日付形式検証に厳格化
        if (dateValue === null || dateValue === undefined) continue;
        if (typeof dateValue !== "string" || !ISO_DATE.test(dateValue)) {
          violations.push(`${provider}/${model.id}: ${dateField}=${JSON.stringify(dateValue)} はYYYY-MM-DD形式のISO日付ではありません`);
          continue;
        }
        if (!isValidSourceUrl(model[sourceField], provider)) {
          violations.push(
            `${provider}/${model.id}: ${dateField}=${dateValue} が設定されているが ` +
            `${sourceField} が有効な公式ドメインURLではない(値: ${JSON.stringify(model[sourceField])})`
          );
        }
      }
    }
  }

  assert.deepEqual(violations, [], violations.join("\n"));
});

test("2026-09-03のGitHub公式Copilotモデル廃止告知(4件)が漏れなく正しく反映されていること", () => {
  const data = JSON.parse(readFileSync(new URL("../../data/models.json", import.meta.url), "utf8"));
  const SOURCE_URL = "https://github.blog/changelog/2026-09-03-upcoming-deprecation-of-selected-github-copilot-models/";
  const EXPECTED_DEPRECATED_AT = "2026-10-02";
  const EXPECTED_SHUTDOWN_AT = "2026-10-02";
  const ANNOUNCED_DEPRECATIONS = ["gemini-3.5-flash", "gemini-3.6-flash", "kimi-k2.7-code", "claude-opus-4.7"];

  const copilotModels = data.providers.copilot.models;
  const byId = new Map(copilotModels.map((m) => [m.id, m]));
  const violations = [];

  for (const id of ANNOUNCED_DEPRECATIONS) {
    const model = byId.get(id);
    if (!model) {
      violations.push(`${id}: copilotプロバイダーにエントリ自体が存在しません`);
      continue;
    }
    if (model.deprecated_at !== EXPECTED_DEPRECATED_AT) {
      violations.push(`${id}: deprecated_atが${JSON.stringify(model.deprecated_at)}（期待値: ${EXPECTED_DEPRECATED_AT}。告知日ではなく実際の廃止日と一致させること）`);
    }
    if (model.shutdown_at !== EXPECTED_SHUTDOWN_AT) {
      violations.push(`${id}: shutdown_atが${JSON.stringify(model.shutdown_at)}（期待値: ${EXPECTED_SHUTDOWN_AT}）`);
    }
    if (model.deprecated_source !== SOURCE_URL || model.shutdown_source !== SOURCE_URL) {
      violations.push(`${id}: deprecated_source/shutdown_sourceが告知URLと一致しません`);
    }
  }

  assert.deepEqual(violations, [], violations.join("\n"));
});

test("2026-08-31のGitHub公式Copilotモデル廃止告知(2026-09-01廃止・4件)が漏れなく正しく反映されていること", () => {
  const data = JSON.parse(readFileSync(new URL("../../data/models.json", import.meta.url), "utf8"));
  const SOURCE_URL = "https://github.blog/changelog/2026-08-31-selected-github-copilot-models-deprecated/";
  const EXPECTED_DEPRECATED_AT = "2026-09-01";
  const EXPECTED_SHUTDOWN_AT = "2026-09-01";
  // 8/31告知には他に claude-sonnet-4.6（個人年払いプランのみ例外的に利用可能で現スキーマでは
  // 表現できないため除外済み、下でnon-existenceを検証）と Raptor Mini（GitHub Communityの
  // 回答によればCopilot CLIには公開されていないとのこと、そもそも本カタログの対象外。
  // 参照: https://github.com/orgs/community/discussions/186154 ※公式ドキュメントではなく
  // コミュニティ上のユーザー回答のため参考情報。下でnon-existenceを検証）も含まれるが、
  // いずれもこのCLIモデルカタログには該当しないため対象外とする
  const ANNOUNCED_DEPRECATIONS = ["claude-opus-4.5", "claude-opus-4.6", "claude-sonnet-4.5", "gemini-3.1-pro-preview"];

  const copilotModels = data.providers.copilot.models;
  const byId = new Map(copilotModels.map((m) => [m.id, m]));
  const violations = [];

  if (byId.has("claude-sonnet-4.6")) {
    violations.push("claude-sonnet-4.6: 個人年払いプランのみの例外モデルのため、カタログから除外されているべきです（現スキーマはプラン別可用性を表現できない）");
  }
  if (byId.has("raptor-mini")) {
    violations.push("raptor-mini: Copilot CLIには公開されていないため、カタログから除外されているべきです");
  }

  for (const id of ANNOUNCED_DEPRECATIONS) {
    const model = byId.get(id);
    if (!model) {
      violations.push(`${id}: copilotプロバイダーにエントリ自体が存在しません`);
      continue;
    }
    if (model.deprecated_at !== EXPECTED_DEPRECATED_AT) {
      violations.push(`${id}: deprecated_atが${JSON.stringify(model.deprecated_at)}（期待値: ${EXPECTED_DEPRECATED_AT}）`);
    }
    if (model.shutdown_at !== EXPECTED_SHUTDOWN_AT) {
      violations.push(`${id}: shutdown_atが${JSON.stringify(model.shutdown_at)}（期待値: ${EXPECTED_SHUTDOWN_AT}）`);
    }
    if (model.deprecated_source !== SOURCE_URL || model.shutdown_source !== SOURCE_URL) {
      violations.push(`${id}: deprecated_source/shutdown_sourceが告知URLと一致しません`);
    }
  }

  assert.deepEqual(violations, [], violations.join("\n"));
});
