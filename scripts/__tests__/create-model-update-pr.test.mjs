import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "scripts/create-model-update-pr.mjs");

async function loadScript() {
  return import(pathToFileURL(SCRIPT).href + "?t=" + Date.now());
}

function makeResponse(status, body) {
  return {
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    headers: {
      get: (name) => {
        // ページネーションテスト用
        if (name === "link" && body?.pagination?.nextUrl) {
          return `<${body.pagination.nextUrl}>; rel="next"`;
        }
        return null;
      },
    },
  };
}

function decodeBase64(value) {
  return Buffer.from(String(value), "base64").toString("utf8");
}

function buildDetectedResult(overrides = {}) {
  return {
    hasNew: true,
    newIds: ["claude-new", "gpt-new", "gemini-new"],
    geminiNeedsReview: ["gemini-99-experimental"],
    updatedModelsJson: {
      providers: {
        claude: {
          label: "Claude",
          models: [
            {
              id: "claude-new",
              label: "Claude New",
              transport: ["api"],
              available_from: "2026-04-26",
              deprecated_at: null,
              shutdown_at: null,
            },
          ],
        },
        openai: {
          label: "OpenAI",
          models: [
            {
              id: "gpt-new",
              label: "GPT New",
              transport: ["api"],
              available_from: "2026-04-26",
              deprecated_at: null,
              shutdown_at: null,
            },
          ],
        },
        gemini: {
          label: "Gemini",
          models: [
            {
              id: "gemini-new",
              label: "Gemini New",
              transport: ["api"],
              available_from: "2026-04-26",
              deprecated_at: null,
              shutdown_at: null,
            },
          ],
        },
      },
    },
    ...overrides,
  };
}

