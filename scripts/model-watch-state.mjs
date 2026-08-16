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
const DEFAULT_BASE_BRANCH = "model-watch-state";
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
  // 実Fetch APIのResponseはbodyを一度しか読めないため、response.json()を先に試して
  // 失敗後にresponse.text()へフォールバックすると「Body is unusable」で失敗する
  // (STEP9検証レビュー1回目マージ前必須条件対応)。同一レスポンスに対しjson()とtext()を
  // 両方呼ばないよう、text()が使えればそちらを優先し(JSON.parseで復元)、text()を
  // 持たない簡易モック向けにjson()単独呼び出しへフォールバックする
  if (!response) return null;
  if (typeof response.text === "function") {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (_error) {
      return text;
    }
  }
  if (typeof response.json === "function") {
    try {
      return await response.json();
    } catch (_error) {
      return null;
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

/**
 * ロールバック時の状態マージ（design.md §7.1）
 *
 * main ブランチと model-watch-state ブランチの双方の状態ファイルを統合する。
 * マージ規則（design.md §7.1より）：
 * - providers.openai.observedIds（配列）：集合和で統合
 * - providers.gemini.needsReviewNotified（配列）：集合和で統合
 * - providers.claude.needsReviewNotified（配列）：集合和で統合
 * - version（数値）：両方の値のうち大きい方を採用
 * - 未知フィールド：main側を優先。main側に存在せず model-watch-state側にのみ存在するものは引き継ぐ
 * - providers配下の未知フィールド：トップレベルと同じルール（main優先、main側に存在しない場合は引き継ぐ）
 *
 * @param {object} mainState - main ブランチの状態
 * @param {object} watchState - model-watch-state ブランチの状態
 * @returns {object} マージ済みの状態
 */
export function mergeStateForRollback(mainState, watchState) {
  // 入力値の正規化（undefined/null は空オブジェクトと扱う）
  const main = mainState || {};
  const watch = watchState || {};

  // 結果オブジェクト（mainをベースに開始）
  const merged = structuredClone(main);

  // providers オブジェクトの初期化
  if (!merged.providers || typeof merged.providers !== "object") {
    merged.providers = {};
  }

  if (!watch.providers || typeof watch.providers !== "object") {
    watch.providers = {};
  }

  // version の統合：大きい方を採用
  const mainVersion = typeof main.version === "number" ? main.version : 0;
  const watchVersion = typeof watch.version === "number" ? watch.version : 0;
  merged.version = Math.max(mainVersion, watchVersion);

  // 既知の3プロバイダー：集合和で配列フィールドをマージ
  for (const provider of ["openai", "gemini", "claude"]) {
    if (!merged.providers[provider]) {
      merged.providers[provider] = {};
    }

    // fieldName はプロバイダーごとに異なる
    const fieldName = provider === "openai" ? "observedIds" : "needsReviewNotified";

    // mainとwatchの配列を取得（存在しない場合は空配列）
    const mainArray = Array.isArray(merged.providers[provider][fieldName])
      ? merged.providers[provider][fieldName]
      : [];
    const watchArray = Array.isArray(watch.providers[provider]?.[fieldName])
      ? watch.providers[provider][fieldName]
      : [];

    // 集合和で統合（重複を除去）
    merged.providers[provider][fieldName] = [
      ...new Set([...mainArray, ...watchArray]),
    ];

    // 既知3プロバイダーの未知フィールド統合：main側を優先、main側に存在しない場合は引き継ぐ
    // merged.providers[provider] には既にmain側のデータが入っているので（structuredClone済み）、
    // watch側にのみ存在する未知フィールドを追加する
    if (watch.providers[provider] && typeof watch.providers[provider] === "object") {
      for (const fieldKey of Object.keys(watch.providers[provider])) {
        // 既知フィールド（集合和で処理済み）をスキップ
        if (fieldKey === "observedIds" || fieldKey === "needsReviewNotified") {
          continue;
        }
        // main側に存在しない場合、watch側から引き継ぐ
        if (!(fieldKey in merged.providers[provider])) {
          merged.providers[provider][fieldKey] = structuredClone(
            watch.providers[provider][fieldKey]
          );
        }
      }
    }
  }

  // 未知プロバイダー：main側を優先、main側に存在しない場合は引き継ぐ
  const knownProviders = ["openai", "gemini", "claude"];
  for (const providerKey of Object.keys(watch.providers)) {
    if (knownProviders.includes(providerKey)) {
      // 既知プロバイダーは既に処理済み
      continue;
    }
    // main側に存在しない場合、watch側から引き継ぐ
    if (!(providerKey in merged.providers)) {
      merged.providers[providerKey] = structuredClone(watch.providers[providerKey]);
    }
  }

  // トップレベルの未知フィールド統合：main側を優先、main側に存在しない場合は引き継ぐ
  const knownTopLevelFields = ["version", "providers"];

  // watch側にのみ存在するフィールド（main側に存在しないもの）を引き継ぐ
  for (const key of Object.keys(watch)) {
    if (!knownTopLevelFields.includes(key) && !(key in merged)) {
      merged[key] = structuredClone(watch[key]);
    }
  }

  return merged;
}

/**
 * 検証プローブ: 書き込み経路の独立テスト
 *
 * 一時フィールド (_verificationProbe) を追加・削除し、各操作後のSHA変化を検証する。
 * GitHub Actions内の実GITHUB_TOKENでの書き込みが機能していることを直接確認する。
 *
 * @param {object} deps - { fetchFn, env, ... }
 * @returns {Promise<{success: true}>}
 */
export async function writeVerificationProbe(deps = {}) {
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

  // ステップ1: 初回GET（現在のSHAとコンテンツを取得）
  const fetched = await fetchLatestState();
  let currentSha = fetched.sha;
  let currentContent = fetched.currentState;

  const writeUrl = buildStateFileWriteUrl(owner, repo);

  // ステップ2: _verificationProbe を追加してPUT（409/422時は最大3回再試行）
  const MAX_RETRIES = 3;
  let afterAddSha;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const probeContent = structuredClone(currentContent);
      probeContent._verificationProbe = {
        at: new Date().toISOString(),
      };

      const addBody = {
        message: "chore: add verification probe",
        content: toBase64Json(probeContent),
        branch: baseBranch,
      };

      // 404でない限り（ファイル存在時）、SHAを指定
      if (currentSha) {
        addBody.sha = currentSha;
      }

      const addResult = await requestJson(fetchFn, writeUrl, {
        method: "PUT",
        headers: buildHeaders(githubToken),
        body: JSON.stringify(addBody),
      });

      // 200/201 = 成功
      if (addResult.response.status === 200 || addResult.response.status === 201) {
        afterAddSha = addResult.body?.commit?.sha;
        if (!afterAddSha) {
          throw new Error("プローブ追加後のSHAが取得できません");
        }

        // SHA変化を確認
        if (afterAddSha === currentSha) {
          throw new Error(
            "プローブ追加後、SHAが変化していません（書き込みが反映されていない可能性）"
          );
        }

        break; // ステップ3へ進む
      }

      // 409/422 = SHA競合（再試行対象）
      if (addResult.response.status === 409 || addResult.response.status === 422) {
        // 再試行時は最新SHAを再取得
        if (attempt < MAX_RETRIES) {
          const latest = await fetchLatestState();
          currentSha = latest.sha;
          currentContent = latest.currentState;
          continue; // 次の試行へ
        } else {
          // 3回再試行後も失敗 → 例外を投げる
          throw new Error(
            `プローブ追加失敗: ${MAX_RETRIES}回の再試行後も競合状態が解決しません`
          );
        }
      }

      // その他のエラー
      throw new Error(
        `プローブ追加失敗 HTTP ${addResult.response.status}: ${
          addResult.body?.message ?? ""
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

  if (!afterAddSha) {
    throw new Error("プローブ追加に失敗しました");
  }

  // ステップ3: _verificationProbe を削除してPUT（409/422時は最大3回再試行）
  // 追加PUTから削除PUTまでの間に他プロセス（recordObservedIds等）による並行更新が
  // 入る可能性があるため、削除PUT実行前に必ず最新状態を再取得し、その最新内容から
  // _verificationProbe フィールドだけを取り除く（他フィールドは保持する）
  const latestBeforeDelete = await fetchLatestState();
  let deleteSha = latestBeforeDelete.sha;
  let deleteContent = latestBeforeDelete.currentState;
  delete deleteContent._verificationProbe;
  let afterDeleteSha;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const deleteBody = {
        message: "chore: remove verification probe",
        content: toBase64Json(deleteContent),
        branch: baseBranch,
        sha: deleteSha,
      };

      const deleteResult = await requestJson(fetchFn, writeUrl, {
        method: "PUT",
        headers: buildHeaders(githubToken),
        body: JSON.stringify(deleteBody),
      });

      // 200/201 = 成功
      if (deleteResult.response.status === 200 || deleteResult.response.status === 201) {
        afterDeleteSha = deleteResult.body?.commit?.sha;
        if (!afterDeleteSha) {
          throw new Error("プローブ削除後のSHAが取得できません");
        }

        // 削除後のSHA変化を確認
        if (afterDeleteSha === deleteSha) {
          throw new Error(
            "プローブ削除後、SHAが変化していません（削除が反映されていない可能性）"
          );
        }

        break; // 成功
      }

      // 409/422 = SHA競合（再試行対象）
      if (deleteResult.response.status === 409 || deleteResult.response.status === 422) {
        // 再試行時は最新SHAを再取得
        if (attempt < MAX_RETRIES) {
          const latest = await fetchLatestState();
          deleteSha = latest.sha;
          deleteContent = latest.currentState;
          delete deleteContent._verificationProbe;
          continue; // 次の試行へ
        } else {
          // 3回再試行後も失敗 → 例外を投げる
          throw new Error(
            `プローブ削除失敗: ${MAX_RETRIES}回の再試行後も競合状態が解決しません`
          );
        }
      }

      // その他のエラー
      throw new Error(
        `プローブ削除失敗 HTTP ${deleteResult.response.status}: ${
          deleteResult.body?.message ?? ""
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

  if (!afterDeleteSha) {
    throw new Error("プローブ削除に失敗しました");
  }

  return { success: true };
}
