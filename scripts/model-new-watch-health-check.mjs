#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  reportSyncFailure,
  reportSyncSuccess,
} from "./sync-models-json-health-check.mjs";

const DEFAULT_ISSUE_TITLE = "[model-new-watch] 実行失敗";

function buildModelNewWatchFailureBody({ failureMessage, runUrl, failedProviders }) {
  const lines = [
    "モデル新規検知処理が失敗しました。",
    "",
    `- failure: ${failureMessage || "unknown"}`,
  ];

  if (failedProviders && failedProviders.length > 0) {
    lines.push(`- failed providers: ${failedProviders.join(", ")}`);
  }

  if (runUrl) {
    lines.push(`- run: ${runUrl}`);
  }

  return lines.join("\n");
}

export async function reportModelNewWatchFailure(deps = {}) {
  const { failedProviders, failureMessage: customFailureMessage, runUrl } = deps;

  // failedProviders が存在する場合、カスタムの本文ビルダーを使う
  const customBody = buildModelNewWatchFailureBody({
    failureMessage: customFailureMessage ?? "モデル新規検知処理が失敗しました",
    runUrl,
    failedProviders,
  });

  return reportSyncFailure({
    ...deps,
    issueTitle: DEFAULT_ISSUE_TITLE,
    failureMessage: customBody,
    runUrl: undefined, // runUrl は customBody に統合済みなので、重複を避ける
  });
}

export async function reportModelNewWatchSuccess(deps = {}) {
  return reportSyncSuccess({
    ...deps,
    issueTitle: DEFAULT_ISSUE_TITLE,
  });
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
    if (mode === "failure") {
      const result = await reportModelNewWatchFailure({
        ...deps,
        fetchFn,
        githubToken,
        openIssues,
        failureMessage: env.MODEL_NEW_WATCH_FAILURE_MESSAGE ?? deps.failureMessage,
        runUrl: env.MODEL_NEW_WATCH_RUN_URL ?? deps.runUrl,
      });
      logger.log(`[model-new-watch-health-check] ${result.action}`);
      return 0;
    }

    if (mode === "success") {
      const result = await reportModelNewWatchSuccess({
        ...deps,
        fetchFn,
        githubToken,
        openIssues,
      });
      logger.log(`[model-new-watch-health-check] ${result.action}`);
      return 0;
    }

    logger.error('[model-new-watch-health-check] mode は "success" または "failure" を指定してください');
    return 1;
  } catch (error) {
    logger.error(`[model-new-watch-health-check] ${error?.message ?? error}`);
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