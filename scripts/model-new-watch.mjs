#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { createModelUpdatePr as defaultCreateModelUpdatePr } from "./create-model-update-pr.mjs";
import { detectNewModels as defaultDetectNewModels, readRepoModelsJson as defaultReadRepoModelsJson } from "./detect-new-models.mjs";
import { notifyNeedsReview as defaultNotifyNeedsReview } from "./model-watch-needs-review.mjs";
import { readState as defaultReadState, recordObservedIds as defaultRecordObservedIds, writeVerificationProbe as defaultWriteVerificationProbe } from "./model-watch-state.mjs";
import { reportModelNewWatchFailure as defaultReportFailure, reportModelNewWatchSuccess as defaultReportSuccess } from "./model-new-watch-health-check.mjs";

function buildDetectedInput(results, models) {
  const updatedModelsJson = models && typeof models === "object" ? structuredClone(models) : {};
  if (!updatedModelsJson.providers || typeof updatedModelsJson.providers !== "object") updatedModelsJson.providers = {};
  const newIds = [];
  const geminiNeedsReview = [];
  for (const result of results) {
    const entries = result.candidates?.autoAdd ?? [];
    const providerModels = Array.isArray(updatedModelsJson.providers[result.provider]?.models) ? updatedModelsJson.providers[result.provider].models : [];
    const existing = new Set(providerModels.map(model => model?.id));
    updatedModelsJson.providers[result.provider] = { ...(updatedModelsJson.providers[result.provider] ?? {}), models: [...entries.filter(entry => entry?.id && !existing.has(entry.id)), ...providerModels] };
    for (const entry of entries) if (entry?.id && !newIds.includes(entry.id)) newIds.push(entry.id);
    if (result.provider === "gemini") for (const id of result.candidates?.needsReview ?? []) if (!geminiNeedsReview.includes(id)) geminiNeedsReview.push(id);
  }
  return { hasNew: true, newIds, updatedModelsJson, geminiNeedsReview };
}

export async function main(inputDeps = {}) {
  let deps = inputDeps, state, currentModelsJson, results;
  const env = deps.env ?? process.env;
  deps = { ...deps, env, openaiApiKey: deps.openaiApiKey ?? env.OPENAI_API_KEY, geminiApiKey: deps.geminiApiKey ?? env.GEMINI_API_KEY, githubToken: deps.githubToken ?? env.GITHUB_TOKEN };

  // PROBE_ONLY モード: 検証プローブのみを実行
  if (env.PROBE_ONLY === "true") {
    const writeVerificationProbe = deps.writeVerificationProbe ?? defaultWriteVerificationProbe;
    const reportSuccess = deps.reportModelNewWatchSuccess ?? defaultReportSuccess;
    try {
      await writeVerificationProbe(deps);
      await reportSuccess(deps);
      return;
    } catch (error) {
      throw error;
    }
  }

  // 通常のモデル検知フロー
  const readState = deps.readState ?? defaultReadState;
  const readRepoModelsJson = deps.readRepoModelsJson ?? defaultReadRepoModelsJson;
  const detectNewModels = deps.detectNewModels ?? defaultDetectNewModels;
  const recordObservedIds = deps.recordObservedIds ?? defaultRecordObservedIds;
  const createModelUpdatePr = deps.createModelUpdatePr ?? defaultCreateModelUpdatePr;
  const notifyNeedsReview = deps.notifyNeedsReview ?? defaultNotifyNeedsReview;
  const reportFailure = deps.reportModelNewWatchFailure ?? defaultReportFailure;
  const reportSuccess = deps.reportModelNewWatchSuccess ?? defaultReportSuccess;
  try {
    state = await readState(deps);
    currentModelsJson = await readRepoModelsJson(deps);
    results = await detectNewModels({ ...deps, state, currentModelsJson });
  } catch (initError) {
    try { await reportFailure({ ...deps, failedProviders: ["__orchestrator_init__"], failureMessage: initError?.message ?? String(initError) }); }
    catch (reportError) { (deps.console ?? console).error("[model-new-watch] health check reporting failed after init error", reportError); }
    process.exitCode = 1;
    return;
  }
  const failedProviders = results.filter(result => result.status === "error").map(result => result.provider);
  const openaiEarly = results.find(result => result.provider === "openai");
  if (openaiEarly?.status === "success" && openaiEarly.observedIdsToRecord?.length > 0) {
    try { await recordObservedIds("openai", openaiEarly.observedIdsToRecord, { ...deps, state }); } catch { failedProviders.push("openai"); }
  }
  const autoAddResults = results.filter(result => result.status === "success" && (result.candidates?.autoAdd?.length ?? 0) > 0);
  let prSucceeded = false;
  if (autoAddResults.length > 0) {
    try { await createModelUpdatePr({ ...deps, detected: buildDetectedInput(autoAddResults, currentModelsJson) }); prSucceeded = true; }
    catch { failedProviders.push(...autoAddResults.map(result => result.provider)); }
  }
  if (prSucceeded) {
    const openaiResult = results.find(result => result.provider === "openai");
    if (openaiResult?.status === "success" && openaiResult.candidates.autoAdd.length > 0) {
      try { await recordObservedIds("openai", openaiResult.candidates.autoAdd.map(model => model.id), { ...deps, state }); } catch { failedProviders.push("openai"); }
    }
  }
  for (const provider of ["gemini", "claude"]) {
    const result = results.find(item => item.provider === provider);
    if (result?.status === "success" && (result.candidates?.needsReview?.length ?? 0) > 0) {
      try { const outcome = await notifyNeedsReview(provider, result.candidates?.needsReview ?? [], { ...deps, state }); if (outcome?.stateUpdateFailed) failedProviders.push(provider); }
      catch { failedProviders.push(provider); }
    }
  }
  if (failedProviders.length > 0) { await reportFailure({ ...deps, failedProviders: [...new Set(failedProviders)] }); process.exitCode = 1; }
  else await reportSuccess(deps);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => { console.error("[model-new-watch] " + (error?.message ?? error)); process.exitCode = 1; });
