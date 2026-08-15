import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "scripts/sync-models-json-health-check.mjs");

async function loadScript() {
  return import(pathToFileURL(SCRIPT).href + "?t=" + Date.now());
}

function makeResponse(status, body) {
  return {
    status,
    json: async () => body,
  };
}

describe("sync-models-json-health-check", () => {
  it("Issue API URLが bash0816/Magi-Server 宛に固定されていることを検証", async () => {
    const mod = await loadScript();
    const calls = [];

    const result = await mod.reportSyncFailure({
      fetchFn: async (url, init) => {
        calls.push({ url, init });
        // Issue検索時にMagi-Serverリポジトリを参照していることを検証
        if (calls.length === 1) {
          assert.equal(url, "https://api.github.com/repos/bash0816/Magi-Server/issues?state=open&per_page=100");
          return makeResponse(200, []);
        }
        // Issue作成時もMagi-Serverリポジトリを参照していることを検証
        assert.equal(url, "https://api.github.com/repos/bash0816/Magi-Server/issues");
        return makeResponse(201, { number: 42, html_url: "https://github.com/bash0816/Magi-Server/issues/42" });
      },
      githubToken: "gh-token",
      failureMessage: "network down",
    });

    assert.equal(result.action, "created");
    assert.equal(result.issueNumber, 42);
    assert.equal(calls.length, 2);
  });

  it("失敗時、既存issueなし→新規作成", async () => {
    const mod = await loadScript();
    const calls = [];

    const result = await mod.reportSyncFailure({
      fetchFn: async (url, init) => {
        calls.push({ url, init });
        if (calls.length === 1) {
          assert.equal(url, "https://api.github.com/repos/bash0816/Magi-Server/issues?state=open&per_page=100");
          assert.equal(init.method, "GET");
          return makeResponse(200, []);
        }
        assert.equal(init.method, "POST");
        assert.equal(url, "https://api.github.com/repos/bash0816/Magi-Server/issues");
        const body = JSON.parse(init.body);
        assert.equal(body.title, "[sync-models-json] 実行失敗");
        assert.match(body.body, /同期処理が失敗しました/);
        assert.match(body.body, /network down/);
        return makeResponse(201, { number: 42, html_url: "https://github.com/bash0816/Magi-Server/issues/42" });
      },
      githubToken: "gh-token",
      failureMessage: "network down",
    });

    assert.equal(result.action, "created");
    assert.equal(result.issueNumber, 42);
    assert.equal(calls.length, 2);
  });

  it("失敗時、既存issueあり（github-actions[bot]作成）→コメント追記", async () => {
    const mod = await loadScript();
    const calls = [];

    const result = await mod.reportSyncFailure({
      fetchFn: async (url, init) => {
        calls.push({ url, init });
        if (calls.length === 1) {
          return makeResponse(200, [
            {
              number: 7,
              title: "[sync-models-json] 実行失敗",
              state: "open",
              pull_request: undefined,  // Issueなので pull_request フィールドなし
              user: { login: "github-actions[bot]" },  // github-actions[bot]作成
            },
          ]);
        }
        assert.equal(init.method, "POST");
        assert.equal(url, "https://api.github.com/repos/bash0816/Magi-Server/issues/7/comments");
        const body = JSON.parse(init.body);
        assert.match(body.body, /timeout/);
        return makeResponse(201, { id: 99 });
      },
      githubToken: "gh-token",
      failureMessage: "timeout",
    });

    assert.equal(result.action, "commented");
    assert.equal(result.issueNumber, 7);
    assert.equal(calls.length, 2);
    assert.equal(calls.some((call) => call.url.endsWith("/issues") && call.init.method === "POST"), false);
  });

  it("外部者作成Issueは候補から除外され、新規Issueが作成される", async () => {
    const mod = await loadScript();
    const calls = [];

    const result = await mod.reportSyncFailure({
      fetchFn: async (url, init) => {
        calls.push({ url, init });
        if (calls.length === 1) {
          // 外部者（github-actions[bot]以外）が作成したIssueを返す
          return makeResponse(200, [
            {
              number: 8,
              title: "[sync-models-json] 実行失敗",
              state: "open",
              pull_request: undefined,
              user: { login: "external-user" },  // 外部者作成
            },
          ]);
        }
        // 外部者のIssueを再利用せず、新規Issueを作成する必要があるため
        assert.equal(init.method, "POST");
        assert.equal(url, "https://api.github.com/repos/bash0816/Magi-Server/issues");
        return makeResponse(201, { number: 9, html_url: "https://github.com/bash0816/Magi-Server/issues/9" });
      },
      githubToken: "gh-token",
      failureMessage: "external failure",
    });

    assert.equal(result.action, "created");
    assert.equal(result.issueNumber, 9);
    assert.equal(calls.length, 2);
  });

  it("PR（pull_request フィールド有り）は候補から除外される", async () => {
    const mod = await loadScript();
    const calls = [];

    const result = await mod.reportSyncFailure({
      fetchFn: async (url, init) => {
        calls.push({ url, init });
        if (calls.length === 1) {
          // PR（pull_request フィールドが存在）を返す
          return makeResponse(200, [
            {
              number: 10,
              title: "[sync-models-json] 実行失敗",
              state: "open",
              pull_request: { html_url: "https://github.com/bash0816/Magi-Server/pull/10" },  // これはPR
              user: { login: "github-actions[bot]" },
            },
          ]);
        }
        // PRを再利用せず、新規Issueを作成する必要があるため
        assert.equal(init.method, "POST");
        assert.equal(url, "https://api.github.com/repos/bash0816/Magi-Server/issues");
        return makeResponse(201, { number: 11, html_url: "https://github.com/bash0816/Magi-Server/issues/11" });
      },
      githubToken: "gh-token",
      failureMessage: "pr found",
    });

    assert.equal(result.action, "created");
    assert.equal(result.issueNumber, 11);
    assert.equal(calls.length, 2);
  });

  it("成功時、既存open Issueあり（github-actions[bot]作成）→クローズ", async () => {
    const mod = await loadScript();
    const calls = [];

    const result = await mod.reportSyncSuccess({
      fetchFn: async (url, init) => {
        calls.push({ url, init });
        if (calls.length === 1) {
          return makeResponse(200, [
            {
              number: 9,
              title: "[sync-models-json] 実行失敗",
              state: "open",
              pull_request: undefined,
              user: { login: "github-actions[bot]" },
            },
          ]);
        }
        assert.equal(init.method, "PATCH");
        assert.equal(url, "https://api.github.com/repos/bash0816/Magi-Server/issues/9");
        const body = JSON.parse(init.body);
        assert.equal(body.state, "closed");
        return makeResponse(200, { number: 9, state: "closed" });
      },
      githubToken: "gh-token",
    });

    assert.equal(result.action, "closed");
    assert.equal(result.issueNumber, 9);
    assert.equal(calls.length, 2);
  });

  it("成功時、既存issueなし→何もしない(API呼び出しなし)", async () => {
    const mod = await loadScript();
    let called = false;

    const result = await mod.reportSyncSuccess({
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

  describe("Export確認テスト", () => {
    it("listOpenIssuesがexportされていること", async () => {
      const mod = await loadScript();
      assert.equal(typeof mod.listOpenIssues, "function", "listOpenIssuesはexportされるべき");
    });

    it("findIssueがexportされていること", async () => {
      const mod = await loadScript();
      assert.equal(typeof mod.findIssue, "function", "findIssueはexportされるべき");
    });

    it("createIssueがexportされていること", async () => {
      const mod = await loadScript();
      assert.equal(typeof mod.createIssue, "function", "createIssueはexportされるべき");
    });

    it("addCommentがexportされていること", async () => {
      const mod = await loadScript();
      assert.equal(typeof mod.addComment, "function", "addCommentはexportされるべき");
    });

    it("closeIssueがexportされていること", async () => {
      const mod = await loadScript();
      assert.equal(typeof mod.closeIssue, "function", "closeIssueはexportされるべき");
    });
  });

  describe("fetchFn未指定時のデフォルト解決（実運用でのバグを踏まえた回帰テスト）", () => {
    // listOpenIssues/createIssue/addComment/closeIssueにfetchFn = globalThis.fetchの
    // デフォルト値が抜けていたため、model-new-watch.mjs(単一オーケストレーター)から
    // 引数を明示せずに呼び出す実運用経路(node scripts/model-new-watch.mjs、main()を
    // 引数なしで起動)で「fetchFn が必要です」により必ず失敗していた
    // (2026-08-15、T5実機検証で発覚)。globalThis.fetchを一時的に差し替えて、
    // fetchFnを渡さなくても呼び出せることを検証する
    it("listOpenIssuesはfetchFnを渡さなくてもglobalThis.fetchへフォールバックすること", async () => {
      const mod = await loadScript();
      const originalFetch = globalThis.fetch;
      const calls = [];
      globalThis.fetch = async (url, init) => {
        calls.push({ url, init });
        return makeResponse(200, []);
      };
      try {
        const result = await mod.listOpenIssues({ githubToken: "gh-token" });
        assert.deepEqual(result, []);
        assert.equal(calls.length, 1, "globalThis.fetchが呼ばれること");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("createIssue/addComment/closeIssueもfetchFnを渡さなくてもglobalThis.fetchへフォールバックすること", async () => {
      const mod = await loadScript();
      const originalFetch = globalThis.fetch;
      const calls = [];
      globalThis.fetch = async (url, init) => {
        calls.push({ url, init });
        if (init.method === "POST" && url.endsWith("/issues")) {
          return makeResponse(201, { number: 1 });
        }
        if (init.method === "POST") {
          return makeResponse(201, { id: 1 });
        }
        return makeResponse(200, { number: 1, state: "closed" });
      };
      try {
        await mod.createIssue({ githubToken: "gh-token" }, { title: "t", body: "b" });
        await mod.addComment({ githubToken: "gh-token" }, 1, "comment");
        await mod.closeIssue({ githubToken: "gh-token" }, 1);
        assert.equal(calls.length, 3, "3関数ともglobalThis.fetchが呼ばれること");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("ページネーション対応", () => {
    it("listOpenIssuesがページネーション対応していること（Link: rel=nextを追跡）", async () => {
      const mod = await loadScript();
      const calls = [];

      const result = await mod.listOpenIssues({
        fetchFn: async (url, init) => {
          calls.push({ url, init });
          if (calls.length === 1) {
            // 最初のページ：Link ヘッダーで次ページを指示
            const response = makeResponse(200, [
              { number: 1, title: "Issue 1", state: "open", pull_request: undefined, user: { login: "github-actions[bot]" } },
              { number: 2, title: "Issue 2", state: "open", pull_request: undefined, user: { login: "github-actions[bot]" } },
            ]);
            // response.headers を模擬（Link ヘッダー）
            response.headers = {
              get: (name) => {
                if (name.toLowerCase() === "link") {
                  return '<https://api.github.com/repos/bash0816/Magi-Server/issues?state=open&per_page=100&page=2>; rel="next", <https://api.github.com/repos/bash0816/Magi-Server/issues?state=open&per_page=100&page=1>; rel="last"';
                }
                return null;
              },
            };
            return response;
          }
          if (calls.length === 2) {
            // 2ページ目：Link ヘッダーなし（最後のページ）
            const response = makeResponse(200, [
              { number: 3, title: "Issue 3", state: "open", pull_request: undefined, user: { login: "github-actions[bot]" } },
            ]);
            response.headers = { get: () => null };
            return response;
          }
          throw new Error("Unexpected fetch call");
        },
        githubToken: "gh-token",
      });

      // 両ページのIssueがマージされたことを検証
      assert.equal(result.length, 3, "2ページ分のIssueが統合されるべき");
      assert.equal(result[0].number, 1);
      assert.equal(result[1].number, 2);
      assert.equal(result[2].number, 3);
      assert.equal(calls.length, 2, "ページネーションで2回の呼び出しが発生するべき");
    });

    it("listOpenIssuesがLink ヘッダーなし（単一ページ）でも正常に動作すること", async () => {
      const mod = await loadScript();
      const calls = [];

      const result = await mod.listOpenIssues({
        fetchFn: async (url, init) => {
          calls.push({ url, init });
          const response = makeResponse(200, [
            { number: 1, title: "Issue 1", state: "open", pull_request: undefined, user: { login: "github-actions[bot]" } },
          ]);
          response.headers = { get: () => null };
          return response;
        },
        githubToken: "gh-token",
      });

      assert.equal(result.length, 1);
      assert.equal(result[0].number, 1);
      assert.equal(calls.length, 1, "リンクがない場合は1回の呼び出しのみ");
    });
  });

  describe("既存関数の挙動確認（変更なし）", () => {
    it("reportSyncFailureが既存の挙動を保つこと", async () => {
      const mod = await loadScript();
      const calls = [];

      const result = await mod.reportSyncFailure({
        fetchFn: async (url, init) => {
          calls.push({ url, init });
          if (calls.length === 1) {
            return makeResponse(200, []);
          }
          const body = JSON.parse(init.body);
          assert.equal(body.title, "[sync-models-json] 実行失敗");
          return makeResponse(201, { number: 100, html_url: "https://github.com/bash0816/Magi-Server/issues/100" });
        },
        githubToken: "gh-token",
        failureMessage: "test failure",
      });

      assert.equal(result.action, "created");
      assert.equal(result.issueNumber, 100);
    });

    it("reportSyncSuccessが既存の挙動を保つこと", async () => {
      const mod = await loadScript();
      const calls = [];

      const result = await mod.reportSyncSuccess({
        fetchFn: async (url, init) => {
          calls.push({ url, init });
          if (calls.length === 1) {
            return makeResponse(200, [
              {
                number: 99,
                title: "[sync-models-json] 実行失敗",
                state: "open",
                pull_request: undefined,
                user: { login: "github-actions[bot]" },
              },
            ]);
          }
          assert.equal(init.method, "PATCH");
          return makeResponse(200, { number: 99, state: "closed" });
        },
        githubToken: "gh-token",
      });

      assert.equal(result.action, "closed");
      assert.equal(result.issueNumber, 99);
    });
  });
});
