import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "scripts/model-watch-state.mjs");

async function loadScript() {
  return import(pathToFileURL(SCRIPT).href + "?t=" + Date.now());
}

describe("model-watch-state state merge rules (design.md §7.1)", () => {
  describe("mergeStateForRollback(main, modelWatchState)", () => {
    it("providers.openai.observedIds を集合和（重複除去）で統合すること", async () => {
      const mod = await loadScript();

      const main = {
        version: 1,
        providers: {
          openai: { observedIds: ["gpt-4", "gpt-3.5"] },
          gemini: { needsReviewNotified: [] },
          claude: { needsReviewNotified: [] },
        },
      };

      const modelWatchState = {
        version: 1,
        providers: {
          openai: { observedIds: ["gpt-4", "gpt-4-turbo"] },
          gemini: { needsReviewNotified: [] },
          claude: { needsReviewNotified: [] },
        },
      };

      const merged = await mod.mergeStateForRollback(main, modelWatchState);

      // 集合和: ["gpt-4", "gpt-3.5", "gpt-4-turbo"]（重複なし）
      assert.deepEqual(
        new Set(merged.providers.openai.observedIds),
        new Set(["gpt-4", "gpt-3.5", "gpt-4-turbo"]),
        "重複を除いた和集合であること"
      );
      assert.equal(
        merged.providers.openai.observedIds.length,
        3,
        "重複がないこと"
      );
    });

    it("providers.gemini.needsReviewNotified を集合和で統合すること", async () => {
      const mod = await loadScript();

      const main = {
        version: 1,
        providers: {
          openai: { observedIds: [] },
          gemini: { needsReviewNotified: ["gemini-pro", "gemini-1.5"] },
          claude: { needsReviewNotified: [] },
        },
      };

      const modelWatchState = {
        version: 1,
        providers: {
          openai: { observedIds: [] },
          gemini: { needsReviewNotified: ["gemini-1.5", "gemini-2-flash"] },
          claude: { needsReviewNotified: [] },
        },
      };

      const merged = await mod.mergeStateForRollback(main, modelWatchState);

      assert.deepEqual(
        new Set(merged.providers.gemini.needsReviewNotified),
        new Set(["gemini-pro", "gemini-1.5", "gemini-2-flash"]),
        "Gemini の needsReviewNotified が和集合で統合されること"
      );
    });

    it("providers.claude.needsReviewNotified を集合和で統合すること", async () => {
      const mod = await loadScript();

      const main = {
        version: 1,
        providers: {
          openai: { observedIds: [] },
          gemini: { needsReviewNotified: [] },
          claude: { needsReviewNotified: ["claude-3-opus"] },
        },
      };

      const modelWatchState = {
        version: 1,
        providers: {
          openai: { observedIds: [] },
          gemini: { needsReviewNotified: [] },
          claude: { needsReviewNotified: ["claude-3-opus", "claude-3-sonnet"] },
        },
      };

      const merged = await mod.mergeStateForRollback(main, modelWatchState);

      assert.deepEqual(
        new Set(merged.providers.claude.needsReviewNotified),
        new Set(["claude-3-opus", "claude-3-sonnet"]),
        "Claude の needsReviewNotified が和集合で統合されること"
      );
    });

    it("version は両ブランチの値のうち大きい方（新しい方）を採用すること", async () => {
      const mod = await loadScript();

      const main = {
        version: 1,
        providers: {
          openai: { observedIds: [] },
          gemini: { needsReviewNotified: [] },
          claude: { needsReviewNotified: [] },
        },
      };

      const modelWatchState = {
        version: 2,
        providers: {
          openai: { observedIds: [] },
          gemini: { needsReviewNotified: [] },
          claude: { needsReviewNotified: [] },
        },
      };

      const merged = await mod.mergeStateForRollback(main, modelWatchState);

      assert.equal(merged.version, 2, "大きい version を採用すること");
    });

    it("version が main 側が大きい場合、main 側の version を採用すること", async () => {
      const mod = await loadScript();

      const main = {
        version: 3,
        providers: {
          openai: { observedIds: [] },
          gemini: { needsReviewNotified: [] },
          claude: { needsReviewNotified: [] },
        },
      };

      const modelWatchState = {
        version: 2,
        providers: {
          openai: { observedIds: [] },
          gemini: { needsReviewNotified: [] },
          claude: { needsReviewNotified: [] },
        },
      };

      const merged = await mod.mergeStateForRollback(main, modelWatchState);

      assert.equal(merged.version, 3, "main 側の大きい version を採用すること");
    });

    it("未知フィールドが main 側にのみ存在する場合、それを引き継ぐこと", async () => {
      const mod = await loadScript();

      const main = {
        version: 1,
        providers: {
          openai: { observedIds: [] },
          gemini: { needsReviewNotified: [] },
          claude: { needsReviewNotified: [] },
        },
        _metadata: { lastUpdated: "2026-08-16" },
      };

      const modelWatchState = {
        version: 1,
        providers: {
          openai: { observedIds: [] },
          gemini: { needsReviewNotified: [] },
          claude: { needsReviewNotified: [] },
        },
      };

      const merged = await mod.mergeStateForRollback(main, modelWatchState);

      assert.deepEqual(
        merged._metadata,
        { lastUpdated: "2026-08-16" },
        "main 側の _metadata を引き継ぐこと"
      );
    });

    it("未知フィールドが model-watch-state 側にのみ存在する場合、それを引き継ぐこと", async () => {
      const mod = await loadScript();

      const main = {
        version: 1,
        providers: {
          openai: { observedIds: [] },
          gemini: { needsReviewNotified: [] },
          claude: { needsReviewNotified: [] },
        },
      };

      const modelWatchState = {
        version: 1,
        providers: {
          openai: { observedIds: [] },
          gemini: { needsReviewNotified: [] },
          claude: { needsReviewNotified: [] },
        },
        _stateMetadata: { createdAt: "2026-08-15" },
      };

      const merged = await mod.mergeStateForRollback(main, modelWatchState);

      assert.deepEqual(
        merged._stateMetadata,
        { createdAt: "2026-08-15" },
        "model-watch-state 側の _stateMetadata を引き継ぐこと"
      );
    });

    it("未知フィールドが main 側を優先するルール: 両側に同一フィールドが存在する場合、main 側を採用すること", async () => {
      const mod = await loadScript();

      const main = {
        version: 1,
        providers: {
          openai: { observedIds: [] },
          gemini: { needsReviewNotified: [] },
          claude: { needsReviewNotified: [] },
        },
        _metadata: { source: "main", priority: "high" },
      };

      const modelWatchState = {
        version: 1,
        providers: {
          openai: { observedIds: [] },
          gemini: { needsReviewNotified: [] },
          claude: { needsReviewNotified: [] },
        },
        _metadata: { source: "state-branch", priority: "low" },
      };

      const merged = await mod.mergeStateForRollback(main, modelWatchState);

      assert.deepEqual(
        merged._metadata,
        { source: "main", priority: "high" },
        "main 側の _metadata を優先すること"
      );
    });

    it("複数の配列フィールドを同時にマージすること（複合シナリオ）", async () => {
      const mod = await loadScript();

      const main = {
        version: 1,
        providers: {
          openai: { observedIds: ["gpt-4", "gpt-3.5"] },
          gemini: { needsReviewNotified: ["gemini-pro"] },
          claude: { needsReviewNotified: [] },
        },
      };

      const modelWatchState = {
        version: 2,
        providers: {
          openai: { observedIds: ["gpt-4", "gpt-4-turbo"] },
          gemini: { needsReviewNotified: ["gemini-pro", "gemini-1.5"] },
          claude: { needsReviewNotified: ["claude-3-opus"] },
        },
      };

      const merged = await mod.mergeStateForRollback(main, modelWatchState);

      // OpenAI
      assert.deepEqual(
        new Set(merged.providers.openai.observedIds),
        new Set(["gpt-4", "gpt-3.5", "gpt-4-turbo"]),
        "OpenAI observedIds が集合和で統合されること"
      );

      // Gemini
      assert.deepEqual(
        new Set(merged.providers.gemini.needsReviewNotified),
        new Set(["gemini-pro", "gemini-1.5"]),
        "Gemini needsReviewNotified が集合和で統合されること"
      );

      // Claude
      assert.deepEqual(
        merged.providers.claude.needsReviewNotified,
        ["claude-3-opus"],
        "Claude needsReviewNotified が集合和で統合されること"
      );

      // Version は大きい方
      assert.equal(
        merged.version,
        2,
        "version は大きい方を採用すること"
      );
    });

    it("main 側が空の場合、model-watch-state 側の値をそのまま使用すること", async () => {
      const mod = await loadScript();

      const main = {
        version: 1,
        providers: {
          openai: { observedIds: [] },
          gemini: { needsReviewNotified: [] },
          claude: { needsReviewNotified: [] },
        },
      };

      const modelWatchState = {
        version: 1,
        providers: {
          openai: { observedIds: ["gpt-4", "gpt-3.5"] },
          gemini: { needsReviewNotified: ["gemini-pro"] },
          claude: { needsReviewNotified: ["claude-3-opus"] },
        },
      };

      const merged = await mod.mergeStateForRollback(main, modelWatchState);

      assert.deepEqual(
        merged.providers.openai.observedIds,
        ["gpt-4", "gpt-3.5"]
      );
      assert.deepEqual(
        merged.providers.gemini.needsReviewNotified,
        ["gemini-pro"]
      );
      assert.deepEqual(
        merged.providers.claude.needsReviewNotified,
        ["claude-3-opus"]
      );
    });

    it("model-watch-state 側が空の場合、main 側の値をそのまま使用すること", async () => {
      const mod = await loadScript();

      const main = {
        version: 1,
        providers: {
          openai: { observedIds: ["gpt-4"] },
          gemini: { needsReviewNotified: ["gemini-pro"] },
          claude: { needsReviewNotified: [] },
        },
      };

      const modelWatchState = {
        version: 1,
        providers: {
          openai: { observedIds: [] },
          gemini: { needsReviewNotified: [] },
          claude: { needsReviewNotified: [] },
        },
      };

      const merged = await mod.mergeStateForRollback(main, modelWatchState);

      assert.deepEqual(
        merged.providers.openai.observedIds,
        ["gpt-4"]
      );
      assert.deepEqual(
        merged.providers.gemini.needsReviewNotified,
        ["gemini-pro"]
      );
    });

    it("providers 配下の既知プロバイダーで未知フィールドが watch 側にのみ存在する場合、引き継ぐこと", async () => {
      const mod = await loadScript();

      const main = {
        version: 1,
        providers: {
          openai: { observedIds: ["gpt-4"] },
          gemini: { needsReviewNotified: [] },
          claude: { needsReviewNotified: [] },
        },
      };

      const modelWatchState = {
        version: 1,
        providers: {
          openai: {
            observedIds: ["gpt-4", "gpt-3.5"],
            lastCheckedAt: "2026-08-16T10:00:00Z", // 未知フィールド
          },
          gemini: {
            needsReviewNotified: [],
            syncStatus: "success", // 未知フィールド
          },
          claude: { needsReviewNotified: [] },
        },
      };

      const merged = await mod.mergeStateForRollback(main, modelWatchState);

      // 既知フィールド（集合和）と未知フィールド（watch側を引き継ぐ）が両方存在すること
      assert.deepEqual(
        new Set(merged.providers.openai.observedIds),
        new Set(["gpt-4", "gpt-3.5"])
      );
      assert.equal(
        merged.providers.openai.lastCheckedAt,
        "2026-08-16T10:00:00Z",
        "openai の未知フィールド lastCheckedAt を引き継ぐこと"
      );

      assert.deepEqual(merged.providers.gemini.needsReviewNotified, []);
      assert.equal(
        merged.providers.gemini.syncStatus,
        "success",
        "gemini の未知フィールド syncStatus を引き継ぐこと"
      );
    });

    it("providers 配下の既知プロバイダーで main 側に存在する未知フィールドを優先すること", async () => {
      const mod = await loadScript();

      const main = {
        version: 1,
        providers: {
          openai: {
            observedIds: ["gpt-4"],
            metadata: { version: "main-v1", priority: "high" }, // main 側の未知フィールド
          },
          gemini: { needsReviewNotified: [] },
          claude: { needsReviewNotified: [] },
        },
      };

      const modelWatchState = {
        version: 1,
        providers: {
          openai: {
            observedIds: ["gpt-4", "gpt-3.5"],
            metadata: { version: "watch-v1", priority: "low" }, // watch 側にも同名フィールド
          },
          gemini: { needsReviewNotified: [] },
          claude: { needsReviewNotified: [] },
        },
      };

      const merged = await mod.mergeStateForRollback(main, modelWatchState);

      // main 側の metadata を優先すること
      assert.deepEqual(
        merged.providers.openai.metadata,
        { version: "main-v1", priority: "high" },
        "main 側の metadata を優先すること"
      );
    });

    it("providers 配下の未知プロバイダーが watch 側にのみ存在する場合、引き継ぐこと", async () => {
      const mod = await loadScript();

      const main = {
        version: 1,
        providers: {
          openai: { observedIds: [] },
          gemini: { needsReviewNotified: [] },
          claude: { needsReviewNotified: [] },
        },
      };

      const modelWatchState = {
        version: 1,
        providers: {
          openai: { observedIds: [] },
          gemini: { needsReviewNotified: [] },
          claude: { needsReviewNotified: [] },
          azureai: { observedIds: ["azure-model-1"] }, // 未知プロバイダー
          xai: { observedIds: ["grok-2"] }, // 未知プロバイダー
        },
      };

      const merged = await mod.mergeStateForRollback(main, modelWatchState);

      // 未知プロバイダーが引き継がれること
      assert.deepEqual(
        merged.providers.azureai,
        { observedIds: ["azure-model-1"] },
        "watch 側の未知プロバイダー azureai を引き継ぐこと"
      );
      assert.deepEqual(
        merged.providers.xai,
        { observedIds: ["grok-2"] },
        "watch 側の未知プロバイダー xai を引き継ぐこと"
      );
    });

    it("providers 配下の未知プロバイダーが main 側に存在する場合、それを優先すること", async () => {
      const mod = await loadScript();

      const main = {
        version: 1,
        providers: {
          openai: { observedIds: [] },
          gemini: { needsReviewNotified: [] },
          claude: { needsReviewNotified: [] },
          azureai: { observedIds: ["azure-main"] }, // main 側の未知プロバイダー
        },
      };

      const modelWatchState = {
        version: 1,
        providers: {
          openai: { observedIds: [] },
          gemini: { needsReviewNotified: [] },
          claude: { needsReviewNotified: [] },
          azureai: { observedIds: ["azure-watch"] }, // watch 側にも同名プロバイダー
        },
      };

      const merged = await mod.mergeStateForRollback(main, modelWatchState);

      // main 側の azureai を優先すること
      assert.deepEqual(
        merged.providers.azureai,
        { observedIds: ["azure-main"] },
        "main 側の azureai を優先すること"
      );
    });

    it("providers 内のすべてのレベルで未知フィールド統合が機能する複合シナリオ", async () => {
      const mod = await loadScript();

      const main = {
        version: 2,
        providers: {
          openai: {
            observedIds: ["gpt-4"],
            mainField: "only-in-main",
          },
          gemini: { needsReviewNotified: ["gemini-pro"] },
          claude: { needsReviewNotified: [] },
          anthropic: { // 未知プロバイダー（main側）
            customField: "value-from-main",
          },
        },
      };

      const modelWatchState = {
        version: 1,
        providers: {
          openai: {
            observedIds: ["gpt-4", "gpt-3.5"],
            watchField: "only-in-watch",
          },
          gemini: {
            needsReviewNotified: ["gemini-pro", "gemini-2"],
            syncedAt: "2026-08-16T12:00:00Z",
          },
          claude: { needsReviewNotified: ["claude-3-opus"] },
          openrouter: { // 未知プロバイダー（watch側）
            observedIds: ["openrouter-model"],
          },
        },
      };

      const merged = await mod.mergeStateForRollback(main, modelWatchState);

      // OpenAI: main側フィールド優先、watch側の集合和に追加
      assert.deepEqual(
        new Set(merged.providers.openai.observedIds),
        new Set(["gpt-4", "gpt-3.5"]),
        "openai observedIds が集合和であること"
      );
      assert.equal(
        merged.providers.openai.mainField,
        "only-in-main",
        "main側の未知フィールド mainField を引き継ぐこと"
      );
      assert.equal(
        merged.providers.openai.watchField,
        "only-in-watch",
        "watch側にのみ存在する未知フィールド watchField を引き継ぐこと（main側に存在しないため）"
      );

      // Gemini: watch側フィールドを引き継ぐ
      assert.deepEqual(
        new Set(merged.providers.gemini.needsReviewNotified),
        new Set(["gemini-pro", "gemini-2"])
      );
      assert.equal(
        merged.providers.gemini.syncedAt,
        "2026-08-16T12:00:00Z",
        "gemini の未知フィールド syncedAt を引き継ぐこと"
      );

      // Claude: watch側の値を使用
      assert.deepEqual(
        merged.providers.claude.needsReviewNotified,
        ["claude-3-opus"]
      );

      // Anthropic: main側の未知プロバイダーを優先
      assert.deepEqual(
        merged.providers.anthropic,
        { customField: "value-from-main" }
      );

      // OpenRouter: watch側の未知プロバイダーを引き継ぐ
      assert.deepEqual(
        merged.providers.openrouter,
        { observedIds: ["openrouter-model"] }
      );

      // Version: 大きい方を採用
      assert.equal(merged.version, 2);
    });
  });
});
