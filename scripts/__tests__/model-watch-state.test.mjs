import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "scripts/model-watch-state.mjs");

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

function toBase64Json(value) {
  return Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8").toString("base64");
}

function decodeBase64(value) {
  return Buffer.from(String(value), "base64").toString("utf8");
}

describe("model-watch-state (Magi-Server)", () => {
  describe("readState(deps)", () => {
    it("404（ファイル不在）の場合、{}を返すこと", async () => {
      const mod = await loadScript();
      const calls = [];

      const result = await mod.readState({
        fetchFn: async (url, init = {}) => {
          calls.push({ url, init });
          // ファイル不在を示す404
          assert.equal(init.method, "GET");
          return makeResponse(404, { message: "Not Found" });
        },
        env: { GITHUB_TOKEN: "gh-token" },
      });

      assert.deepEqual(result, {});
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /contents\/data\/model-watch-state\.json/);
    });

    it("200でファイルが存在する場合、JSONをパースして返すこと", async () => {
      const mod = await loadScript();
      const stateContent = {
        version: 1,
        providers: {
          openai: { observedIds: ["gpt-4", "gpt-3.5"] },
          gemini: { needsReviewNotified: ["gemini-pro"] },
          claude: { needsReviewNotified: [] },
        },
      };

      const result = await mod.readState({
        fetchFn: async (url, init = {}) => {
          assert.equal(init.method, "GET");
          return makeResponse(200, {
            sha: "abc123",
            content: toBase64Json(stateContent),
          });
        },
        env: { GITHUB_TOKEN: "gh-token" },
      });

      assert.deepEqual(result, stateContent);
    });

    it("ファイルが存在しない場合（404）、state?.providers?.openai?.observedIdsは未定義になること", async () => {
      const mod = await loadScript();

      const result = await mod.readState({
        fetchFn: async () => makeResponse(404, {}),
        env: { GITHUB_TOKEN: "gh-token" },
      });

      assert.equal(result?.providers?.openai?.observedIds, undefined);
    });
  });

  describe("recordObservedIds(provider, ids, deps)", () => {
    it("404（初回）の場合、新規ファイルを作成して初回ベースラインを記録すること", async () => {
      const mod = await loadScript();
      const calls = [];
      const newIds = ["gpt-4-turbo", "gpt-4"];

      const result = await mod.recordObservedIds("openai", newIds, {
        fetchFn: async (url, init = {}) => {
          calls.push({ url, init });

          // 1. GET で SHA 取得（404 = ファイル不在）
          if (calls.length === 1) {
            assert.equal(init.method, "GET");
            return makeResponse(404, {});
          }

          // 2. PUT で新規作成
          if (calls.length === 2) {
            assert.equal(init.method, "PUT");
            const body = JSON.parse(init.body);
            const content = JSON.parse(decodeBase64(body.content));
            assert.equal(body.branch, "main");
            assert.equal(body.sha, undefined, "404の場合、shaを指定しない");
            assert.deepEqual(content.providers.openai.observedIds, newIds);
            return makeResponse(200, { commit: { sha: "new-sha" } });
          }

          throw new Error(`unexpected fetch call #${calls.length}: ${url}`);
        },
        env: { GITHUB_TOKEN: "gh-token" },
      });

      assert.equal(calls.length, 2);
      assert.equal(result.success, true);
    });

    it("冪等マージ: 同一IDの二重マージは冪等であること", async () => {
      const mod = await loadScript();
      const calls = [];
      const existingState = {
        version: 1,
        providers: {
          openai: { observedIds: ["gpt-4"] },
          gemini: { needsReviewNotified: [] },
          claude: { needsReviewNotified: [] },
        },
      };
      const newIds = ["gpt-4"]; // 既に存在する ID

      await mod.recordObservedIds("openai", newIds, {
        fetchFn: async (url, init = {}) => {
          calls.push({ url, init });

          // 1. GET で既存状態を取得
          if (calls.length === 1) {
            return makeResponse(200, {
              sha: "existing-sha",
              content: toBase64Json(existingState),
            });
          }

          // 2. PUT でマージ
          if (calls.length === 2) {
            const body = JSON.parse(init.body);
            const merged = JSON.parse(decodeBase64(body.content));
            // 既存の ["gpt-4"] に ["gpt-4"] を追加しても重複なし（Set和集合）
            assert.deepEqual(merged.providers.openai.observedIds, ["gpt-4"]);
            return makeResponse(200, { commit: { sha: "merged-sha" } });
          }

          throw new Error(`unexpected call #${calls.length}`);
        },
        env: { GITHUB_TOKEN: "gh-token" },
      });

      assert.equal(calls.length, 2);
    });

    it("409/422（競合）時、最大3回まで再試行すること", async () => {
      const mod = await loadScript();
      const calls = [];
      const retryIds = ["gpt-4-turbo"];
      let retryCount = 0;

      const result = await mod.recordObservedIds("openai", retryIds, {
        fetchFn: async (url, init = {}) => {
          calls.push({ url, init });

          // 1. 最初の GET
          if (calls.length === 1) {
            return makeResponse(200, {
              sha: "sha-v1",
              content: toBase64Json({
                version: 1,
                providers: {
                  openai: { observedIds: [] },
                  gemini: { needsReviewNotified: [] },
                  claude: { needsReviewNotified: [] },
                },
              }),
            });
          }

          // 2. 最初の PUT → 409 競合
          if (calls.length === 2) {
            assert.equal(init.method, "PUT");
            return makeResponse(409, { message: "Conflict" });
          }

          // 3. 再試行 1 回目: GET で新しい SHA を取得
          if (calls.length === 3) {
            assert.equal(init.method, "GET");
            retryCount = 1;
            return makeResponse(200, {
              sha: "sha-v2",
              content: toBase64Json({
                version: 1,
                providers: {
                  openai: { observedIds: ["gpt-4"] }, // 他の操作で更新されている
                  gemini: { needsReviewNotified: [] },
                  claude: { needsReviewNotified: [] },
                },
              }),
            });
          }

          // 4. 再試行 1 回目: PUT → 409 再び競合
          if (calls.length === 4) {
            assert.equal(init.method, "PUT");
            return makeResponse(409, { message: "Conflict" });
          }

          // 5. 再試行 2 回目: GET で最新の SHA を取得
          if (calls.length === 5) {
            assert.equal(init.method, "GET");
            retryCount = 2;
            return makeResponse(200, {
              sha: "sha-v3",
              content: toBase64Json({
                version: 1,
                providers: {
                  openai: { observedIds: ["gpt-4", "gpt-3.5"] },
                  gemini: { needsReviewNotified: [] },
                  claude: { needsReviewNotified: [] },
                },
              }),
            });
          }

          // 6. 再試行 2 回目: PUT → 成功
          if (calls.length === 6) {
            assert.equal(init.method, "PUT");
            const body = JSON.parse(init.body);
            assert.equal(body.sha, "sha-v3");
            return makeResponse(200, { commit: { sha: "sha-v4" } });
          }

          throw new Error(`unexpected call #${calls.length}`);
        },
        env: { GITHUB_TOKEN: "gh-token" },
      });

      // 計算: GET → PUT(409) → GET(retry1) → PUT(409) → GET(retry2) → PUT(success) = 6回
      assert.equal(calls.length, 6);
      assert.equal(retryCount, 2, "2回の再試行が実行されたこと");
      assert.equal(result.success, true);
    });

    it("3回の再試行に失敗した場合、例外を投げること", async () => {
      const mod = await loadScript();
      const calls = [];

      let thrown = false;
      try {
        await mod.recordObservedIds("openai", ["gpt-4"], {
          fetchFn: async (url, init = {}) => {
            calls.push({ url, init });

            // パターン: GET → PUT(409) → GET → PUT(409) → GET → PUT(409)
            // = 3回の PUT が失敗 → 3回再試行後に例外を投げる

            const isGet = init.method === "GET";
            const isPut = init.method === "PUT";

            if (isGet) {
              return makeResponse(200, {
                sha: `sha-${calls.length}`,
                content: toBase64Json({
                  version: 1,
                  providers: {
                    openai: { observedIds: [] },
                    gemini: { needsReviewNotified: [] },
                    claude: { needsReviewNotified: [] },
                  },
                }),
              });
            }

            if (isPut) {
              // すべての PUT が 409 で失敗
              return makeResponse(409, { message: "Conflict" });
            }

            throw new Error(`unexpected method: ${init.method}`);
          },
          env: { GITHUB_TOKEN: "gh-token" },
        });
      } catch (err) {
        thrown = true;
        assert.match(err.message, /재시도|retry|3回|failed/i, "再試行に関するエラーメッセージ");
      }

      assert.equal(thrown, true, "例外が投げられることを検証");
      // 計算: GET → PUT(409) → GET → PUT(409) → GET → PUT(409) = 6回
      // 最大3回の再試行なら: 初回1回 + リトライ最大3回 = 最大4回の PUT アテンプト
      // つまり: (GET + PUT失敗) × 3 + 最後の失敗で例外 = 最大6回以上の fetch call
      assert.ok(calls.length >= 4, `最低でも4回以上の fetch call があること: ${calls.length}`);
    });

    it("プロバイダーごとにobservedIds/needsReviewNotifiedを正しく構造化すること", async () => {
      const mod = await loadScript();
      const calls = [];

      await mod.recordObservedIds("gemini", ["gemini-2.5-pro"], {
        fetchFn: async (url, init = {}) => {
          calls.push({ url, init });

          if (calls.length === 1) {
            // 初回、ファイル不在
            return makeResponse(404, {});
          }

          if (calls.length === 2) {
            // PUT で新規作成
            const body = JSON.parse(init.body);
            const created = JSON.parse(decodeBase64(body.content));

            // Gemini は needsReviewNotified を使う（observedIds ではない）
            assert.equal(
              created.providers.gemini.needsReviewNotified !== undefined,
              true,
              "Gemini に needsReviewNotified が存在すること"
            );
            assert.deepEqual(
              created.providers.gemini.needsReviewNotified,
              ["gemini-2.5-pro"]
            );
            assert.equal(
              created.providers.openai?.observedIds,
              undefined,
              "OpenAI セクションが存在しないこと（初回）"
            );

            return makeResponse(200, { commit: { sha: "sha" } });
          }

          throw new Error(`unexpected call #${calls.length}`);
        },
        env: { GITHUB_TOKEN: "gh-token" },
      });

      assert.equal(calls.length, 2);
    });

    it("recordObservedIds の戻り値は { success: true } の形式であること", async () => {
      const mod = await loadScript();

      const result = await mod.recordObservedIds("openai", ["gpt-4"], {
        fetchFn: async (url, init = {}) => {
          if (init.method === "GET") {
            return makeResponse(404, {});
          }
          if (init.method === "PUT") {
            return makeResponse(200, { commit: { sha: "sha" } });
          }
          throw new Error();
        },
        env: { GITHUB_TOKEN: "gh-token" },
      });

      assert.deepEqual(result, { success: true });
    });

    it("404の場合、新規ファイル作成時に sha を指定しないこと", async () => {
      const mod = await loadScript();

      await mod.recordObservedIds("openai", ["gpt-4"], {
        fetchFn: async (url, init = {}) => {
          if (init.method === "GET") {
            return makeResponse(404, {});
          }

          if (init.method === "PUT") {
            const body = JSON.parse(init.body);
            // 404 後は sha を指定しない（GitHub Contents API の新規作成要件）
            assert.equal(body.sha, undefined, "新規作成時は sha を指定しない");
            return makeResponse(200, { commit: { sha: "sha" } });
          }

          throw new Error();
        },
        env: { GITHUB_TOKEN: "gh-token" },
      });
    });

    it("state が dep に渡された場合、readState を再度呼び出さないこと", async () => {
      const mod = await loadScript();
      const fetchCalls = [];
      const existingState = {
        version: 1,
        providers: {
          openai: { observedIds: ["gpt-4"] },
          gemini: { needsReviewNotified: [] },
          claude: { needsReviewNotified: [] },
        },
      };

      // state を deps に事前に渡す（キャッシュ効果）
      await mod.recordObservedIds("openai", ["gpt-4-turbo"], {
        state: existingState, // 既に読み込まれた状態を渡す
        fetchFn: async (url, init = {}) => {
          fetchCalls.push({ url, init });

          // state が渡されている場合、PUT のみ呼ばれるはず
          if (init.method === "PUT") {
            const body = JSON.parse(init.body);
            // sha が指定されているはず（404 ではなく既存状態）
            assert.ok(body.sha, "既存ファイルの sha が指定されている");
            return makeResponse(200, { commit: { sha: "sha" } });
          }

          throw new Error(`unexpected fetch: ${url} method=${init.method}`);
        },
        env: { GITHUB_TOKEN: "gh-token" },
      });

      // state が与えられている場合、GET（readState）を呼び出さずに PUT のみ
      assert.equal(fetchCalls.length, 1, "PUT のみ呼ばれること");
      assert.equal(fetchCalls[0].init.method, "PUT");
    });
  });
});
