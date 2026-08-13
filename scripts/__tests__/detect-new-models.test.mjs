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

test("新規モデルなしなら hasNew は false", async () => {
  const currentModelsJson = buildCurrentModelsJson();
  const calls = [];
  const result = await detectNewModels({
    fetchFn: createFetchStub(
      [
        makeResponse(200, { data: [{ id: "claude-existing", display_name: "Claude Existing" }] }),
        makeResponse(200, { data: [{ id: "gpt-existing", display_name: "GPT Existing" }] }),
        makeResponse(200, {
          models: [{ name: "models/gemini-3.1-pro-preview", displayName: "Gemini 3.1 Pro Preview", supportedGenerationMethods: ["generateContent"] }],
        }),
      ],
      calls,
    ),
    currentModelsJson: JSON.stringify(currentModelsJson),
    anthropicApiKey: "anthropic-key",
    openaiApiKey: "openai-key",
    geminiApiKey: "gemini-key",
  });

  assert.equal(result.hasNew, false);
  assert.deepEqual(result.newEntries, {});
  assert.deepEqual(result.geminiNeedsReview, []);
  assert.deepEqual(result.updatedModelsJson, currentModelsJson);
  assert.equal(fetchUrl(calls[0]), "https://api.anthropic.com/v1/models");
  assert.equal(fetchHeader(calls[0], "x-api-key"), "anthropic-key");
  assert.equal(fetchHeader(calls[1], "Authorization"), "Bearer openai-key");
  assert.equal(fetchUrl(calls[2]), "https://generativelanguage.googleapis.com/v1beta/models?key=gemini-key");
});

test("新規モデルありならプロバイダごとに分類して反映する", async () => {
  const currentModelsJson = buildCurrentModelsJson();
  const calls = [];
  const today = new Date().toISOString().slice(0, 10);

  const result = await detectNewModels({
    fetchFn: createFetchStub(
      [
        makeResponse(200, {
          data: [
            { id: "claude-new", display_name: "Claude New" },
            { id: "claude-existing", display_name: "Claude Existing" },
          ],
        }),
        makeResponse(200, {
          data: [
            { id: "gpt-new", display_name: "GPT New" },
            { id: "gpt-existing", display_name: "GPT Existing" },
            { id: "dall-e-3", display_name: "DALL·E 3" },
          ],
        }),
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
    anthropicApiKey: "anthropic-key",
    openaiApiKey: "openai-key",
    geminiApiKey: "gemini-key",
  });

  assert.equal(result.hasNew, true);
  assert.deepEqual(result.newEntries.claude, [
    {
      id: "claude-new",
      label: "Claude New",
      transport: ["api"],
      available_from: today,
      deprecated_at: null,
      shutdown_at: null,
    },
  ]);
  assert.deepEqual(result.newEntries.openai, [
    {
      id: "gpt-new",
      label: "GPT New",
      transport: ["api"],
      available_from: today,
      deprecated_at: null,
      shutdown_at: null,
    },
  ]);
  assert.deepEqual(result.newEntries.gemini, [
    {
      id: "gemini-1.5-pro-preview",
      label: "Gemini 1.5 Pro Preview",
      transport: ["api"],
      available_from: today,
      deprecated_at: null,
      shutdown_at: null,
    },
  ]);
  assert.deepEqual(result.geminiNeedsReview, []);
  assert.equal(result.updatedModelsJson.providers.claude.models[0].id, "claude-new");
  assert.equal(result.updatedModelsJson.providers.openai.models[0].id, "gpt-new");
  assert.equal(result.updatedModelsJson.providers.gemini.models[0].id, "gemini-1.5-pro-preview");
});

test("Gemini の allowlist 未合致だが generateContent 対応なら needsReview に入る", async () => {
  const result = await detectNewModels({
    fetchFn: createFetchStub(
      [
        makeResponse(200, { data: [] }),
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
    anthropicApiKey: "anthropic-key",
    openaiApiKey: "openai-key",
    geminiApiKey: "gemini-key",
  });

  assert.equal(result.hasNew, false);
  assert.deepEqual(result.geminiNeedsReview, ["gemini-99-experimental"]);
  assert.deepEqual(result.newEntries, {});
});

test("Gemini の denylist キーワードは完全に無視する", async () => {
  const result = await detectNewModels({
    fetchFn: createFetchStub(
      [
        makeResponse(200, { data: [] }),
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
    anthropicApiKey: "anthropic-key",
    openaiApiKey: "openai-key",
    geminiApiKey: "gemini-key",
  });

  assert.equal(result.hasNew, false);
  assert.deepEqual(result.newEntries, {});
  assert.deepEqual(result.geminiNeedsReview, []);
});

test("Gemini の generateContent 非対応モデルは完全に無視する", async () => {
  const result = await detectNewModels({
    fetchFn: createFetchStub(
      [
        makeResponse(200, { data: [] }),
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
    anthropicApiKey: "anthropic-key",
    openaiApiKey: "openai-key",
    geminiApiKey: "gemini-key",
  });

  assert.equal(result.hasNew, false);
  assert.deepEqual(result.newEntries, {});
  assert.deepEqual(result.geminiNeedsReview, []);
});

test("OpenAI の対象外 prefix は無視する", async () => {
  const result = await detectNewModels({
    fetchFn: createFetchStub(
      [
        makeResponse(200, { data: [] }),
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
    anthropicApiKey: "anthropic-key",
    openaiApiKey: "openai-key",
    geminiApiKey: "gemini-key",
  });

  assert.equal(result.hasNew, true);
  assert.deepEqual(result.newEntries.openai, [
    {
      id: "gpt-target",
      label: "GPT Target",
      transport: ["api"],
      available_from: new Date().toISOString().slice(0, 10),
      deprecated_at: null,
      shutdown_at: null,
    },
  ]);
});


test("main reads repo root data/models.json and prints JSON", async () => {
  const currentModelsJson = buildCurrentModelsJson();
  const calls = [];
  let output = "";

  const result = await main({
    readFileFn: async (filePath, encoding) => {
      calls.push({ filePath, encoding });
      assert.equal(filePath, path.join(ROOT, "data/models.json"));
      assert.equal(encoding, "utf8");
      return JSON.stringify(currentModelsJson);
    },
    writeFn: (text) => {
      output += text;
    },
    fetchFn: createFetchStub(
      [
        makeResponse(200, { data: [{ id: "claude-existing", display_name: "Claude Existing" }] }),
        makeResponse(200, { data: [{ id: "gpt-existing", display_name: "GPT Existing" }] }),
        makeResponse(200, { models: [{ name: "models/gemini-3.1-pro-preview", displayName: "Gemini 3.1 Pro Preview", supportedGenerationMethods: ["generateContent"] }] }),
      ],
      [],
    ),
    env: {
      ANTHROPIC_API_KEY: "anthropic-key",
      OPENAI_API_KEY: "openai-key",
      GEMINI_API_KEY: "gemini-key",
    },
  });

  assert.equal(result.hasNew, false);
  assert.equal(calls.length, 1);
  const parsed = JSON.parse(output);
  assert.equal(parsed.hasNew, false);
  assert.deepEqual(parsed.updatedModelsJson, currentModelsJson);
});
