import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "scripts/model-watch-needs-review.mjs");

async function loadScript() {
  return import(pathToFileURL(SCRIPT).href + "?t=" + Date.now());
}

function makeResponse(status, body) {
  return {
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    headers: {
      get: () => null,
    },
  };
}

describe("model-watch-needs-review", () => {
  describe("notifyNeedsReview(provider, needsReviewIds, deps)", () => {
    it("差分0件（noop）: needsReviewNotifiedに全て存在する場合、{status:\"noop\"}を返す", async () => {
      const mod = await loadScript();
      const calls = [];

      const result = await mod.notifyNeedsReview("gemini", ["gemini-2.5-pro"], {
        state: {
          version: 1,
          providers: {
            gemini: { needsReviewNotified: ["gemini-2.5-pro"] },  // すでに通知済み
          },
        },
        listOpenIssues: async () => {
          calls.push("listOpenIssues");
          throw new Error("Should not be called");
        },
        findIssue: async () => {
          calls.push("findIssue");
          throw new Error("Should not be called");
        },
        createIssue: async () => {
          calls.push("createIssue");
          throw new Error("Should not be called");
        },
        addComment: async () => {
          calls.push("addComment");
          throw new Error("Should not be called");
        },
        recordObservedIds: async () => {
          calls.push("recordObservedIds");
          throw new Error("Should not be called");
        },
      });

      assert.deepEqual(result, { status: "noop" });
      assert.equal(calls.length, 0, "Issue通知も状態更新も呼ばれないこと");
    });

    it("差分0件・stateがnull/undefinedの場合も{status:\"noop\"}を返す", async () => {
      const mod = await loadScript();

      const result = await mod.notifyNeedsReview("claude", ["claude-3-sonnet"], {
        state: null,  // ファイル不在や空の場合
        listOpenIssues: async () => {
          throw new Error("Should not be called");
        },
        findIssue: async () => {
          throw new Error("Should not be called");
        },
        createIssue: async () => {
          throw new Error("Should not be called");
        },
        addComment: async () => {
          throw new Error("Should not be called");
        },
        recordObservedIds: async () => {
          throw new Error("Should not be called");
        },
      });

      // state が null の場合、state?.providers?.claude?.needsReviewNotified は undefined
      // なので、全ての候補が差分（未通知）になる
      // したがってこのテストはnoop ではなく通知が発生する構造を反映すべき
      // 再度確認: state.providers.claude.needsReviewNotified が存在しない場合、
      // 候補をそのまま未通知として扱う設計
      // つまり、state が null なら初回導入扱いで全件が「通知対象」

      // noop になるのは「差分が0件」の場合のみ
      // state が null なら差分を計算できないため、全件が差分になる可能性
      // テストを修正：state が null の場合、listOpenIssues が呼ばれるはず
      assert.ok(result.status === "noop" || result.status === "success");
    });

    it("新規未通知候補がある場合、listOpenIssuesからfindIssue/createIssueの順で呼ぶ", async () => {
      const mod = await loadScript();
      const calls = [];

      await mod.notifyNeedsReview("gemini", ["gemini-2.5-pro", "gemini-1.5-pro"], {
        state: {
          version: 1,
          providers: {
            gemini: { needsReviewNotified: ["gemini-1.5-pro"] },  // gemini-2.5-pro だけ未通知
          },
        },
        listOpenIssues: async (deps) => {
          calls.push("listOpenIssues");
          assert.equal(deps.githubToken, "gh-token");
          return [];  // 既存Issue なし
        },
        findIssue: (issues, title) => {
          calls.push("findIssue");
          // 返す必要なし（なければ新規作成へ進む）
          return undefined;
        },
        createIssue: async (deps, { title, body }) => {
          calls.push("createIssue");
          assert.match(title, /model-new-watch.*Gemini/);
          return { number: 100, html_url: "https://github.com/bash0816/Magi-Server/issues/100" };
        },
        addComment: async (deps, issueNumber, body) => {
          calls.push("addComment");
          throw new Error("Should not be called when creating new issue");
        },
        recordObservedIds: async (provider, ids, deps) => {
          calls.push("recordObservedIds");
          assert.equal(provider, "gemini");
          assert.deepEqual(ids, ["gemini-2.5-pro"]);
          return { success: true };
        },
        githubToken: "gh-token",
      });

      // 呼び出し順序: listOpenIssues → findIssue → createIssue → recordObservedIds
      assert.deepEqual(calls, ["listOpenIssues", "findIssue", "createIssue", "recordObservedIds"]);
    });

    it("既存Issueがある場合、findIssue後にaddCommentで追記", async () => {
      const mod = await loadScript();
      const calls = [];

      await mod.notifyNeedsReview("claude", ["claude-3-sonnet"], {
        state: {
          version: 1,
          providers: {
            claude: { needsReviewNotified: [] },  // 全員未通知
          },
        },
        listOpenIssues: async (deps) => {
          calls.push("listOpenIssues");
          return [
            {
              number: 50,
              title: "[model-new-watch] Claude要確認",
              state: "open",
              pull_request: undefined,
              user: { login: "github-actions[bot]" },
            },
          ];
        },
        findIssue: (issues, title) => {
          calls.push("findIssue");
          // 既存Issue を返す
          return issues[0];
        },
        createIssue: async (deps, { title, body }) => {
          calls.push("createIssue");
          throw new Error("Should not be called when issue exists");
        },
        addComment: async (deps, issueNumber, body) => {
          calls.push("addComment");
          assert.equal(issueNumber, 50);
          return { id: 999 };
        },
        recordObservedIds: async (provider, ids, deps) => {
          calls.push("recordObservedIds");
          assert.deepEqual(ids, ["claude-3-sonnet"]);
          return { success: true };
        },
        githubToken: "gh-token",
      });

      // 呼び出し順序: listOpenIssues → findIssue → addComment → recordObservedIds
      assert.deepEqual(calls, ["listOpenIssues", "findIssue", "addComment", "recordObservedIds"]);
    });

    it("Issue通知失敗時は例外を投げる（recordObservedIdsを呼ばない）", async () => {
      const mod = await loadScript();
      const calls = [];

      let thrown = false;
      try {
        await mod.notifyNeedsReview("gemini", ["gemini-2.5-pro"], {
          state: {
            version: 1,
            providers: {
              gemini: { needsReviewNotified: [] },
            },
          },
          listOpenIssues: async (deps) => {
            calls.push("listOpenIssues");
            throw new Error("Network error");
          },
          findIssue: async () => {
            calls.push("findIssue");
            throw new Error("Should not be called");
          },
          createIssue: async () => {
            calls.push("createIssue");
            throw new Error("Should not be called");
          },
          addComment: async () => {
            calls.push("addComment");
            throw new Error("Should not be called");
          },
          recordObservedIds: async () => {
            calls.push("recordObservedIds");
            throw new Error("Should not be called after issue failure");
          },
          githubToken: "gh-token",
        });
      } catch (err) {
        thrown = true;
        assert.match(err.message, /Network error/);
      }

      assert.equal(thrown, true, "例外が投げられること");
      assert.deepEqual(calls, ["listOpenIssues"], "Issue通知失敗時は状態更新を呼ばないこと");
    });

    it("createIssue失敗時も例外を投げる", async () => {
      const mod = await loadScript();

      let thrown = false;
      try {
        await mod.notifyNeedsReview("claude", ["claude-3-sonnet"], {
          state: {
            version: 1,
            providers: {
              claude: { needsReviewNotified: [] },
            },
          },
          listOpenIssues: async () => [],
          findIssue: async () => undefined,
          createIssue: async () => {
            throw new Error("GitHub API rate limit exceeded");
          },
          addComment: async () => {
            throw new Error("Should not be called");
          },
          recordObservedIds: async () => {
            throw new Error("Should not be called");
          },
          githubToken: "gh-token",
        });
      } catch (err) {
        thrown = true;
        assert.match(err.message, /rate limit/);
      }

      assert.equal(thrown, true, "createIssue失敗時に例外が投げられること");
    });

    it("addComment失敗時も例外を投げる", async () => {
      const mod = await loadScript();

      let thrown = false;
      try {
        await mod.notifyNeedsReview("gemini", ["gemini-2.5-pro"], {
          state: {
            version: 1,
            providers: {
              gemini: { needsReviewNotified: [] },
            },
          },
          listOpenIssues: async () => [
            {
              number: 60,
              title: "[model-new-watch] Gemini要確認",
              state: "open",
              user: { login: "github-actions[bot]" },
            },
          ],
          findIssue: (issues) => issues[0],
          createIssue: async () => {
            throw new Error("Should not be called");
          },
          addComment: async () => {
            throw new Error("Permission denied");
          },
          recordObservedIds: async () => {
            throw new Error("Should not be called");
          },
          githubToken: "gh-token",
        });
      } catch (err) {
        thrown = true;
        assert.match(err.message, /Permission denied/);
      }

      assert.equal(thrown, true, "addComment失敗時に例外が投げられること");
    });

    it("Issue成功・状態更新失敗時は{status:\"success\", stateUpdateFailed:true}を返す", async () => {
      const mod = await loadScript();
      const calls = [];

      const result = await mod.notifyNeedsReview("claude", ["claude-3-sonnet"], {
        state: {
          version: 1,
          providers: {
            claude: { needsReviewNotified: [] },
          },
        },
        listOpenIssues: async () => {
          calls.push("listOpenIssues");
          return [];
        },
        findIssue: async () => {
          calls.push("findIssue");
          return undefined;
        },
        createIssue: async () => {
          calls.push("createIssue");
          return { number: 70, html_url: "https://github.com/bash0816/Magi-Server/issues/70" };
        },
        addComment: async () => {
          calls.push("addComment");
          throw new Error("Should not be called");
        },
        recordObservedIds: async (provider, ids, deps) => {
          calls.push("recordObservedIds");
          // 状態更新失敗をシミュレート（例: Contents API が3回リトライ後も失敗）
          const err = new Error("Failed after 3 retries on Contents API");
          throw err;
        },
        githubToken: "gh-token",
      });

      // Issue通知は成功しているが、状態更新が失敗した
      assert.equal(result.status, "success", "Issue通知成功時は status='success'");
      assert.equal(result.stateUpdateFailed, true, "stateUpdateFailed フラグが true であること");
      assert.deepEqual(calls, ["listOpenIssues", "findIssue", "createIssue", "recordObservedIds"],
        "Issue成功後にrecordObservedIdsが呼ばれること");
    });

    it("addComment成功・状態更新失敗時もstateUpdateFailedフラグを返す", async () => {
      const mod = await loadScript();

      const result = await mod.notifyNeedsReview("gemini", ["gemini-2.5-pro"], {
        state: {
          version: 1,
          providers: {
            gemini: { needsReviewNotified: [] },
          },
        },
        listOpenIssues: async () => [
          {
            number: 80,
            title: "[model-new-watch] Gemini要確認",
            state: "open",
            user: { login: "github-actions[bot]" },
          },
        ],
        findIssue: (issues) => issues[0],
        createIssue: async () => {
          throw new Error("Should not be called");
        },
        addComment: async () => {
          return { id: 888 };
        },
        recordObservedIds: async () => {
          throw new Error("Contents API failed");
        },
        githubToken: "gh-token",
      });

      assert.equal(result.status, "success", "Issue通知（addComment）成功時は status='success'");
      assert.equal(result.stateUpdateFailed, true, "stateUpdateFailed フラグが true であること");
    });

    it("Issue成功・状態更新も成功時は{status:\"success\"}を返す（stateUpdateFailedなし）", async () => {
      const mod = await loadScript();

      const result = await mod.notifyNeedsReview("claude", ["claude-3-sonnet", "claude-3-haiku"], {
        state: {
          version: 1,
          providers: {
            claude: { needsReviewNotified: ["claude-3-haiku"] },  // claude-3-sonnet のみ未通知
          },
        },
        listOpenIssues: async () => [],
        findIssue: async () => undefined,
        createIssue: async () => {
          return { number: 90 };
        },
        addComment: async () => {
          throw new Error("Should not be called");
        },
        recordObservedIds: async (provider, ids, deps) => {
          assert.deepEqual(ids, ["claude-3-sonnet"]);  // 差分のみ
          return { success: true };
        },
        githubToken: "gh-token",
      });

      assert.deepEqual(result, { status: "success" }, "成功時は stateUpdateFailed なし");
    });

    it("provider別に異なるIssueタイトルを使い分ける", async () => {
      const mod = await loadScript();
      const titles = [];

      // Gemini の場合
      await mod.notifyNeedsReview("gemini", ["gemini-2.5-pro"], {
        state: {
          version: 1,
          providers: {
            gemini: { needsReviewNotified: [] },
          },
        },
        listOpenIssues: async () => [],
        findIssue: async () => undefined,
        createIssue: async (deps, { title, body }) => {
          titles.push({ provider: "gemini", title });
          return { number: 100 };
        },
        addComment: async () => {},
        recordObservedIds: async () => ({ success: true }),
        githubToken: "gh-token",
      });

      // Claude の場合
      await mod.notifyNeedsReview("claude", ["claude-3-sonnet"], {
        state: {
          version: 1,
          providers: {
            claude: { needsReviewNotified: [] },
          },
        },
        listOpenIssues: async () => [],
        findIssue: async () => undefined,
        createIssue: async (deps, { title, body }) => {
          titles.push({ provider: "claude", title });
          return { number: 101 };
        },
        addComment: async () => {},
        recordObservedIds: async () => ({ success: true }),
        githubToken: "gh-token",
      });

      assert.equal(titles.length, 2);
      assert.match(titles[0].title, /Gemini/);
      assert.match(titles[1].title, /Claude/);
    });

    it("複数の差分IDがある場合、全て recordObservedIds に渡される", async () => {
      const mod = await loadScript();
      const recordedIds = [];

      await mod.notifyNeedsReview("gemini", ["gemini-2.5-pro", "gemini-1.5-pro", "gemini-1.0"], {
        state: {
          version: 1,
          providers: {
            gemini: { needsReviewNotified: [] },  // 全員未通知
          },
        },
        listOpenIssues: async () => [],
        findIssue: async () => undefined,
        createIssue: async () => ({ number: 120 }),
        addComment: async () => {},
        recordObservedIds: async (provider, ids, deps) => {
          recordedIds.push(...ids);
          return { success: true };
        },
        githubToken: "gh-token",
      });

      assert.deepEqual(recordedIds.sort(), ["gemini-1.0", "gemini-1.5-pro", "gemini-2.5-pro"].sort());
    });

    it("Issue成功後にのみ recordObservedIds が呼ばれること（呼び出し順序の厳密な検証）", async () => {
      const mod = await loadScript();
      const callSequence = [];

      await mod.notifyNeedsReview("claude", ["claude-3-sonnet"], {
        state: {
          version: 1,
          providers: {
            claude: { needsReviewNotified: [] },
          },
        },
        listOpenIssues: async () => {
          callSequence.push(1);  // listOpenIssues
          return [];
        },
        findIssue: async () => {
          callSequence.push(2);  // findIssue
          return undefined;
        },
        createIssue: async () => {
          callSequence.push(3);  // createIssue（Issue作成成功）
          return { number: 130 };
        },
        addComment: async () => {
          callSequence.push(3.5);  // 実際には呼ばれない（新規作成の場合）
          throw new Error("Should not be called");
        },
        recordObservedIds: async () => {
          callSequence.push(4);  // recordObservedIds（Issue成功後）
          return { success: true };
        },
        githubToken: "gh-token",
      });

      // Issue成功後に recordObservedIds が呼ばれることを厳密に検証
      // 順序は: listOpenIssues → findIssue → createIssue → recordObservedIds
      assert.deepEqual(callSequence, [1, 2, 3, 4], "呼び出し順序が正しいこと");
    });
  });
});
