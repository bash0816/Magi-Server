/**
 * Issue通知方式（新規、scripts/model-watch-needs-review.mjs）
 *
 * Gemini・Claude(Anthropic)の要確認候補向けIssue通知。
 * scripts/sync-models-json-health-check.mjs からexportされる
 * listOpenIssues/findIssue/createIssue/addComment を import して使う薄いラッパー。
 */

/**
 * 要確認候補をGitHub Issueで通知する
 *
 * 処理フロー:
 * 1. 今回取得した要確認候補と state.providers.{provider}.needsReviewNotified の差分（未通知分）を計算
 * 2. 差分が0件なら、Issue呼び出し・状態更新のいずれも行わない（noop）
 * 3. 差分が1件以上ある場合のみ、固定タイトルIssue（プロバイダーごとに別Issue）に対し、
 *    listOpenIssues → findIssue → createIssue or addComment パターンで通知
 * 4. Issue通知が成功した後にのみ、状態ファイルへ差分IDを追記
 * 5. Issue通知は成功したが状態更新が最終的に失敗した場合:
 *    {status: "success", stateUpdateFailed: true} を返す（例外は投げない）
 * 6. Issue通知自体が失敗した場合: 状態ファイルは更新せず、例外をthrowする
 *
 * @param {string} provider - プロバイダー名("gemini" | "claude")
 * @param {string[]} needsReviewIds - 今回取得した要確認候補ID一覧
 * @param {object} deps - 依存注入オブジェクト
 *   - state: 状態ファイル内容（{ version: 1, providers: { gemini?: { needsReviewNotified?: [...] }, ... } }）
 *   - listOpenIssues: async (deps) => Issue[] 関数
 *   - findIssue: async (deps, issues, title) => Issue | undefined 関数
 *   - createIssue: async (deps, title, body) => { number, html_url } 関数
 *   - addComment: async (deps, issueNumber, body) => { id } 関数
 *   - recordObservedIds: async (provider, ids, deps) => { success: true } 関数
 *   - githubToken: GitHub token 文字列
 * @returns {Promise<{status: "success" | "noop", stateUpdateFailed?: boolean}>}
 *   - {status: "noop"}: 差分0件
 *   - {status: "success"}: Issue通知・状態更新とも成功
 *   - {status: "success", stateUpdateFailed: true}: Issue成功・状態更新失敗
 * @throws {Error} Issue通知失敗時
 */
export async function notifyNeedsReview(provider, needsReviewIds, deps) {
  // 状態ファイルが存在しない場合は、通知対象を判定できないため noop
  if (!deps.state) {
    return { status: "noop" };
  }

  // 1. 差分計算: 今回の候補 vs 既に通知済みのID
  const notifiedIds = deps.state.providers?.[provider]?.needsReviewNotified ?? [];
  const unnotifiedIds = needsReviewIds.filter(id => !notifiedIds.includes(id));

  // 2. 差分0件なら noop
  if (unnotifiedIds.length === 0) {
    return { status: "noop" };
  }

  // 3. Issue通知: listOpenIssues → findIssue → createIssue or addComment
  const issueTitle = getIssueTitle(provider);

  // 3.1 既存Issueを検索
  const issues = await deps.listOpenIssues(deps);
  const existingIssue = await deps.findIssue(deps, issues, issueTitle);

  // 3.2 Issue本文（未通知ID一覧を記載）
  const issueBody = buildIssueBody(provider, unnotifiedIds);

  // 3.3 Issue作成またはコメント追加
  let issueNumber;
  if (!existingIssue) {
    // 既存Issueがない → 新規作成
    const createdIssue = await deps.createIssue(deps, issueTitle, issueBody);
    issueNumber = createdIssue.number;
  } else {
    // 既存Issueがある → コメント追加
    issueNumber = existingIssue.number;
    await deps.addComment(deps, issueNumber, issueBody);
  }

  // 4. Issue通知成功後にのみ、状態ファイルへ差分IDを追記
  try {
    await deps.recordObservedIds(provider, unnotifiedIds, deps);
    // 状態更新成功
    return { status: "success" };
  } catch (stateUpdateError) {
    // 状態更新失敗: Issue通知は成功しているため、stateUpdateFailed フラグでオーケストレーターに伝える
    return { status: "success", stateUpdateFailed: true };
  }
}

/**
 * プロバイダーごとのIssueタイトルを返す
 * @param {string} provider - プロバイダー名
 * @returns {string} Issue タイトル
 */
function getIssueTitle(provider) {
  const titles = {
    gemini: "[model-new-watch] Gemini要確認",
    claude: "[model-new-watch] Claude要確認",
  };
  return titles[provider] ?? `[model-new-watch] ${provider}要確認`;
}

/**
 * Issue本文を構築する
 * @param {string} provider - プロバイダー名
 * @param {string[]} unnotifiedIds - 未通知ID一覧
 * @returns {string} Issue本文
 */
function buildIssueBody(provider, unnotifiedIds) {
  const idList = unnotifiedIds.map(id => `- ${id}`).join("\n");
  return `以下のモデルが新規検出されました。確認後に手動で追加してください。\n\n${idList}`;
}
