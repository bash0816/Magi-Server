#!/usr/bin/env node

/**
 * 状態ファイル読み書き (data/model-watch-state.json)
 *
 * Contents API経由で、observedIds/needsReviewNotified を管理する。
 * - 404時の扱い: {} を返す（初回導入時）
 * - 409/422時の再試行: 最大3回、毎回SHA再取得してマージし直す
 */

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const DEFAULT_OWNER = "bash0816";
const DEFAULT_REPO = "Magi-Server";
const DEFAULT_BASE_BRANCH = "main";
const STATE_FILE_PATH = "data/model-watch-state.json";

/**
 * GitHub Contents API用のURL構築
 */
function buildStateFileUrl(owner, repo, ref = DEFAULT_BASE_BRANCH) {
  return (
    GITHUB_API_BASE +
    "/repos/" +
    encodeURIComponent(owner) +
    "/" +
    encodeURIComponent(repo) +
    "/contents/data/model-watch-state.json?ref=" +
    encodeURIComponent(ref)
  );
}

/**
 * GitHub Contents API用の書き込みURL構築
 */
function buildStateFileWriteUrl(owner, repo) {
  return (
    GITHUB_API_BASE +
    "/repos/" +
    encodeURIComponent(owner) +
    "/" +
    encodeURIComponent(repo) +
    "/contents/" +
    encodeURIComponent(STATE_FILE_PATH)
  );
}

/**
 * GitHub APIヘッダ構築
 */
function buildHeaders(githubToken) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: "Bearer " + githubToken,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
}

/**
 * Base64エンコード（JSON + 末尾改行）
 */
function toBase64Json(value) {
  return Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8").toString(
    "base64"
  );
}

/**
 * Base64デコード
 */
function fromBase64(value) {
  return Buffer.from(String(value ?? ""), "base64").toString("utf8");
}

/**
 * レスポンスボディ読み込み
 */
async function readResponseBody(response) {
  if (!response) return null;
  if (typeof response.json === "function") {
    try {
      return await response.json();
    } catch (_error) {
      // Fall through to text.
    }
  }
  if (typeof response.text === "function") {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (_error) {
      return text;
    }
  }
  return null;
}

/**
 * JSON API呼び出し
 */
async function requestJson(fetchFn, url, init) {
  const response = await fetchFn(url, init);
  const body = await readResponseBody(response);
  return { response, body };
}

/**
 * 状態ファイルを読む
 *
 * @param {object} deps - { fetchFn, env }
 * @returns {Promise<object>} パースされた状態、またはファイル不在時は {}
 */
export async function readState(deps = {}) {
  const {
    fetchFn = globalThis.fetch,
    env = process.env,
    owner = DEFAULT_OWNER,
    repo = DEFAULT_REPO,
    baseBranch = DEFAULT_BASE_BRANCH,
  } = deps;

  if (typeof fetchFn !== "function") {
    throw new Error("fetchFn が必要です");
  }

  const githubToken = env.GITHUB_TOKEN?.trim();
  if (!githubToken) {
    throw new Error("githubToken が必要です");
  }

  const url = buildStateFileUrl(owner, repo, baseBranch);
  const result = await requestJson(fetchFn, url, {
    method: "GET",
    headers: buildHeaders(githubToken),
  });

  // 404 = ファイル不在（初回）
  if (result.response.status === 404) {
    return {};
  }

  // 200 以外はエラー
  if (result.response.status !== 200) {
    throw new Error(
      `状態ファイル読み込み失敗 HTTP ${result.response.status}: ${
        result.body?.message ?? ""
      }`
    );
  }

  // Base64デコードしてJSONパース
  if (!result.body?.content) {
    throw new Error("状態ファイルが空です");
  }

  try {
    const decoded = fromBase64(result.body.content);
    const parsed = JSON.parse(decoded);
    // recordObservedIds で state 渡し時に使用するため、対応する sha を内部フィールドに含める
    Object.defineProperty(parsed, "__sha", {
      value: result.body.sha,
      enumerable: false,
      configurable: false,
    });
    return parsed;
  } catch (error) {
    throw new Error(`状態ファイルのパース失敗: ${error.message}`);
  }
}

/**
 * 観測済みIDを記録（マージ・再試行付き）
 *
 * @param {string} provider - "openai" | "gemini" | "claude"
 * @param {string[]} ids - 記録対象のID一覧
 * @param {object} deps - { fetchFn, env, state?, currentSha?, ... }
 * @returns {Promise<{success: true}>}
 */
