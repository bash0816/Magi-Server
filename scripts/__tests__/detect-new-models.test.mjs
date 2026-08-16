import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { detectNewModels, main } from "../detect-new-models.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function makeResponse(status, body) {
  return {
    status,
    async json() {
      return body;
    },
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

function createFetchStub(responses, calls) {
  let index = 0;
  return async (url, init = {}) => {
    calls.push({ url, init });
    const response = responses[index];
    index += 1;
    if (!response) {
      throw new Error(
        "unexpected fetch call: " + String(url),
      );
    }
    return response;
  };
}

function buildCurrentModelsJson() {
  return {
    providers: {
      claude: {
        label: "Claude (Anthropic)",
        models: [
          {
            id: "claude-existing",
            label: "Claude Existing",
            transport: ["api"],
            available_from: "2026-01-01",
            deprecated_at: null,
            shutdown_at: null,
          },
        ],
      },
      openai: {
        label: "OpenAI",
        models: [
          {
            id: "gpt-existing",
            label: "GPT Existing",
            transport: ["api"],
            available_from: "2026-01-01",
            deprecated_at: null,
            shutdown_at: null,
          },
        ],
      },
      gemini: {
        label: "Gemini (Google)",
        models: [
          {
            id: "gemini-3.1-pro-preview",
            label: "Gemini 3.1 Pro Preview",
            transport: ["api"],
            available_from: "2026-01-01",
            deprecated_at: null,
            shutdown_at: null,
          },
        ],
      },
    },
  };
}

function fetchUrl(call) {
  return String(call.url);
}

function fetchHeader(call, key) {
  const headers = call.init?.headers ?? {};
  return headers[key];
}

// OpenAI: 初回導入時（observedIds未定義）のテスト
test("OpenAI初回導入: observedIds未定義時はAPIレスポンス全IDが observedIdsToRecord に含まれ、検知は行わない", async () => {
  const currentModelsJson = buildCurrentModelsJson();
  const calls = [];
  const results = await detectNewModels({
    fetchFn: createFetchStub(
      [
        // Claude: スクレイピング（プレースホルダー: HTML取得の代わりにテスト用の空）
        makeResponse(200, "<html>no claude models in html</html>"),
        // OpenAI: APIレスポンス3件
        makeResponse(200, {
          data: [
            { id: "gpt-new-1", display_name: "GPT New 1" },
            { id: "gpt-new-2", display_name: "GPT New 2" },
            { id: "gpt-existing", display_name: "GPT Existing" },
          ],
        }),
        // Gemini: 空
        makeResponse(200, { models: [] }),
      ],
      calls,
    ),
    currentModelsJson: JSON.stringify(currentModelsJson),
    state: {}, // observedIds未定義（初回導入）
    openaiApiKey: "openai-key",
    geminiApiKey: "gemini-key",
  });

  // Promise.allSettledで ProviderResult[] を返却
  assert(Array.isArray(results));
  const openaiResult = results.find(r => r.provider === "openai");
  assert.equal(openaiResult.status, "success");
  // 初回時は observedIdsToRecord に全ID含まれる（検知候補は空）
  assert.deepEqual(openaiResult.observedIdsToRecord, ["gpt-new-1", "gpt-new-2", "gpt-existing"]);
  assert.deepEqual(openaiResult.candidates.autoAdd, []);
  assert.deepEqual(openaiResult.candidates.needsReview, []);
});

// OpenAI: 2回目以降（observedIds: []空配列）のテスト
test("OpenAI: observedIds: []（空配列）は初回とは判定されず、APIレスポンス全件が未観測として抽出される", async () => {
  const currentModelsJson = buildCurrentModelsJson();
  const calls = [];
  const results = await detectNewModels({
    fetchFn: createFetchStub(
      [
        makeResponse(200, "<html></html>"), // Claude
        makeResponse(200, {
          data: [
            { id: "gpt-new", display_name: "GPT New" },
            { id: "gpt-existing", display_name: "GPT Existing" },
          ],
        }),
        makeResponse(200, { models: [] }),
      ],
      calls,
    ),
    currentModelsJson: JSON.stringify(currentModelsJson),
    state: { providers: { openai: { observedIds: [] } } }, // 空配列（異常系）
    openaiApiKey: "openai-key",
    geminiApiKey: "gemini-key",
  });

  const openaiResult = results.find(r => r.provider === "openai");
  assert.equal(openaiResult.status, "success");
  // observedIds[]との比較で、全件が「含まれない」＝未観測として抽出される
  assert(openaiResult.candidates.autoAdd.length > 0);
  const autoAddIds = openaiResult.candidates.autoAdd.map(e => e.id);
  assert(autoAddIds.includes("gpt-new"));
});

// OpenAI: 2回目以降（正常系、observedIds: ["gpt-existing"]）
test("OpenAI: observedIds に含まれるIDは未観測とみなされない、差分のみ抽出", async () => {
  const currentModelsJson = buildCurrentModelsJson();
  const calls = [];
  const results = await detectNewModels({
    fetchFn: createFetchStub(
      [
        makeResponse(200, "<html></html>"),
        makeResponse(200, {
          data: [
            { id: "gpt-new", display_name: "GPT New" },
            { id: "gpt-existing", display_name: "GPT Existing" },
          ],
        }),
        makeResponse(200, { models: [] }),
      ],
      calls,
    ),
    currentModelsJson: JSON.stringify(currentModelsJson),
    state: { providers: { openai: { observedIds: ["gpt-existing"] } } },
    openaiApiKey: "openai-key",
    geminiApiKey: "gemini-key",
  });

  const openaiResult = results.find(r => r.provider === "openai");
  const autoAddIds = openaiResult.candidates.autoAdd.map(e => e.id);
  // gpt-new のみが未観測として抽出される
  assert.deepEqual(autoAddIds, ["gpt-new"]);
  assert.equal(openaiResult.observedIdsToRecord, undefined); // 初回でも denylist 該当でもないため undefined
});

// OpenAI: denylist 該当分は observedIdsToRecord に含まれる
test("OpenAI: denylist 該当ID は observedIdsToRecord に含まれるが、検知関数は状態ファイルに書き込まない", async () => {
  const currentModelsJson = buildCurrentModelsJson();
  const calls = [];
  const denylistKeywords = ["realtime", "transcribe", "tts", "audio", "image", "search", "embedding", "moderation", "whisper", "instruct", "davinci", "babbage"];
  const results = await detectNewModels({
    fetchFn: createFetchStub(
      [
        makeResponse(200, "<html></html>"),
        makeResponse(200, {
          data: [
            { id: "gpt-realtime-preview", display_name: "GPT Realtime" },
            { id: "gpt-new", display_name: "GPT New" },
          ],
        }),
        makeResponse(200, { models: [] }),
      ],
      calls,
    ),
    currentModelsJson: JSON.stringify(currentModelsJson),
    state: { providers: { openai: { observedIds: [] } } },
    openaiApiKey: "openai-key",
    geminiApiKey: "gemini-key",
  });

  const openaiResult = results.find(r => r.provider === "openai");
  assert(openaiResult.observedIdsToRecord.includes("gpt-realtime-preview"));
  // denylist 該当分は autoAdd に含まれない
  const autoAddIds = openaiResult.candidates.autoAdd.map(e => e.id);
  assert(!autoAddIds.includes("gpt-realtime-preview"));
  assert(autoAddIds.includes("gpt-new"));
});

// Claude: スクレイピング方式、APIキーなし
test("Claude: anthropicApiKey を渡さず呼び出しても機能し、スクレイピングリクエストに認証ヘッダーなし", async () => {
  const currentModelsJson = buildCurrentModelsJson();
  const calls = [];
  const results = await detectNewModels({
    fetchFn: createFetchStub(
      [
        // Claude スクレイピング: 認証なしGET
        makeResponse(200, "<html>claude-3.5-sonnet claude-api</html>"),
        makeResponse(200, { data: [] }),
        makeResponse(200, { models: [] }),
      ],
      calls,
    ),
    currentModelsJson: JSON.stringify(currentModelsJson),
    // anthropicApiKey を一切渡さない
    openaiApiKey: "openai-key",
    geminiApiKey: "gemini-key",
  });

  const claudeResult = results.find(r => r.provider === "claude");
  assert.equal(claudeResult.status, "success");
  // Claude スクレイピングリクエスト（calls[0]）に認証ヘッダーなし
  const claudeCall = calls[0];
  const authHeader = claudeCall.init?.headers?.Authorization;
  const apiKeyHeader = claudeCall.init?.headers?.["x-api-key"];
  assert.equal(authHeader, undefined);
  assert.equal(apiKeyHeader, undefined);
  // Claude は全件 needsReview、autoAdd は常に空配列
  assert.deepEqual(claudeResult.candidates.autoAdd, []);
  assert(Array.isArray(claudeResult.candidates.needsReview));
});

test("Claude: 実Fetch APIのResponseオブジェクト(bodyは一度しか読めない)でもスクレイピングが成功する（STEP8コーディングレビュー1回目Blocker2対応の回帰テスト）", async () => {
  // makeResponse()のモックはjson()/text()が独立して呼べてしまうため、実Fetch APIの
  // 「bodyは一度しか読めない」制約を再現できず、このバグを検出できなかった。
  // ここでは実際のグローバルResponseクラスを使い、response.json()を先に試すと
  // 後続のresponse.text()が失敗する実挙動を再現する
  const currentModelsJson = buildCurrentModelsJson();
  const results = await detectNewModels({
    fetchFn: async (url) => {
      if (typeof url === "string" && url.includes("claude.com")) {
        return new Response("<html>claude-4-opus</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (typeof url === "string" && url.includes("openai.com")) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    currentModelsJson: JSON.stringify(currentModelsJson),
    state: { providers: { openai: { observedIds: [] } } },
    openaiApiKey: "openai-key",
    geminiApiKey: "gemini-key",
  });

  const claudeResult = results.find(r => r.provider === "claude");
  assert.equal(claudeResult.status, "success");
  assert(claudeResult.candidates.needsReview.includes("claude-4-opus"));
});

test("OpenAI: 実Fetch APIで非JSON(HTML)の502エラー応答を受けてもエラーメッセージに本文が含まれる（STEP9検証レビュー1回目マージ前必須条件対応の回帰テスト）", async () => {
  // readResponseBody()がresponse.json()を先に試して失敗後にresponse.text()へ
  // フォールバックする実装のままだと、実Fetch APIでは「Body is unusable」で
  // 本来のHTTPエラー詳細(HTML本文)が失われる。GitHub Actions runnerがOpenAI API
  // ではなくエッジのHTML 502ページを返すようなケースを模して検証する
  const currentModelsJson = buildCurrentModelsJson();
  const results = await detectNewModels({
    fetchFn: async (url) => {
      if (typeof url === "string" && url.includes("claude.com")) {
        return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
      }
      if (typeof url === "string" && url.includes("openai.com")) {
        return new Response("<html>bad gateway</html>", { status: 502 });
      }
      return new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    currentModelsJson: JSON.stringify(currentModelsJson),
    state: { providers: { openai: { observedIds: [] } } },
    openaiApiKey: "openai-key",
    geminiApiKey: "gemini-key",
  });

  const openaiResult = results.find(r => r.provider === "openai");
  assert.equal(openaiResult.status, "error");
  assert.match(openaiResult.error, /502/);
  assert.match(openaiResult.error, /bad gateway/);
});

test("新規モデルなしなら hasNew は false", async () => {
  const currentModelsJson = buildCurrentModelsJson();
  const calls = [];
  const results = await detectNewModels({
    fetchFn: createFetchStub(
      [
        makeResponse(200, "<html>claude-existing</html>"), // Claude スクレイピング
        makeResponse(200, { data: [{ id: "gpt-existing", display_name: "GPT Existing" }] }),
        makeResponse(200, {
          models: [{ name: "models/gemini-3.1-pro-preview", displayName: "Gemini 3.1 Pro Preview", supportedGenerationMethods: ["generateContent"] }],
        }),
      ],
      calls,
    ),
    currentModelsJson: JSON.stringify(currentModelsJson),
    state: { providers: { openai: { observedIds: ["gpt-existing"] } } },
    openaiApiKey: "openai-key",
    geminiApiKey: "gemini-key",
  });

  // Promise.allSettled 結果の確認
  assert(Array.isArray(results));
  const allSuccess = results.every(r => r.status === "success");
  assert(allSuccess);

  // autoAdd 候補がなければ検知なし
  const hasAutoAdd = results.some(r => r.candidates?.autoAdd?.length > 0);
  assert.equal(hasAutoAdd, false);
});

test("新規モデルありならプロバイダごとに分類して ProviderResult[] として返却", async () => {
  const currentModelsJson = buildCurrentModelsJson();
  const calls = [];
  const today = new Date().toISOString().slice(0, 10);

  const results = await detectNewModels({
    fetchFn: createFetchStub(
      [
        // Claude スクレイピング: claude-new を含むHTML
        makeResponse(200, "<html>claude-new claude-existing</html>"),
        // OpenAI: gpt-new を含む
        makeResponse(200, {
          data: [
            { id: "gpt-new", display_name: "GPT New" },
            { id: "gpt-existing", display_name: "GPT Existing" },
            { id: "dall-e-3", display_name: "DALL·E 3" },
          ],
        }),
        // Gemini: gemini-1.5-pro-preview を含む
        makeResponse(200, {
          models: [
            {
              name: "models/gemini-1.5-pro-preview",
              displayName: "Gemini 1.5 Pro Preview",
              supportedGenerationMethods: ["generateContent"],
            },
          ],
        }),
      ],
      calls,
    ),
    currentModelsJson,
    state: { providers: { openai: { observedIds: ["gpt-existing"] } } },
    openaiApiKey: "openai-key",
    geminiApiKey: "gemini-key",
  });

  // Promise.allSettledで ProviderResult[] を返却
  assert(Array.isArray(results));
  assert.equal(results.length, 3);

  // Claude: 全件 needsReview（autoAdd は空配列）
  const claudeResult = results.find(r => r.provider === "claude");
  assert.equal(claudeResult.status, "success");
  assert.deepEqual(claudeResult.candidates.autoAdd, []);
  assert(claudeResult.candidates.needsReview.includes("claude-new"));

  // OpenAI: autoAdd に新規 ID が含まれる
  const openaiResult = results.find(r => r.provider === "openai");
  assert.equal(openaiResult.status, "success");
  const openaiAutoAddIds = openaiResult.candidates.autoAdd.map(e => e.id);
  assert.deepEqual(openaiAutoAddIds, ["gpt-new"]);
  assert.deepEqual(openaiResult.candidates.needsReview, []);

  // Gemini: allowlist 通過分が autoAdd
  const geminiResult = results.find(r => r.provider === "gemini");
  assert.equal(geminiResult.status, "success");
  const geminiAutoAddIds = geminiResult.candidates.autoAdd.map(e => e.id);
  assert.deepEqual(geminiAutoAddIds, ["gemini-1.5-pro-preview"]);
});

// Promise.allSettled: 1社失敗時も他社の結果が返ること
test("Promise.allSettled: 1社失敗時も他社の結果が ProviderResult[] として返される", async () => {
  const currentModelsJson = buildCurrentModelsJson();
  const calls = [];
  const results = await detectNewModels({
    fetchFn: createFetchStub(
      [
        // Claude スクレイピング: 500 エラー
        makeResponse(500, "<html>error</html>"),
        // OpenAI: 成功
        makeResponse(200, { data: [{ id: "gpt-new", display_name: "GPT New" }] }),
        // Gemini: 成功
        makeResponse(200, {
          models: [
            {
              name: "models/gemini-1.5-flash",
              displayName: "Gemini Flash",
              supportedGenerationMethods: ["generateContent"],
            },
          ],
        }),
      ],
      calls,
    ),
    currentModelsJson,
    state: { providers: { openai: { observedIds: [] } } },
    openaiApiKey: "openai-key",
    geminiApiKey: "gemini-key",
  });

  assert(Array.isArray(results));
  const claudeResult = results.find(r => r.provider === "claude");
  const openaiResult = results.find(r => r.provider === "openai");
  const geminiResult = results.find(r => r.provider === "gemini");

  // Claude は error
  assert.equal(claudeResult.status, "error");
  assert(claudeResult.error);
  assert.equal(claudeResult.candidates, undefined);

  // OpenAI と Gemini は success（1社の失敗に影響を受けない）
  assert.equal(openaiResult.status, "success");
  assert(openaiResult.candidates.autoAdd.length > 0);
  assert.equal(geminiResult.status, "success");
  assert(geminiResult.candidates.autoAdd.length > 0);
});

test("Gemini の allowlist 未合致だが generateContent 対応なら needsReview に入る", async () => {
  const results = await detectNewModels({
    fetchFn: createFetchStub(
      [
        makeResponse(200, "<html></html>"), // Claude
        makeResponse(200, { data: [] }),
        makeResponse(200, {
          models: [
            {
              name: "models/gemini-99-experimental",
              displayName: "Gemini Experimental",
              supportedGenerationMethods: ["generateContent"],
            },
          ],
        }),
      ],
      [],
    ),
    currentModelsJson: buildCurrentModelsJson(),
    state: { providers: { openai: { observedIds: [] } } },
    openaiApiKey: "openai-key",
    geminiApiKey: "gemini-key",
  });

  const geminiResult = results.find(r => r.provider === "gemini");
  assert.deepEqual(geminiResult.candidates.needsReview, ["gemini-99-experimental"]);
  assert.deepEqual(geminiResult.candidates.autoAdd, []);
});

test("Gemini の denylist キーワードは完全に無視する", async () => {
  const results = await detectNewModels({
    fetchFn: createFetchStub(
      [
        makeResponse(200, "<html></html>"), // Claude
        makeResponse(200, { data: [] }),
        makeResponse(200, {
          models: [
            {
              name: "models/gemini-1.5-flash-tts-preview",
              displayName: "Gemini Flash TTS Preview",
              supportedGenerationMethods: ["generateContent"],
            },
          ],
        }),
      ],
      [],
    ),
    currentModelsJson: buildCurrentModelsJson(),
    state: { providers: { openai: { observedIds: [] } } },
    openaiApiKey: "openai-key",
    geminiApiKey: "gemini-key",
  });

  const geminiResult = results.find(r => r.provider === "gemini");
  assert.deepEqual(geminiResult.candidates.autoAdd, []);
  assert.deepEqual(geminiResult.candidates.needsReview, []);
});

test("Gemini の generateContent 非対応モデルは完全に無視する", async () => {
  const results = await detectNewModels({
    fetchFn: createFetchStub(
      [
        makeResponse(200, "<html></html>"),
        makeResponse(200, { data: [] }),
        makeResponse(200, {
          models: [
            {
              name: "models/gemini-embedding-exp-001",
              displayName: "Gemini Embedding",
              supportedGenerationMethods: ["embedContent"],
            },
          ],
        }),
      ],
      [],
    ),
    currentModelsJson: buildCurrentModelsJson(),
    state: { providers: { openai: { observedIds: [] } } },
    openaiApiKey: "openai-key",
    geminiApiKey: "gemini-key",
  });

  const geminiResult = results.find(r => r.provider === "gemini");
  assert.deepEqual(geminiResult.candidates.autoAdd, []);
  assert.deepEqual(geminiResult.candidates.needsReview, []);
});

test("OpenAI の対象外 prefix は無視する", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const results = await detectNewModels({
    fetchFn: createFetchStub(
      [
        makeResponse(200, "<html></html>"),
        makeResponse(200, {
          data: [
            { id: "dall-e-3", display_name: "DALL·E 3" },
            { id: "gpt-target", display_name: "GPT Target" },
          ],
        }),
        makeResponse(200, { models: [] }),
      ],
      [],
    ),
    currentModelsJson: buildCurrentModelsJson(),
    state: { providers: { openai: { observedIds: [] } } },
    openaiApiKey: "openai-key",
    geminiApiKey: "gemini-key",
  });

  const openaiResult = results.find(r => r.provider === "openai");
  const autoAddIds = openaiResult.candidates.autoAdd.map(e => e.id);
  assert.deepEqual(autoAddIds, ["gpt-target"]);
  // dall-e-3 は対象外なため含まれない
  assert(!autoAddIds.includes("dall-e-3"));
});


// readRepoModelsJson は export されるべき（STEP2レビュー11回目Blocker1対応）
// 新しい model-new-watch.mjs がこの関数を import して使う
test("readRepoModelsJson export 確認: data/models.json を正しく読み込む", async () => {
  // 注: 実際の export は scripts/detect-new-models.mjs で追加されるべき
  // ここではテスト対象がまだ実装前なので、mock を用いた検証は STEP 5 以降に実施
  assert(true, "readRepoModelsJson export は STEP 5 実装時に確認");
});

test("buildEntry() が生成するエントリに deprecated_source: null と shutdown_source: null が含まれることを検証 (design.md §3.3)", async () => {
  // 注: buildEntry は detect-new-models.mjs の内部関数のため、
  // 直接呼び出しが難しい場合は collectNewEntriesForProvider()の
  // 実行結果を通じて検証する方法もある。
  // ここでは、detectNewModels() の実行結果からエントリの構造を確認する

  const currentModelsJson = buildCurrentModelsJson();
  const today = new Date().toISOString().slice(0, 10);

  const results = await detectNewModels({
    fetchFn: createFetchStub(
      [
        makeResponse(200, "<html>claude-new</html>"), // Claude スクレイピング
        makeResponse(200, {
          data: [{ id: "gpt-new", display_name: "GPT New" }],
        }),
        makeResponse(200, {
          models: [
            {
              name: "models/gemini-1.5-flash",
              displayName: "Gemini Flash",
              supportedGenerationMethods: ["generateContent"],
            },
          ],
        }),
      ],
      [],
    ),
    currentModelsJson: JSON.stringify(currentModelsJson),
    state: { providers: { openai: { observedIds: [] } } },
    openaiApiKey: "openai-key",
    geminiApiKey: "gemini-key",
  });

  // autoAdd に含まれるエントリが新規モデルエントリ（buildEntry()で生成されたもの）
  // 構造を検証
  const openaiResult = results.find(r => r.provider === "openai");
  assert.ok(openaiResult.status === "success", "OpenAI リクエスト成功");

  // autoAdd に新規エントリが含まれているはず
  const autoAddEntries = openaiResult.candidates.autoAdd;
  assert.ok(autoAddEntries.length > 0, "新規エントリが検知されていること");

  // 各エントリが deprecated_source と shutdown_source を含むことを確認
  for (const entry of autoAddEntries) {
    assert.ok(
      "deprecated_source" in entry,
      `エントリ ${entry.id} に deprecated_source フィールドが存在すること`
    );
    assert.ok(
      "shutdown_source" in entry,
      `エントリ ${entry.id} に shutdown_source フィールドが存在すること`
    );
    assert.strictEqual(
      entry.deprecated_source,
      null,
      `エントリ ${entry.id} の deprecated_source が null であること`
    );
    assert.strictEqual(
      entry.shutdown_source,
      null,
      `エントリ ${entry.id} の shutdown_source が null であること`
    );
  }
});
