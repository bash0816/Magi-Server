#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_MODEL_PROVIDER_KEYS = ["claude", "openai", "gemini"];
const CLAUDE_MODELS_URL = "https://api.anthropic.com/v1/models";
const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
const GEMINI_MODELS_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_ALLOWLIST = /^gemini-\d+(?:\.\d+)?-(?:pro|flash|flash-lite)(?:-(?:preview(?:-[0-9-]+)?|\d{3}))?$/;
const GEMINI_DENY_KEYWORDS = ["tts", "embedding", "robotics", "computer-use", "deep-research", "veo", "lyria", "-image", "-live"];
const GEMINI_DENY_SUFFIXES = ["-latest"];

function ensureString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(label + " が必要です");
  }
  return value;
}

function sanitizeBody(body) {
  if (body == null) {
    return "";
  }
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > 800 ? text.slice(0, 800) + "..." : text;
}

function createHttpError(label, status, body) {
  const detail = sanitizeBody(body);
  const suffix = detail ? ": " + detail : "";
  return new Error(label + " HTTP " + status + suffix);
}

async function readResponseBody(response) {
  if (!response) {
    return null;
  }
  if (typeof response.json === "function") {
    try {
      return await response.json();
    } catch (_error) {
      // Fall through to text.
    }
  }
  if (typeof response.text === "function") {
    const text = await response.text();
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch (_error) {
      return text;
    }
  }
  return null;
}

async function requestJson(fetchFn, url, init) {
  const response = await fetchFn(url, init);
  const body = await readResponseBody(response);
  return { response, body };
}

function parseCurrentModelsJson(currentModelsJson) {
  if (typeof currentModelsJson === "string") {
    try {
      return JSON.parse(currentModelsJson);
    } catch (error) {
      throw new Error("currentModelsJson を JSON として解析できません: " + error.message);
    }
  }
  if (currentModelsJson && typeof currentModelsJson === "object") {
    return currentModelsJson;
  }
  throw new Error("currentModelsJson が必要です");
}

function assertCurrentModelsShape(currentModelsJson) {
  if (!currentModelsJson || typeof currentModelsJson !== "object") {
    throw new Error("currentModelsJson はオブジェクトである必要があります");
  }
  if (!currentModelsJson.providers || typeof currentModelsJson.providers !== "object") {
    throw new Error("currentModelsJson.providers が必要です");
  }
  for (const providerKey of DEFAULT_MODEL_PROVIDER_KEYS) {
    const provider = currentModelsJson.providers[providerKey];
    if (!provider || typeof provider !== "object") {
      throw new Error("currentModelsJson.providers." + providerKey + " が必要です");
    }
    if (!Array.isArray(provider.models)) {
      throw new Error("currentModelsJson.providers." + providerKey + ".models は配列である必要があります");
    }
  }
}

function cloneCurrentModelsJson(currentModelsJson) {
  if (typeof structuredClone === "function") {
    return structuredClone(currentModelsJson);
  }
  return JSON.parse(JSON.stringify(currentModelsJson));
}

function normalizeModelId(rawId) {
  if (typeof rawId !== "string") {
    return "";
  }
  const trimmed = rawId.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("models/") ? trimmed.slice(7) : trimmed;
}

function getDisplayName(model) {
  if (!model || typeof model !== "object") {
    return "";
  }
  const candidates = [model.display_name, model.displayName, model.label];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return "";
}

function buildEntry(id, label, availableFrom) {
  return {
    id,
    label: label || id,
    transport: ["api"],
    available_from: availableFrom,
    deprecated_at: null,
    shutdown_at: null,
  };
}

function extractExistingIds(currentModelsJson) {
  const existingIds = new Set();
  for (const provider of Object.values(currentModelsJson.providers)) {
    for (const model of provider.models) {
      if (model && typeof model.id === "string" && model.id.trim()) {
        existingIds.add(model.id.trim());
      }
    }
  }
  return existingIds;
}

function ensureArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(label + " は配列である必要があります");
  }
  return value;
}


function collectNewEntriesForProvider(providerKey, candidateModels, existingIds, today, newEntries, updatedModelsJson) {
  const entries = [];
  for (const candidate of candidateModels) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const id = normalizeModelId(candidate.id ?? candidate.name);
    if (!id) {
      continue;
    }
    if (existingIds.has(id)) {
      continue;
    }
    existingIds.add(id);
    const label = getDisplayName(candidate) || id;
    const entry = buildEntry(id, label, today);
    entries.push(entry);
    updatedModelsJson.providers[providerKey].models.unshift(entry);
  }
  if (entries.length > 0) {
    newEntries[providerKey] = entries;
  }
}

async function fetchClaudeModels(fetchFn, anthropicApiKey) {
  const result = await requestJson(fetchFn, CLAUDE_MODELS_URL, {
    method: "GET",
    headers: {
      "x-api-key": anthropicApiKey,
    },
  });
  if (result.response.status !== 200) {
    throw createHttpError("Anthropic モデル一覧取得", result.response.status, result.body);
  }
  const body = result.body && typeof result.body === "object" ? result.body : {};
  return ensureArray(body.data, "Anthropic response.data");
}

async function fetchOpenAiModels(fetchFn, openaiApiKey) {
  const result = await requestJson(fetchFn, OPENAI_MODELS_URL, {
    method: "GET",
    headers: {
      Authorization: "Bearer " + openaiApiKey,
    },
  });
  if (result.response.status !== 200) {
    throw createHttpError("OpenAI モデル一覧取得", result.response.status, result.body);
  }
  const body = result.body && typeof result.body === "object" ? result.body : {};
  return ensureArray(body.data, "OpenAI response.data");
}

