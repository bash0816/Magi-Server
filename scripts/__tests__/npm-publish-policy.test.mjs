import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  verifyRunMetadata,
  verifyCandidateVersion,
  isStrictSemver,
  compareSemver,
} from "../npm-publish-policy.mjs";

const VALID_RUN = {
  workflowName: "Publish Magi Server",
  workflowPath: ".github/workflows/publish-magi-server.yml",
  event: "workflow_dispatch",
  conclusion: "success",
  branch: "main",
  headSha: "abc123",
  mainSha: "abc123",
};

describe("verifyRunMetadata", () => {
  it("main かつ SHA一致なら許可する", () => {
    const result = verifyRunMetadata(VALID_RUN);
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
  });

  it("staging ブランチは拒否する", () => {
    const result = verifyRunMetadata({ ...VALID_RUN, branch: "staging" });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /Unexpected branch: staging/);
  });

  it("head_sha が main SHA と不一致なら拒否する(stale run再利用防止)", () => {
    const result = verifyRunMetadata({ ...VALID_RUN, headSha: "old-sha", mainSha: "new-sha" });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /does not match current Magi-System main/);
  });

  it("workflow名が不一致なら拒否する(なりすまし防止)", () => {
    const result = verifyRunMetadata({ ...VALID_RUN, workflowName: "Evil Workflow" });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /Unexpected workflow name/);
  });

  it("workflowPathが不一致なら拒否する", () => {
    const result = verifyRunMetadata({ ...VALID_RUN, workflowPath: ".github/workflows/evil.yml" });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /Unexpected workflow path/);
  });

  it("eventがworkflow_dispatch以外なら拒否する", () => {
    const result = verifyRunMetadata({ ...VALID_RUN, event: "push" });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /Unexpected event/);
  });

  it("conclusionがsuccess以外なら拒否する", () => {
    const result = verifyRunMetadata({ ...VALID_RUN, conclusion: "failure" });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /Run did not succeed/);
  });

  it("複数条件が同時に不一致な場合は全エラーを列挙する", () => {
    const result = verifyRunMetadata({ ...VALID_RUN, branch: "staging", headSha: "x", mainSha: "y" });
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 2);
  });
});

describe("isStrictSemver", () => {
  it("X.Y.Z形式は真", () => {
    assert.equal(isStrictSemver("0.36.1"), true);
    assert.equal(isStrictSemver("1.0.0"), true);
  });

  it("prerelease(0.36.0-beta.1)は偽", () => {
    assert.equal(isStrictSemver("0.36.0-beta.1"), false);
  });

  it("不正な形式は偽", () => {
    assert.equal(isStrictSemver("v1.0.0"), false);
    assert.equal(isStrictSemver("1.0"), false);
    assert.equal(isStrictSemver(""), false);
    assert.equal(isStrictSemver(undefined), false);
  });
});

describe("compareSemver", () => {
  it("大小関係を正しく判定する", () => {
    assert.equal(compareSemver("0.36.1", "0.36.0"), "gt");
    assert.equal(compareSemver("0.36.0", "0.36.1"), "lt");
    assert.equal(compareSemver("0.36.1", "0.36.1"), "eq");
    assert.equal(compareSemver("1.0.0", "0.99.99"), "gt");
  });
});

describe("verifyCandidateVersion", () => {
  it("既存candidateがない場合は正式版なら常に許可する", () => {
    const result = verifyCandidateVersion({ version: "0.36.1", currentCandidate: undefined });
    assert.equal(result.ok, true);
  });

  it("既存candidateより新しいバージョンは許可する", () => {
    const result = verifyCandidateVersion({ version: "0.36.1", currentCandidate: "0.35.2" });
    assert.equal(result.ok, true);
  });

  it("既存candidateと同一バージョンは許可する(冪等)", () => {
    const result = verifyCandidateVersion({ version: "0.36.1", currentCandidate: "0.36.1" });
    assert.equal(result.ok, true);
  });

  it("既存candidateより古いバージョンは拒否する(ダウングレード防止)", () => {
    const result = verifyCandidateVersion({ version: "0.35.2", currentCandidate: "0.36.1" });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /Would downgrade @candidate/);
  });

  it("prerelease版はcandidateより新しくても拒否する(条件2: terra指摘の再発防止)", () => {
    // 0.36.0-beta.1 は Number()比較だとNaNになり、旧実装ではダウングレード判定を
    // すり抜けて誤って古いcandidateを通してしまう可能性があった。
    const result = verifyCandidateVersion({ version: "0.36.0-beta.1", currentCandidate: "0.35.2" });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /Invalid semver \(prerelease not supported\)/);
  });

  it("既存candidate自体が不正なsemverなら安全側に拒否する", () => {
    const result = verifyCandidateVersion({ version: "0.36.1", currentCandidate: "not-a-version" });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /Invalid semver for current @candidate tag/);
  });
});
