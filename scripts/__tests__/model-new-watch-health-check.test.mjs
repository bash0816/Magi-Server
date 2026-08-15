import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "scripts/model-new-watch-health-check.mjs");

async function loadScript() {
  return import(pathToFileURL(SCRIPT).href + "?t=" + Date.now());
}

function makeResponse(status, body) {
  return {
    status,
    json: async () => body,
  };
}

describe("model-new-watch-health-check", () => {
  it("失敗時、既存issueなし→固定タイトル[model-new-watch]で新規作成", async () => {
    const mod = await loadScript();
    const calls = [];

    const result = await mod.reportModelNewWatchFailure({
      fetchFn: async (url, init) => {
        calls.push({ url, init });
        if (calls.length === 1) return makeResponse(200, []);
        const body = JSON.parse(init.body);
        assert.equal(body.title, "[model-new-watch] 実行失敗");
        return makeResponse(201, { number: 21, html_url: "https://github.com/bash0816/Magi-Server/issues/21" });
      },
      githubToken: "gh-token",
      failureMessage: "detect failed",
    });

    assert.equal(result.action, "created");
    assert.equal(result.issueNumber, 21);
  });

  it("成功時、既存issueなし→何もしない(API呼び出しなし)", async () => {
    const mod = await loadScript();
    let called = false;

    const result = await mod.reportModelNewWatchSuccess({
      fetchFn: async () => {
        called = true;
        throw new Error("fetch should not be called");
      },
      githubToken: "gh-token",
      openIssues: [],
    });

    assert.equal(result.action, "noop");
    assert.equal(called, false);
  });

  it("main(mode=success)がexit 0で終了する", async () => {
    const mod = await loadScript();
    const logs = [];
    const exitCode = await mod.main({
      mode: "success",
      env: { GITHUB_TOKEN: "gh-token" },
      openIssues: [],
      console: { log: (m) => logs.push(m), error: (m) => logs.push(m) },
    });

    assert.equal(exitCode, 0);
  });

  it("main(mode未指定)がexit 1でエラーメッセージを出す", async () => {
    const mod = await loadScript();
    const logs = [];
    const exitCode = await mod.main({
      env: { GITHUB_TOKEN: "gh-token" },
      console: { log: (m) => logs.push(m), error: (m) => logs.push(m) },
    });

    assert.equal(exitCode, 1);
    assert.ok(logs.some((m) => m.includes("mode")));
  });

  describe("reportModelNewWatchFailure の failedProviders 検証", () => {
    it("failedProviders 配列が Issue 本文に含まれること", async () => {
      const mod = await loadScript();
      const calls = [];

      const result = await mod.reportModelNewWatchFailure({
        fetchFn: async (url, init) => {
          calls.push({ url, init });
          if (calls.length === 1) {
            // Issue 検索
            return makeResponse(200, []);
          }
          // Issue 作成
          const body = JSON.parse(init.body);
          assert.equal(body.title, "[model-new-watch] 実行失敗");
          // failedProviders が Issue 本文に含まれることを検証
          assert.ok(
            body.body.includes("openai") || body.body.includes("gemini") || body.body.includes("claude"),
            "Issue 本文に failedProviders が含まれるべき"
          );
          return makeResponse(201, { number: 50, html_url: "https://github.com/bash0816/Magi-Server/issues/50" });
        },
        githubToken: "gh-token",
        failureMessage: "detect failed",
        failedProviders: ["openai", "gemini"],
      });

      assert.equal(result.action, "created");
      assert.equal(result.issueNumber, 50);
      // Issue 作成時のリクエストボディに failedProviders が含まれていることを確認
      const createCall = calls.find((c) => c.url.endsWith("/issues") && c.init.method === "POST");
      assert.ok(createCall, "Issue 作成リクエストが必要");
      const createBody = JSON.parse(createCall.init.body);
      assert.ok(
        createBody.body.includes("openai") && createBody.body.includes("gemini"),
        "failedProviders (openai, gemini) が本文に含まれるべき"
      );
    });

    it("failedProviders が未指定の場合でも動作すること（既存の挙動を維持）", async () => {
      const mod = await loadScript();
      const calls = [];

      const result = await mod.reportModelNewWatchFailure({
        fetchFn: async (url, init) => {
          calls.push({ url, init });
          if (calls.length === 1) {
            return makeResponse(200, []);
          }
          const body = JSON.parse(init.body);
          assert.equal(body.title, "[model-new-watch] 実行失敗");
          // failedProviders がなくても failure message だけで動作する
          assert.ok(body.body.includes("モデル新規検知処理が失敗しました"));
          return makeResponse(201, { number: 51, html_url: "https://github.com/bash0816/Magi-Server/issues/51" });
        },
        githubToken: "gh-token",
        failureMessage: "detect failed",
        // failedProviders は指定しない
      });

      assert.equal(result.action, "created");
      assert.equal(result.issueNumber, 51);
    });

    it("failedProviders が空配列の場合でも動作すること", async () => {
      const mod = await loadScript();
      const calls = [];

      const result = await mod.reportModelNewWatchFailure({
        fetchFn: async (url, init) => {
          calls.push({ url, init });
          if (calls.length === 1) {
            return makeResponse(200, []);
          }
          return makeResponse(201, { number: 52, html_url: "https://github.com/bash0816/Magi-Server/issues/52" });
        },
        githubToken: "gh-token",
        failureMessage: "some error",
        failedProviders: [],
      });

      assert.equal(result.action, "created");
      assert.equal(result.issueNumber, 52);
    });

    it("failedProviders が複数ある場合、すべてが Issue 本文に含まれること", async () => {
      const mod = await loadScript();
      const calls = [];
      const providers = ["openai", "gemini", "claude", "__orchestrator_init__"];

      const result = await mod.reportModelNewWatchFailure({
        fetchFn: async (url, init) => {
          calls.push({ url, init });
          if (calls.length === 1) {
            return makeResponse(200, []);
          }
          const body = JSON.parse(init.body);
          // すべての failedProviders が本文に含まれることを検証
          for (const provider of providers) {
            assert.ok(body.body.includes(provider), `failedProviders に "${provider}" が含まれるべき`);
          }
          return makeResponse(201, { number: 53, html_url: "https://github.com/bash0816/Magi-Server/issues/53" });
        },
        githubToken: "gh-token",
        failureMessage: "multiple failures",
        failedProviders: providers,
      });

      assert.equal(result.action, "created");
      assert.equal(result.issueNumber, 53);
    });

    it("既存コメント追記時にも failedProviders が含まれること", async () => {
      const mod = await loadScript();
      const calls = [];

      const result = await mod.reportModelNewWatchFailure({
        fetchFn: async (url, init) => {
          calls.push({ url, init });
          if (calls.length === 1) {
            // 既存 Issue を返す
            return makeResponse(200, [
              {
                number: 99,
                title: "[model-new-watch] 実行失敗",
                state: "open",
                pull_request: undefined,
                user: { login: "github-actions[bot]" },
              },
            ]);
          }
          // コメント追記時
          const body = JSON.parse(init.body);
          assert.ok(
            body.body.includes("gemini"),
            "failedProviders (gemini) がコメント本文に含まれるべき"
          );
          return makeResponse(201, { id: 999 });
        },
        githubToken: "gh-token",
        failureMessage: "partial failure",
        failedProviders: ["gemini"],
      });

      assert.equal(result.action, "commented");
      assert.equal(result.issueNumber, 99);
    });
  });
});
