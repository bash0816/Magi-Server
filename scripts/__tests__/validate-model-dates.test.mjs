import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const ALLOWED_SOURCE_DOMAINS = {
  openai: ["platform.openai.com", "openai.com", "help.openai.com"],
  gemini: ["ai.google.dev", "developers.google.com", "blog.google"],
  claude: ["platform.claude.com", "anthropic.com", "docs.anthropic.com"],
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
