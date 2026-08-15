#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const DEFAULT_REPO_OWNER = "bash0816";
const DEFAULT_REPO_NAME = "Magi-Server";
const DEFAULT_ISSUE_TITLE = "[sync-models-json] 実行失敗";
const GITHUB_API_BASE = "https://api.github.com";

function buildIssuesUrl(owner, repo) {
  return `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=open&per_page=100`;
}

function buildIssueUrl(owner, repo, number) {
  return `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`;
}

function buildCommentUrl(owner, repo, number) {
  return `${buildIssueUrl(owner, repo, number)}/comments`;
}

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

function extractMessage(body) {
  if (typeof body === "string") return body.trim();
  if (body && typeof body === "object") {
    return String(body.message ?? body.error ?? body.errors?.[0]?.message ?? JSON.stringify(body));
  }
  return "";
}

function createHttpError(label, status, body) {
  const detail = extractMessage(body);
  const suffix = detail ? `: ${detail}` : "";
  return new Error(`${label} HTTP ${status}${suffix}`);
}

function assertGitHubToken(githubToken) {
  if (!githubToken || typeof githubToken !== "string") {
    throw new Error("githubToken が必要です");
  }
}

async function requestJson(fetchFn, url, init) {
  const response = await fetchFn(url, init);
  const body = await readResponseBody(response);
  return { response, body };
}

function buildHeaders(githubToken) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${githubToken}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function normalizeIssues(openIssues) {
  return Array.isArray(openIssues) ? openIssues : null;
}

export function findIssue(openIssues, issueTitle) {
  return (openIssues ?? []).find((issue) =>
    issue &&
    issue.title === issueTitle &&
    issue.state === "open" &&
    !issue.pull_request &&  // PR ではなく真の Issue であること
    issue.user?.login === "github-actions[bot]"  // このワークフロー自身が作成したものであること
  ) ?? null;
}

function buildFailureBody({ failureMessage, runUrl }) {
  const lines = [
    "同期処理が失敗しました。",
    "",
    `- failure: ${failureMessage || "unknown"}`,
  ];
  if (runUrl) {
    lines.push(`- run: ${runUrl}`);
  }
  return lines.join("\n");
}

export async function listOpenIssues(deps) {
  const openIssues = normalizeIssues(deps.openIssues);
  if (openIssues) {
    return openIssues;
  }

  const { fetchFn, githubToken, repoOwner = DEFAULT_REPO_OWNER, repoName = DEFAULT_REPO_NAME } = deps;
  if (typeof fetchFn !== "function") {
    throw new Error("fetchFn が必要です");
  }
  assertGitHubToken(githubToken);

  let url = buildIssuesUrl(repoOwner, repoName);
  const allIssues = [];

  while (url) {
    const result = await requestJson(fetchFn, url, {
      method: "GET",
      headers: buildHeaders(githubToken),
    });

    if (result.response.status !== 200) {
      throw createHttpError("GitHub Issues 一覧取得", result.response.status, result.body);
    }

    if (Array.isArray(result.body)) {
      allIssues.push(...result.body);
    }

    // Link ヘッダーから次ページの URL を抽出（rel="next"を追跡）
    const link = typeof result.response.headers?.get === "function" ? result.response.headers.get("link") : null;
    const next = link?.match(/<([^>]+)>;\s*rel="next"/i);
    url = next?.[1] ?? null;
  }

  return allIssues;
}

export async function createIssue(deps, body) {
  const { fetchFn, githubToken, repoOwner = DEFAULT_REPO_OWNER, repoName = DEFAULT_REPO_NAME } = deps;
  const result = await requestJson(fetchFn, `${GITHUB_API_BASE}/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/issues`, {
    method: "POST",
    headers: {
      ...buildHeaders(githubToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (result.response.status !== 200 && result.response.status !== 201) {
    throw createHttpError("GitHub Issue 作成", result.response.status, result.body);
  }

  return result.body ?? {};
}

export async function addComment(deps, issueNumber, body) {
  const { fetchFn, githubToken, repoOwner = DEFAULT_REPO_OWNER, repoName = DEFAULT_REPO_NAME } = deps;
  const result = await requestJson(fetchFn, buildCommentUrl(repoOwner, repoName, issueNumber), {
    method: "POST",
    headers: {
      ...buildHeaders(githubToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  });

  if (result.response.status !== 200 && result.response.status !== 201) {
    throw createHttpError("GitHub Issue コメント追加", result.response.status, result.body);
  }

  return result.body ?? {};
}

export async function closeIssue(deps, issueNumber) {
  const { fetchFn, githubToken, repoOwner = DEFAULT_REPO_OWNER, repoName = DEFAULT_REPO_NAME } = deps;
  const result = await requestJson(fetchFn, buildIssueUrl(repoOwner, repoName, issueNumber), {
    method: "PATCH",
    headers: {
      ...buildHeaders(githubToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ state: "closed" }),
  });

  if (result.response.status !== 200) {
    throw createHttpError("GitHub Issue クローズ", result.response.status, result.body);
  }

  return result.body ?? {};
}

export async function reportSyncFailure(deps = {}) {
  const {
    githubToken,
    issueTitle = DEFAULT_ISSUE_TITLE,
    failureMessage = "同期処理が失敗しました",
    runUrl,
  } = deps;

  const openIssues = await listOpenIssues(deps);
  const existingIssue = findIssue(openIssues, issueTitle);
  const body = buildFailureBody({ failureMessage, runUrl });

  if (existingIssue) {
    await addComment({ ...deps, githubToken }, existingIssue.number, body);
    return { action: "commented", issueNumber: existingIssue.number };
  }

  const created = await createIssue(
    { ...deps, githubToken },
    {
      title: issueTitle,
      body,
    },
  );

  return {
    action: "created",
    issueNumber: created.number ?? null,
    issueUrl: created.html_url ?? null,
  };
}

export async function reportSyncSuccess(deps = {}) {
  const { githubToken, issueTitle = DEFAULT_ISSUE_TITLE } = deps;
  const openIssues = await listOpenIssues(deps);
  const existingIssue = findIssue(openIssues, issueTitle);

  if (!existingIssue) {
    return { action: "noop" };
  }

  await closeIssue({ ...deps, githubToken }, existingIssue.number);
  return { action: "closed", issueNumber: existingIssue.number };
}

export async function main(deps = {}) {
  const {
    env = process.env,
    console: logger = console,
    fetchFn = globalThis.fetch,
    openIssues,
  } = deps;

  const mode = String(deps.mode ?? process.argv[2] ?? "").trim();
  const githubToken = env.GITHUB_TOKEN;

  try {
    if (mode === "success") {
      const result = await reportSyncSuccess({ ...deps, fetchFn, githubToken, openIssues });
      logger.log(`[sync-models-json-health-check] ${result.action}`);
      return 0;
    }

    if (mode === "failure") {
      const result = await reportSyncFailure({
        ...deps,
        fetchFn,
        githubToken,
        openIssues,
        failureMessage: env.SYNC_MODELS_JSON_FAILURE_MESSAGE ?? deps.failureMessage,
      });
      logger.log(`[sync-models-json-health-check] ${result.action}`);
      return 0;
    }

    logger.error('[sync-models-json-health-check] mode は "success" または "failure" を指定してください');
    return 1;
  } catch (error) {
    logger.error(`[sync-models-json-health-check] ${error?.message ?? error}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((exitCode) => {
      process.exit(exitCode);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