async function fetchGeminiModels(fetchFn, geminiApiKey) {
  const url = GEMINI_MODELS_BASE_URL + "?key=" + encodeURIComponent(geminiApiKey);
  const result = await requestJson(fetchFn, url, { method: "GET" });
  if (result.response.status !== 200) {
    throw createHttpError("Gemini モデル一覧取得", result.response.status, result.body);
  }
  const body = result.body && typeof result.body === "object" ? result.body : {};
  return ensureArray(body.models, "Gemini response.models");
}

function isOpenAiTargetModel(id) {
  return /^(gpt|o1|o3|o4)/.test(id);
}

function isGeminiDenied(id) {
  return GEMINI_DENY_KEYWORDS.some((keyword) => id.includes(keyword)) || GEMINI_DENY_SUFFIXES.some((suffix) => id.endsWith(suffix));
}



export async function detectNewModels(deps = {}) {
  const {
    fetchFn = globalThis.fetch,
    currentModelsJson,
    anthropicApiKey,
    openaiApiKey,
    geminiApiKey,
  } = deps;

  if (typeof fetchFn !== "function") {
    throw new Error("fetchFn が必要です");
  }
  ensureString(anthropicApiKey, "anthropicApiKey");
  ensureString(openaiApiKey, "openaiApiKey");
  ensureString(geminiApiKey, "geminiApiKey");

  const parsedCurrentModelsJson = parseCurrentModelsJson(currentModelsJson);
  assertCurrentModelsShape(parsedCurrentModelsJson);

  const existingIds = extractExistingIds(parsedCurrentModelsJson);
  const today = new Date().toISOString().slice(0, 10);
  const updatedModelsJson = cloneCurrentModelsJson(parsedCurrentModelsJson);
  const newEntries = {};
  const geminiNeedsReview = [];

  const [claudeModels, openAiModels, geminiModels] = await Promise.all([
    fetchClaudeModels(fetchFn, anthropicApiKey),
    fetchOpenAiModels(fetchFn, openaiApiKey),
    fetchGeminiModels(fetchFn, geminiApiKey),
  ]);

  const claudeTargets = claudeModels.filter((model) => typeof model?.id === "string" && model.id.startsWith("claude"));
  collectNewEntriesForProvider("claude", claudeTargets, existingIds, today, newEntries, updatedModelsJson);

  const openAiTargets = openAiModels.filter((model) => typeof model?.id === "string" && isOpenAiTargetModel(model.id));
  collectNewEntriesForProvider("openai", openAiTargets, existingIds, today, newEntries, updatedModelsJson);

  for (const model of geminiModels) {
    if (!model || typeof model !== "object") {
      continue;
    }
    const id = normalizeModelId(model.id ?? model.name);
    if (!id || !id.startsWith("gemini-")) {
      continue;
    }
    const supportedGenerationMethods = Array.isArray(model.supportedGenerationMethods) ? model.supportedGenerationMethods : [];
    if (!supportedGenerationMethods.includes("generateContent")) {
      continue;
    }
    if (isGeminiDenied(id)) {
      continue;
    }
    if (!GEMINI_ALLOWLIST.test(id)) {
      if (!geminiNeedsReview.includes(id)) {
        geminiNeedsReview.push(id);
      }
      continue;
    }
    if (existingIds.has(id)) {
      continue;
    }
    existingIds.add(id);
    const entry = buildEntry(id, getDisplayName(model) || id, today);
    if (!newEntries.gemini) {
      newEntries.gemini = [];
    }
    newEntries.gemini.push(entry);
    updatedModelsJson.providers.gemini.models.unshift(entry);
  }

  const hasNew = Object.values(newEntries).some((entries) => Array.isArray(entries) && entries.length > 0);

  return {
    hasNew,
    newEntries,
    geminiNeedsReview,
    updatedModelsJson,
  };
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

async function readRepoModelsJson(deps = {}) {
  const { readFileFn = fs.readFileSync, repoRoot = DEFAULT_REPO_ROOT } = deps;
  const raw = await Promise.resolve(readFileFn(path.join(repoRoot, 'data/models.json'), 'utf8'));
  return typeof raw === 'string' ? raw : String(raw);
}

export async function main(deps = {}) {
  const {
    env = process.env,
    console: logger = console,
    writeFn = (text) => process.stdout.write(text),
  } = deps;

  const anthropicApiKey = env.ANTHROPIC_API_KEY;
  const openaiApiKey = env.OPENAI_API_KEY;
  const geminiApiKey = env.GEMINI_API_KEY;

  ensureString(anthropicApiKey, 'ANTHROPIC_API_KEY');
  ensureString(openaiApiKey, 'OPENAI_API_KEY');
  ensureString(geminiApiKey, 'GEMINI_API_KEY');

  const currentModelsJson = await readRepoModelsJson(deps);
  const result = await detectNewModels({
    ...deps,
    currentModelsJson,
    anthropicApiKey,
    openaiApiKey,
    geminiApiKey,
  });

  writeFn(JSON.stringify(result, null, 2) + '\n');
  return result;
}

export default detectNewModels;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[detect-new-models] ' + (error?.message ?? error));
    process.exitCode = 1;
  });
}
