#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const DEFAULT_OWNER = "bash0816";
const DEFAULT_REPO = "Magi-Server";
const DEFAULT_BASE_BRANCH = "main";
const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const ISSUE_TITLE = "[model-new-watch] 実行失敗";

function ensureString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(label + " が必要です");
  }
  return value.trim();
}

function sanitizeBody(body) {
  if (body == null) {
    return "";
  }
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > 1000 ? text.slice(0, 1000) + "..." : text;
}

function extractMessage(body) {
  if (typeof body === "string") {
    return body.trim();
  }
  if (body && typeof body === "object") {
    return String(body.message ?? body.error ?? body.errors?.[0]?.message ?? JSON.stringify(body));
  }
  return "";
}

function createHttpError(label, status, body) {
  const detail = extractMessage(body) || sanitizeBody(body);
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

function buildHeaders(githubToken) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: "Bearer " + githubToken,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
}

function buildBranchName(now = new Date()) {
  return "model-update/" + now.toISOString().slice(0, 10).replace(/-/g, "");
}

function normalizeBase64(value) {
  return String(value ?? "").replace(/\n/g, "");
}

function toBase64Json(value) {
  return Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8").toString("base64");
}

function buildPrTitle(newIds) {
  return "🤖 新規モデル追加: " + newIds.join(", ");
}

function buildPrBody({ newIds, geminiNeedsReview = [] }) {
  const lines = ["## 新規モデル一覧", ""];
  for (const id of newIds) {
    lines.push("- `" + id + "`");
  }
  lines.push("", "> transportはCLI対応があれば手動修正してください。既定は `[\"api\"]` です。");
  if (geminiNeedsReview.length > 0) {
    lines.push("", "## Gemini 要確認", "");
    for (const id of geminiNeedsReview) {
      lines.push("- `" + id + "`");
    }
  }
  return lines.join("\n");
}

function extractNewIdsFromEntries(newEntries) {
  if (!newEntries || typeof newEntries !== "object") return [];
  return Object.values(newEntries)
    .filter((entries) => Array.isArray(entries))
    .flat()
    .map((entry) => entry?.id)
    .filter((id) => typeof id === "string" && id.trim() !== "");
}

function parseDetectedInput(detected) {
  const parsed = typeof detected === "string" ? JSON.parse(detected) : detected;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("detected が必要です");
  }
  // detect-new-models.mjs の出力は newIds を持たず、プロバイダ別の newEntries のみを返す。
  // newIds が未指定なら newEntries から導出し、両スクリプトの出力形状の差異を吸収する。
  if (!Array.isArray(parsed.newIds) && parsed.newEntries) {
    return { ...parsed, newIds: extractNewIdsFromEntries(parsed.newEntries) };
  }
  return parsed;
}

function assertDetectedShape(detected) {
  if (!detected || typeof detected !== "object") {
    throw new Error("detected はオブジェクトである必要があります");
  }
  if (detected.hasNew !== true) {
    return false;
  }
  if (!Array.isArray(detected.newIds) || detected.newIds.length === 0) {
    throw new Error("detected.newIds が必要です");
  }
  if (!detected.updatedModelsJson || typeof detected.updatedModelsJson !== "object") {
    throw new Error("detected.updatedModelsJson が必要です");
  }
  return true;
}

function buildCommitBody({ updatedContent, branchFileSha, branchName, prTitle }) {
  const body = {
    message: prTitle,
    content: updatedContent,
    branch: branchName,
  };
  if (branchFileSha) {
    body.sha = branchFileSha;
  }
  return body;
}

function buildPullsUrl(owner, repo) {
  return GITHUB_API_BASE + "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo) + "/pulls";
}

function buildBranchRefUrl(owner, repo, branchName) {
  return GITHUB_API_BASE + "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo) + "/git/ref/heads/" + encodeURIComponent(branchName);
}

function buildContentsUrl(owner, repo, ref) {
  return GITHUB_API_BASE + "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo) + "/contents/data/models.json?ref=" + encodeURIComponent(ref);
}

function buildBranchCreateUrl(owner, repo) {
  return GITHUB_API_BASE + "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo) + "/git/refs";
}

function buildContentsWriteUrl(owner, repo) {
  return GITHUB_API_BASE + "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo) + "/contents/data/models.json";
}

function buildPullSearchUrl(owner, repo, baseBranch) {
  const params = new URLSearchParams({ state: "open", base: baseBranch, per_page: "100" });
  return buildPullsUrl(owner, repo) + "?" + params.toString();
}

function assertSuccessfulStatus(response, expectedStatuses, label) {
  if (expectedStatuses.includes(response.status)) {
    return;
  }
  throw createHttpError(label, response.status, response.body);
}