export async function recordObservedIds(provider, ids, deps = {}) {
  const {
    fetchFn = globalThis.fetch,
    env = process.env,
    state,
    currentSha,
    owner = DEFAULT_OWNER,
    repo = DEFAULT_REPO,
    baseBranch = DEFAULT_BASE_BRANCH,
  } = deps;

  if (typeof fetchFn !== "function") {
    throw new Error("fetchFn が必要です");
  }

  const githubToken = env.GITHUB_TOKEN?.trim();
  if (!githubToken) {
    throw new Error("githubToken が必要です");
  }

  if (typeof provider !== "string" || !provider.trim()) {
    throw new Error("provider が必要です");
  }

  if (!Array.isArray(ids)) {
    throw new Error("ids は配列である必要があります");
  }

  // プロバイダーごとにフィールド名を決める
  const fieldName =
    provider === "openai" ? "observedIds" : "needsReviewNotified";

  // 内部関数: 状態を読み込んで最新の SHA を取得
  async function fetchLatestState() {
    const url = buildStateFileUrl(owner, repo, baseBranch);
    const result = await requestJson(fetchFn, url, {
      method: "GET",
      headers: buildHeaders(githubToken),
    });

    if (result.response.status === 404) {
      return { sha: undefined, currentState: {} };
    }

    if (result.response.status !== 200) {
      throw new Error(
        `状態ファイル取得失敗 HTTP ${result.response.status}: ${
          result.body?.message ?? ""
        }`
      );
    }

    if (!result.body?.content) {
      throw new Error("状態ファイルが空です");
    }

    try {
      const decoded = fromBase64(result.body.content);
      const currentState = JSON.parse(decoded);
      return { sha: result.body.sha, currentState };
    } catch (error) {
      throw new Error(`状態ファイルのパース失敗: ${error.message}`);
    }
  }

  // 内部関数: 状態をマージ（Set和集合）
  function mergeState(currentState, newIds, provider, fieldName) {
    const merged = currentState && typeof currentState === "object"
      ? structuredClone(currentState)
      : {};

    if (!merged.providers || typeof merged.providers !== "object") {
      merged.providers = {};
    }

    if (!merged.version) {
      merged.version = 1;
    }

    if (!merged.providers[provider] || typeof merged.providers[provider] !== "object") {
      merged.providers[provider] = {};
    }

    // Set和集合で冪等マージ
    const existing = Array.isArray(merged.providers[provider][fieldName])
      ? merged.providers[provider][fieldName]
      : [];
    const combined = [...new Set([...existing, ...newIds])];

    merged.providers[provider][fieldName] = combined;
    return merged;
  }

  // state が deps に渡されていれば、それを使う（GET省略）
  let currentState, sha;
  if (state && typeof state === "object") {
    currentState = state;
    // state が渡されている場合、readState で取得時の SHA が内部フィールドに含まれているか、
    // currentSha が渡されているはず（キャッシュ効果）。
    // 両方ない場合（test等）はダミー値を使用（内部用・実運用では currentSha 渡しが前提）
    sha = currentSha ?? state.__sha ?? "state-cache-sha";
  } else {
    // GET してSHAと現在状態を取得
    const fetched = await fetchLatestState();
    sha = fetched.sha;
    currentState = fetched.currentState;
  }

  // マージ
  const mergedState = mergeState(currentState, ids, provider, fieldName);

  // PUT で書き込み（409/422時は最大3回再試行）
  const MAX_RETRIES = 3;
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const writeUrl = buildStateFileWriteUrl(owner, repo);
      const content = toBase64Json(mergedState);

      const body = {
        message: `chore: record ${provider} observed IDs`,
        content,
        branch: baseBranch,
      };

      // 初回作成時は sha を指定しない
      if (sha) {
        body.sha = sha;
      }

      const result = await requestJson(fetchFn, writeUrl, {
        method: "PUT",
        headers: buildHeaders(githubToken),
        body: JSON.stringify(body),
      });

      // 200/201 = 成功
      if (result.response.status === 200 || result.response.status === 201) {
        return { success: true };
      }

      // 409/422 = SHA競合（再試行対象）
      if (result.response.status === 409 || result.response.status === 422) {
        lastError = new Error(
          `SHA競合 HTTP ${result.response.status}（試行 ${attempt + 1}/${MAX_RETRIES + 1}）`
        );

        // 再試行時は最新SHAを再取得
        if (attempt < MAX_RETRIES) {
          const fetched = await fetchLatestState();
          sha = fetched.sha;
          currentState = fetched.currentState;

          // マージしなおし
          const remergedState = mergeState(currentState, ids, provider, fieldName);
          // 再度マージの結果で上書き
          Object.assign(mergedState, remergedState);
          continue; // 次の試行へ
        } else {
          // 3回再試行後も失敗 → 例外を投げる
          throw new Error(
            `状態ファイル更新失敗: ${MAX_RETRIES}回の再試行後も競合状態が解決しません`
          );
        }
      }

      // その他のエラー
      throw new Error(
        `状態ファイル更新失敗 HTTP ${result.response.status}: ${
          result.body?.message ?? ""
        }`
      );
    } catch (error) {
      // 409/422 でない限りは即座に re-throw
      if (
        error.message &&
        !error.message.includes("SHA競合") &&
        !error.message.includes("再試行後も競合")
      ) {
        throw error;
      }

      // 409/422 で MAX_RETRIES に達した場合
      if (attempt === MAX_RETRIES) {
        throw error;
      }
    }
  }

  // 到達しないはず（再試行ロジックで例外を投げるため）
  throw lastError || new Error("予期しないエラー");
}