describe("create-model-update-pr (Magi-Server)", () => {
  it("新規ブランチ作成からコミットとPR作成まで実行する", async () => {
    const mod = await loadScript();
    const calls = [];
    const detected = buildDetectedResult();
    const emptyContent = JSON.stringify({
      providers: {
        claude: { label: "Claude", models: [] },
        openai: { label: "OpenAI", models: [] },
        gemini: { label: "Gemini", models: [] },
      },
    }, null, 2) + "\n";

    const result = await mod.createModelUpdatePr({
      fetchFn: async (url, init = {}) => {
        calls.push({ url, init });

        // 1. PR検索（state=open&base=main、prefix候補フィルタ）
        if (calls.length === 1) {
          assert.equal(url, "https://api.github.com/repos/bash0816/Magi-Server/pulls?state=open&base=main&per_page=100");
          assert.equal(init.method, "GET");
          return makeResponse(200, []);
        }

        // 2. mainブランチのrefチェック
        if (calls.length === 2) {
          assert.equal(url, "https://api.github.com/repos/bash0816/Magi-Server/git/ref/heads/main");
          assert.equal(init.method, "GET");
          return makeResponse(200, { object: { sha: "main-sha" } });
        }

        // 3. 新規ブランチ作成
        if (calls.length === 3) {
          assert.equal(url, "https://api.github.com/repos/bash0816/Magi-Server/git/refs");
          assert.equal(init.method, "POST");
          const body = JSON.parse(init.body);
          assert.equal(body.ref, "refs/heads/model-update/20260426");
          assert.equal(body.sha, "main-sha");
          return makeResponse(201, { ref: "refs/heads/model-update/20260426" });
        }

        // 4. 新規ブランチの data/models.json を取得
        if (calls.length === 4) {
          assert.equal(url, "https://api.github.com/repos/bash0816/Magi-Server/contents/data/models.json?ref=model-update%2F20260426");
          assert.equal(init.method, "GET");
          return makeResponse(200, {
            sha: "branch-file-sha",
            content: Buffer.from(emptyContent, "utf8").toString("base64"),
          });
        }

        // 5. ファイル更新
        if (calls.length === 5) {
          assert.equal(url, "https://api.github.com/repos/bash0816/Magi-Server/contents/data/models.json");
          assert.equal(init.method, "PUT");
          const body = JSON.parse(init.body);
          assert.equal(body.branch, "model-update/20260426");
          assert.equal(body.sha, "branch-file-sha");
          assert.equal(decodeBase64(body.content), JSON.stringify(detected.updatedModelsJson, null, 2) + "\n");
          return makeResponse(200, { commit: { sha: "commit-sha" } });
        }

        // 6. PR作成
        if (calls.length === 6) {
          assert.equal(url, "https://api.github.com/repos/bash0816/Magi-Server/pulls");
          assert.equal(init.method, "POST");
          const body = JSON.parse(init.body);
          assert.equal(body.title, "🤖 新規モデル追加: claude-new, gpt-new, gemini-new");
          assert.equal(body.head, "model-update/20260426");
          assert.equal(body.base, "main");
          return makeResponse(201, { number: 123, html_url: "https://github.com/bash0816/Magi-Server/pull/123" });
        }

        throw new Error("unexpected fetch call: " + url);
      },
      env: { GITHUB_TOKEN: "gh-token" },
      now: () => new Date("2026-04-26T12:00:00.000Z"),
      detected,
    });

    assert.equal(result.hasNew, true);
    assert.equal(result.branchName, "model-update/20260426");
    assert.equal(result.prAction, "created");
    assert.equal(result.prNumber, 123);
  });

  it("hasNew が false なら何もしない", async () => {
    const mod = await loadScript();
    let called = false;

    const result = await mod.createModelUpdatePr({
      fetchFn: async () => {
        called = true;
        throw new Error("fetch should not be called");
      },
      env: { GITHUB_TOKEN: "gh-token" },
      detected: buildDetectedResult({ hasNew: false }),
      now: () => new Date("2026-04-26T12:00:00.000Z"),
    });

    assert.equal(result.hasNew, false);
    assert.equal(called, false);
  });

  it("既存PRが見つかった場合、未登録IDのみを差分マージしてPUTする", async () => {
    const mod = await loadScript();
    const calls = [];
    const detected = buildDetectedResult();

    // 既存ブランチの content（claude-new は既に登録済み）
    const existingContent = JSON.stringify({
      providers: {
        claude: {
          label: "Claude",
          models: [
            {
              id: "claude-new",
              label: "Claude New",
              transport: ["api", "cli"],  // 人間が手動修正した transport
              available_from: "2026-04-26",
              deprecated_at: null,
              shutdown_at: null,
            },
          ],
        },
        openai: { label: "OpenAI", models: [] },
        gemini: { label: "Gemini", models: [] },
      },
    }, null, 2) + "\n";

    const result = await mod.createModelUpdatePr({
      fetchFn: async (url, init = {}) => {
        calls.push({ url, init });

        // 1. PR検索で既存PRを見つける
        if (calls.length === 1) {
          return makeResponse(200, [
            {
              number: 456,
              state: "open",
              head: {
                ref: "model-update/20260426",
                repo: { full_name: "bash0816/Magi-Server" },
              },
              base: { ref: "main" },
              html_url: "https://github.com/bash0816/Magi-Server/pull/456",
            },
          ]);
        }

        // 2. 既存ブランチの data/models.json を取得
        if (calls.length === 2) {
          return makeResponse(200, {
            sha: "branch-file-sha",
            content: Buffer.from(existingContent, "utf8").toString("base64"),
          });
        }

        // 3. ファイル更新（新規IDのみ追加、既存の claude-new の transport["api", "cli"]を温存）
        if (calls.length === 3) {
          const body = JSON.parse(init.body);
          const updatedJson = JSON.parse(decodeBase64(body.content));
          // claude-new は温存、gpt-new と gemini-new が新規追加される
          assert.deepEqual(updatedJson.providers.claude.models[0].transport, ["api", "cli"]);
          assert.equal(updatedJson.providers.openai.models.length, 1);
          assert.equal(updatedJson.providers.openai.models[0].id, "gpt-new");
          return makeResponse(200, { commit: { sha: "commit-sha" } });
        }

        throw new Error("unexpected fetch call at length " + calls.length);
      },
      env: { GITHUB_TOKEN: "gh-token" },
      now: () => new Date("2026-04-26T12:00:00.000Z"),
      detected,
    });

    assert.equal(result.prAction, "reused");
    assert.equal(result.prNumber, 456);
  });

  it("外部forkが作成した同名prefix PRは候補として無視される", async () => {
    const mod = await loadScript();
    const calls = [];
    const detected = buildDetectedResult();

    const result = await mod.createModelUpdatePr({
      fetchFn: async (url, init = {}) => {
        calls.push({ url, init });

        // 1. PR検索で外部fork作成のPRが返される
        if (calls.length === 1) {
          return makeResponse(200, [
            {
              number: 999,
              state: "open",
              head: {
                ref: "model-update/20260426",
                repo: { full_name: "external-fork/Magi-Server" },  // 外部fork
              },
              base: { ref: "main" },
            },
          ]);
        }

        // 2. mainブランチのrefチェック（外部fork対策により新規ブランチ作成を続行）
        if (calls.length === 2) {
          return makeResponse(200, { object: { sha: "main-sha" } });
        }

        // 3. 新規ブランチ作成（外部fork PRは無視されたため）
        if (calls.length === 3) {
          return makeResponse(201, { ref: "refs/heads/model-update/20260426" });
        }

        // 4-6. 新規PR作成へ続行...
        if (calls.length === 4) {
          return makeResponse(200, {
            sha: "branch-file-sha",
            content: Buffer.from(JSON.stringify({ providers: { claude: { models: [] }, openai: { models: [] }, gemini: { models: [] } } }, null, 2) + "\n").toString("base64"),
          });
        }
        if (calls.length === 5) {
          return makeResponse(200, { commit: { sha: "commit-sha" } });
        }
        if (calls.length === 6) {
          return makeResponse(201, { number: 789, html_url: "https://github.com/bash0816/Magi-Server/pull/789" });
        }

        throw new Error("unexpected fetch call");
      },
      env: { GITHUB_TOKEN: "gh-token" },
      now: () => new Date("2026-04-26T12:00:00.000Z"),
      detected,
    });

    // 外部fork対策により新規PR作成される
    assert.equal(result.prAction, "created");
    assert.equal(result.prNumber, 789);
  });

  it("head.repo が null のPR も例外を発生させず候補外として扱われる", async () => {
    const mod = await loadScript();
    const calls = [];
    const detected = buildDetectedResult();

    const result = await mod.createModelUpdatePr({
      fetchFn: async (url, init = {}) => {
        calls.push({ url, init });

        // 1. PR検索で head.repo が null のPRが返される
        if (calls.length === 1) {
          return makeResponse(200, [
            {
              number: 888,
              state: "open",
              head: {
                ref: "model-update/20260426",
                repo: null,  // fork削除等の理由で null
              },
              base: { ref: "main" },
            },
          ]);
        }

        // 2. mainブランチ確認（null-safety対策により新規ブランチ作成を続行）
        if (calls.length === 2) {
          return makeResponse(200, { object: { sha: "main-sha" } });
        }

        // 3. 新規ブランチ作成
        if (calls.length === 3) {
          return makeResponse(201, { ref: "refs/heads/model-update/20260426" });
        }

        if (calls.length === 4) {
          return makeResponse(200, {
            sha: "branch-file-sha",
            content: Buffer.from(JSON.stringify({ providers: { claude: { models: [] }, openai: { models: [] }, gemini: { models: [] } } }, null, 2) + "\n").toString("base64"),
          });
        }
        if (calls.length === 5) {
          return makeResponse(200, { commit: { sha: "commit-sha" } });
        }
        if (calls.length === 6) {
          return makeResponse(201, { number: 777, html_url: "https://github.com/bash0816/Magi-Server/pull/777" });
        }

        throw new Error("unexpected fetch call");
      },
      env: { GITHUB_TOKEN: "gh-token" },
      now: () => new Date("2026-04-26T12:00:00.000Z"),
      detected,
    });

    // 新規PR作成
    assert.equal(result.prAction, "created");
    assert.equal(result.prNumber, 777);
  });

  it("model-update/* PRが2件以上見つかった場合に失敗する", async () => {
    const mod = await loadScript();
    let errorThrown = false;
    let errorMessage = "";

    try {
      await mod.createModelUpdatePr({
        fetchFn: async (url) => {
          if (url.includes("/pulls?")) {
            // 複数の model-update/* PR が見つかる
            return makeResponse(200, [
              { number: 111, state: "open", head: { ref: "model-update/20260426", repo: { full_name: "bash0816/Magi-Server" } } },
              { number: 222, state: "open", head: { ref: "model-update/20260425", repo: { full_name: "bash0816/Magi-Server" } } },
            ]);
          }
          throw new Error("unexpected fetch call");
        },
        env: { GITHUB_TOKEN: "gh-token" },
        now: () => new Date("2026-04-26T12:00:00.000Z"),
        detected: buildDetectedResult(),
      });
    } catch (error) {
      errorThrown = true;
      errorMessage = error.message;
    }

    assert.equal(errorThrown, true);
    assert.match(errorMessage, /複数|2件以上/);
  });

  it("detect-new-models.mjs の実際の出力形状（newIdsを持たずnewEntriesのみ）でもPRを作成できる", async () => {
    const mod = await loadScript();
    const calls = [];
    const detectedFromRealOutput = {
      hasNew: true,
      newEntries: {
        claude: [
          {
            id: "claude-new",
            label: "Claude New",
            transport: ["api"],
            available_from: "2026-04-26",
            deprecated_at: null,
            shutdown_at: null,
          },
        ],
      },
      geminiNeedsReview: [],
      updatedModelsJson: {
        providers: {
          claude: { label: "Claude", models: [{ id: "claude-new", label: "Claude New", transport: ["api"], available_from: "2026-04-26", deprecated_at: null, shutdown_at: null }] },
          openai: { label: "OpenAI", models: [] },
          gemini: { label: "Gemini", models: [] },
        },
      },
    };

    const result = await mod.createModelUpdatePr({
      fetchFn: async (url) => {
        calls.push(url);
        if (calls.length === 1) return makeResponse(200, []);
        if (calls.length === 2) return makeResponse(200, { object: { sha: "main-sha" } });
        if (calls.length === 3) return makeResponse(201, { ref: "refs/heads/model-update/20260426" });
        if (calls.length === 4) {
          return makeResponse(200, {
            sha: "branch-file-sha",
            content: Buffer.from(JSON.stringify({ providers: { claude: { models: [] }, openai: { models: [] }, gemini: { models: [] } } }, null, 2) + "\n").toString("base64"),
          });
        }
        if (calls.length === 5) return makeResponse(200, { commit: { sha: "commit-sha" } });
        if (calls.length === 6) return makeResponse(201, { number: 12, html_url: "https://github.com/bash0816/Magi-Server/pull/12" });
        throw new Error("unexpected fetch call");
      },
      env: { GITHUB_TOKEN: "gh-token" },
      now: () => new Date("2026-04-26T12:00:00.000Z"),
      detected: detectedFromRealOutput,
    });

    assert.equal(result.hasNew, true);
    assert.equal(result.prAction, "created");
  });

  it("open PR候補が100件を超える場合、Linkヘッダーのページネーションを辿って全件取得する", async () => {
    const mod = await loadScript();
    const calls = [];
    const detected = buildDetectedResult();

    const page1 = Object.assign([], {
      pagination: {
        nextUrl: "https://api.github.com/repos/bash0816/Magi-Server/pulls?state=open&base=main&per_page=100&page=2",
      },
    });
    const page2 = [
      {
        number: 555,
        state: "open",
        head: {
          ref: "model-update/20260425",
          repo: { full_name: "bash0816/Magi-Server" },
        },
        base: { ref: "main" },
        html_url: "https://github.com/bash0816/Magi-Server/pull/555",
      },
    ];

    const existingContent = JSON.stringify({
      providers: {
        claude: { label: "Claude", models: [] },
        openai: { label: "OpenAI", models: [] },
        gemini: { label: "Gemini", models: [] },
      },
    }, null, 2) + "\n";

    const result = await mod.createModelUpdatePr({
      fetchFn: async (url, init = {}) => {
        calls.push({ url, init });

        // 1ページ目: 該当候補なし、Linkヘッダーで次ページへ
        if (calls.length === 1) {
          assert.equal(url, "https://api.github.com/repos/bash0816/Magi-Server/pulls?state=open&base=main&per_page=100");
          assert.equal(init.method, "GET");
          return makeResponse(200, page1);
        }

        // 2ページ目: 該当PRが1件見つかる
        if (calls.length === 2) {
          assert.equal(url, "https://api.github.com/repos/bash0816/Magi-Server/pulls?state=open&base=main&per_page=100&page=2");
          assert.equal(init.method, "GET");
          return makeResponse(200, page2);
        }

        // 3. 既存ブランチの data/models.json を取得
        if (calls.length === 3) {
          return makeResponse(200, {
            sha: "branch-file-sha",
            content: Buffer.from(existingContent, "utf8").toString("base64"),
          });
        }

        // 4. ファイル更新
        if (calls.length === 4) {
          return makeResponse(200, { commit: { sha: "commit-sha" } });
        }

        throw new Error("unexpected fetch call at length " + calls.length);
      },
      env: { GITHUB_TOKEN: "gh-token" },
      now: () => new Date("2026-04-26T12:00:00.000Z"),
      detected,
    });

    // 2ページ目に見つかった既存PRが正しく再利用されることを確認
    assert.equal(result.prAction, "reused");
    assert.equal(result.prNumber, 555);
    assert.equal(calls.length, 4);
  });
});
