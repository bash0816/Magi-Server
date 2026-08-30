#!/usr/bin/env node
// npm-publish-policy.mjs の薄いCLIラッパー。GitHub Actions(npm-package.yml)から
// `node scripts/npm-publish-policy-cli.mjs <command> --key=value ...`の形式で呼ばれる。
// 判定結果を::error::行として出力しexit codeで成否を返す。ロジック本体は
// npm-publish-policy.mjs 側でユニットテスト済み、ここでは配線のみ担う。

import { verifyRunMetadata, verifyCandidateVersion } from "./npm-publish-policy.mjs";

function parseArgs(argv) {
  const opts = {};
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)=([\s\S]*)$/);
    if (m) opts[m[1]] = m[2];
  }
  return opts;
}

function reportAndExit(result) {
  if (!result.ok) {
    for (const e of result.errors) {
      console.error(`::error::${e}`);
    }
    process.exit(1);
  }
}

const [, , command, ...rest] = process.argv;
const opts = parseArgs(rest);

if (command === "verify-run") {
  const result = verifyRunMetadata({
    workflowName: opts["workflow-name"],
    workflowPath: opts["workflow-path"],
    event: opts["event"],
    conclusion: opts["conclusion"],
    branch: opts["branch"],
    headSha: opts["head-sha"],
    mainSha: opts["main-sha"],
  });
  reportAndExit(result);
  console.log(
    `Run authenticity verified: ${opts["workflow-name"]} (branch=${opts["branch"]}, head_sha=${opts["head-sha"]})`,
  );
} else if (command === "verify-candidate-version") {
  const result = verifyCandidateVersion({
    version: opts["version"],
    currentCandidate: opts["current-candidate"] || undefined,
  });
  reportAndExit(result);
  console.log(`candidate version check OK: ${opts["version"]} (current: ${opts["current-candidate"] || "none"})`);
} else {
  console.error(`::error::Unknown command: ${command}. Expected: verify-run | verify-candidate-version`);
  process.exit(1);
}