function branchRefSha(body) {
  const sha = body?.object?.sha;
  if (typeof sha !== "string" || sha.trim() === "") {
    throw new Error("ブランチ ref の sha を取得できませんでした");
  }
  return sha;
}

function branchFileSha(body) {
  const sha = body?.sha;
  const content = body?.content;
  if (typeof sha !== "string" || sha.trim() === "" || typeof content !== "string") {
    throw new Error("対象ブランチ models.json を取得できませんでした");
  }
  return sha;
}

function findModelUpdatePrs(body, owner, repo) {
  if (!Array.isArray(body)) return [];
  const fullName = owner + "/" + repo;
  return body.filter((pr) =>
    pr?.head?.ref?.startsWith("model-update/") &&
    pr.head.repo?.full_name === fullName,
  );
}

function decodeJsonContent(value) {
  try {
    return JSON.parse(Buffer.from(normalizeBase64(value), "base64").toString("utf8"));
  } catch (_error) {
    throw new Error("対象ブランチ models.json の内容をJSONとして解析できませんでした");
  }
}

function mergeNewModels(currentModelsJson, detectedModelsJson, newIds) {
  const merged = currentModelsJson && typeof currentModelsJson === "object" ? structuredClone(currentModelsJson) : {};
  if (!merged.providers || typeof merged.providers !== "object") merged.providers = {};
  const ids = new Set(newIds);
  for (const [providerName, detectedProvider] of Object.entries(detectedModelsJson?.providers ?? {})) {
    const detectedModels = Array.isArray(detectedProvider?.models) ? detectedProvider.models : [];
    const additions = detectedModels.filter((model) => ids.has(model?.id));
    if (additions.length === 0) continue;
    const currentProvider = merged.providers[providerName];
    if (!currentProvider || typeof currentProvider !== "object") merged.providers[providerName] = { ...detectedProvider, models: [] };
    else if (!Array.isArray(currentProvider.models)) currentProvider.models = [];
    const existingIds = new Set(merged.providers[providerName].models.map((model) => model?.id));
    for (const model of additions) {
      if (!existingIds.has(model.id)) {
        merged.providers[providerName].models.push(model);
        existingIds.add(model.id);
      }
    }
  }
  return merged;
}

async function findExistingModelUpdatePr(fetchFn, owner, repo, baseBranch, token) {
  let url = buildPullSearchUrl(owner, repo, baseBranch);
  const candidates = [];
  while (url) {
    const result = await requestJson(fetchFn, url, { method: "GET", headers: buildHeaders(token) });
    if (result.response.status !== 200) throw createHttpError("既存PRを検索", result.response.status, result.body);
    candidates.push(...findModelUpdatePrs(result.body, owner, repo));
    const link = typeof result.response.headers?.get === "function" ? result.response.headers.get("link") : null;
    const next = link?.match(/<([^>]+)>;\s*rel="next"/i);
    url = next?.[1] ?? null;
  }
  return candidates;
}

async function readStdinText(readFn = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}) {
  return readFn();
}

