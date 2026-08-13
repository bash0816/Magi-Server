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
});
