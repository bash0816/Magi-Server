// npm publishフロー(@candidate→@latest)の判定ロジック。
// GitHub Actions YAML(npm-package.yml)から呼び出される薄いCLIラッパー
// (npm-publish-policy-cli.mjs)の裏側。副作用なし・純粋関数のみでテスト可能にする。
// 詳細: magi-system側 .codex-review/npm_publish_flow_redesign_design.md

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * dispatch元run(Magi-System側 publish-magi-server.yml)のmetadataを検証する。
 * @staging中間タグを廃止し main ビルドのみを受け付ける(条件1)。
 * head_sha が Magi-System の main 先端と一致することも要求する(条件3, stale run再利用防止)。
 */
export function verifyRunMetadata({ workflowName, workflowPath, event, conclusion, branch, headSha, mainSha }) {
  const errors = [];
  if (workflowName !== "Publish Magi Server") {
    errors.push(`Unexpected workflow name: ${workflowName}`);
  }
  if (workflowPath !== ".github/workflows/publish-magi-server.yml") {
    errors.push(`Unexpected workflow path: ${workflowPath}`);
  }
  if (event !== "workflow_dispatch") {
    errors.push(`Unexpected event: ${event}`);
  }
  if (conclusion !== "success") {
    errors.push(`Run did not succeed: ${conclusion}`);
  }
  if (branch !== "main") {
    errors.push(`Unexpected branch: ${branch} (expected: main)`);
  }
  if (headSha !== mainSha) {
    errors.push(
      `head_sha (${headSha}) does not match current Magi-System main (${mainSha}). ` +
        `The build run is stale (main has advanced since this build). Re-run the build workflow.`,
    );
  }
  return { ok: errors.length === 0, errors };
}

/** 厳密な正式版セマンティックバージョン(X.Y.Z、prereleaseは非対応)かを判定する。 */
export function isStrictSemver(version) {
  return typeof version === "string" && SEMVER_RE.test(version);
}

/** X.Y.Z形式の2つのバージョンを比較する。isStrictSemverで検証済みの入力を前提とする。 */
export function compareSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return "gt";
    if (pa[i] < pb[i]) return "lt";
  }
  return "eq";
}

/**
 * publish対象versionが@candidateへのダウングレードでないことを検証する。
 * 条件2: prereleaseは許容しない(正式版X.Y.Zのみ)。旧promote-staging-to-candidate.ymlの
 * ダウングレード防止チェックの移植 + semver形式検証の追加。
 */
export function verifyCandidateVersion({ version, currentCandidate }) {
  const errors = [];
  if (!isStrictSemver(version)) {
    errors.push(`Invalid semver (prerelease not supported): ${version}`);
    return { ok: false, errors };
  }
  if (currentCandidate) {
    if (!isStrictSemver(currentCandidate)) {
      errors.push(`Invalid semver for current @candidate tag: ${currentCandidate}`);
      return { ok: false, errors };
    }
    const cmp = compareSemver(version, currentCandidate);
    if (cmp === "lt") {
      errors.push(`Would downgrade @candidate from ${currentCandidate} to ${version}`);
    } else if (cmp === "eq") {
      // STEP8レビュー指摘: npm publishは同一バージョンを再publishできず失敗する。
      // 「冪等に許可」は実運用と不整合なため明示的に拒否し、PATCHバンプを促す。
      errors.push(`Version ${version} is already published as @candidate. Bump the version (PATCH or higher) before publishing again.`);
    }
  }
  return { ok: errors.length === 0, errors };
}