export async function createModelUpdatePr(deps = {}) {
  const {
    fetchFn = globalThis.fetch,
    env = process.env,
    detected,
    githubToken = env.GITHUB_TOKEN,
    owner = DEFAULT_OWNER,
    repo = DEFAULT_REPO,
    baseBranch = DEFAULT_BASE_BRANCH,
    now = () => new Date(),
  } = deps;
  if (typeof fetchFn !== "function") throw new Error("fetchFn が必要です");
  const token = ensureString(githubToken, "githubToken");
  const parsedDetected = parseDetectedInput(detected);
  if (!assertDetectedShape(parsedDetected)) return { hasNew: false, skipped: true };

  const newIds = parsedDetected.newIds.map((value) => ensureString(value, "newIds の要素"));
  const geminiNeedsReview = Array.isArray(parsedDetected.geminiNeedsReview)
    ? parsedDetected.geminiNeedsReview.filter((value) => typeof value === "string" && value.trim() !== "") : [];
  const detectedModelsJson = parsedDetected.updatedModelsJson;
  const prTitle = typeof parsedDetected.prTitle === "string" && parsedDetected.prTitle.trim() !== ""
    ? parsedDetected.prTitle.trim() : buildPrTitle(newIds);
  const prBody = typeof parsedDetected.prBody === "string" && parsedDetected.prBody.trim() !== ""
    ? parsedDetected.prBody.trim() : buildPrBody({ newIds, geminiNeedsReview });

  const candidates = await findExistingModelUpdatePr(fetchFn, owner, repo, baseBranch, token);
  if (candidates.length > 1) throw new Error("model-update/* の既存PRが複数（2件以上）見つかりました");

  let branchName;
  let branchCreated = false;
  let branchCreateReused = false;
  let branchExists = false;
  let existingBranchSha = null;
  let existingPr = null;
  if (candidates.length === 1) {
    existingPr = candidates[0];
    branchName = existingPr.head.ref;
  } else {
    branchName = parsedDetected.branchName || buildBranchName(now());
    const baseRefResult = await requestJson(fetchFn, buildBranchRefUrl(owner, repo, baseBranch), { method: "GET", headers: buildHeaders(token) });
    if (baseRefResult.response.status !== 200) throw createHttpError("staging SHA を取得", baseRefResult.response.status, baseRefResult.body);
    const baseSha = branchRefSha(baseRefResult.body);
    const createResult = await requestJson(fetchFn, buildBranchCreateUrl(owner, repo), {
      method: "POST", headers: { ...buildHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "refs/heads/" + branchName, sha: baseSha }),
    });
    if (createResult.response.status === 201) branchCreated = true;
    else if (createResult.response.status === 422 && /already exists/i.test(sanitizeBody(createResult.body))) branchCreateReused = true;
    else throw createHttpError("ブランチ作成", createResult.response.status, createResult.body);
  }

  const contentResult = await requestJson(fetchFn, buildContentsUrl(owner, repo, branchName), { method: "GET", headers: buildHeaders(token) });
  if (contentResult.response.status !== 200) throw createHttpError("対象ブランチ models.json を取得", contentResult.response.status, contentResult.body);
  const fileSha = branchFileSha(contentResult.body);
  const currentModelsJson = decodeJsonContent(contentResult.body.content);
  const mergedModelsJson = mergeNewModels(currentModelsJson, detectedModelsJson, newIds);
  const updatedContent = toBase64Json(mergedModelsJson);
  const currentContent = normalizeBase64(contentResult.body.content);
  const needsCommit = currentContent !== updatedContent;
  let commitSkipped = true;
  let commitStatusCode = null;
  let commitSha = null;
  if (needsCommit) {
    const commitResult = await requestJson(fetchFn, buildContentsWriteUrl(owner, repo), {
      method: "PUT", headers: { ...buildHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify(buildCommitBody({ updatedContent, branchFileSha: fileSha, branchName, prTitle })),
    });
    if (![200, 201].includes(commitResult.response.status)) throw createHttpError("models.json をコミット", commitResult.response.status, commitResult.body);
    commitSkipped = false;
    commitStatusCode = commitResult.response.status;
    commitSha = commitResult.body?.commit?.sha ?? null;
  }
  if (existingPr) return {
    hasNew: true, branchName, branchExists: true, branchCreated, branchCreateReused, existingBranchSha,
    branchFileSha: fileSha, needsCommit, commitSkipped, commitStatusCode, commitSha, hasExistingPr: true,
    existingPrNumber: existingPr.number ?? null, existingPrUrl: existingPr.html_url ?? null, prAction: "reused",
    prNumber: existingPr.number ?? null, prUrl: existingPr.html_url ?? null, newIds, geminiNeedsReview,
  };
  const createPrResult = await requestJson(fetchFn, buildPullsUrl(owner, repo), {
    method: "POST", headers: { ...buildHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ title: prTitle, body: prBody, head: branchName, base: baseBranch }),
  });
  if (createPrResult.response.status !== 201) throw createHttpError("PR 作成", createPrResult.response.status, createPrResult.body);
  return {
    hasNew: true, branchName, branchExists, branchCreated, branchCreateReused, existingBranchSha,
    branchFileSha: fileSha, needsCommit, commitSkipped, commitStatusCode, commitSha, hasExistingPr: false,
    existingPrNumber: null, existingPrUrl: null, prAction: "created", prNumber: createPrResult.body?.number ?? null,
    prUrl: createPrResult.body?.html_url ?? null, newIds, geminiNeedsReview,
  };
}

export async function main(deps = {}) {
  const {
    env = process.env,
    console: logger = console,
    readStdinFn,
  } = deps;

  try {
    const inputText = typeof deps.inputText === "string"
      ? deps.inputText
      : typeof deps.detected === "undefined"
        ? await readStdinText(readStdinFn)
        : "";
    const detected = typeof deps.detected === "undefined" ? JSON.parse(inputText) : deps.detected;
    const result = await createModelUpdatePr({ ...deps, env, detected });
    logger.log(JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    logger.error("[create-model-update-pr] " + (error?.message ?? error));
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
