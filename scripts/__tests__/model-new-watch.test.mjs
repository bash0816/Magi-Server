import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { main } from '../model-new-watch.mjs'

const result = (provider = 'openai', extra = {}) => ({
  provider, status: 'success', candidates: { autoAdd: [], needsReview: [] }, ...extra,
})

describe('model-new-watch main(deps)', () => {
  let deps
  let calls

  beforeEach(() => {
    calls = []
    deps = {
      env: {},
      readState: async (d) => { calls.push(['readState', d]); return {} },
      readRepoModelsJson: async (d) => { calls.push(['readRepoModelsJson', d]); return {} },
      detectNewModels: async (d) => { calls.push(['detectNewModels', d]); return [] },
      recordObservedIds: async (provider, ids, d) => { calls.push(['recordObservedIds', provider, ids, d]) },
      createModelUpdatePr: async (d) => { calls.push(['createModelUpdatePr', d]) },
      notifyNeedsReview: async (provider, ids, d) => { calls.push(['notifyNeedsReview', provider, ids, d]); return { status: 'success' } },
      reportModelNewWatchFailure: async (d) => { calls.push(['reportModelNewWatchFailure', d]) },
      reportModelNewWatchSuccess: async (d) => { calls.push(['reportModelNewWatchSuccess', d]) },
    }
  })

  afterEach(() => { process.exitCode = undefined })
  const run = () => main(deps)
  const failure = () => calls.find(([name]) => name === 'reportModelNewWatchFailure')
  const records = () => calls.filter(([name]) => name === 'recordObservedIds')

  describe('step 0: env to deps', () => {
    test('OPENAI_API_KEY is mapped to openaiApiKey', async () => {
      deps.env = { OPENAI_API_KEY: 'env-openai' }
      await run()
      assert.equal(calls[0][1].openaiApiKey, 'env-openai')
    })
    test('directly injected openaiApiKey takes precedence over env', async () => {
      deps.env = { OPENAI_API_KEY: 'env-openai' }
      deps.openaiApiKey = 'injected-openai'
      await run()
      assert.equal(calls[0][1].openaiApiKey, 'injected-openai')
    })
    test('GEMINI_API_KEY and GITHUB_TOKEN reach downstream calls', async () => {
      deps.env = { GEMINI_API_KEY: 'env-gemini', GITHUB_TOKEN: 'env-github' }
      await run()
      for (const d of [calls[0][1], calls[2][1], calls.at(-1)[1]]) {
        assert.equal(d.geminiApiKey, 'env-gemini')
        assert.equal(d.githubToken, 'env-github')
      }
    })
  })

  describe('steps 1 / 1.5 / 2: initialization boundary', () => {
    test('readState failure reports __orchestrator_init__ and sets exitCode', async () => {
      deps.readState = async () => { throw new Error('state unavailable') }
      await run()
      assert.deepEqual(failure()[1].failedProviders, ['__orchestrator_init__'])
      assert.equal(process.exitCode, 1)
    })
    test('readRepoModelsJson failure reports __orchestrator_init__', async () => {
      deps.readRepoModelsJson = async () => { throw new Error('models.json invalid') }
      await run()
      assert.deepEqual(failure()[1].failedProviders, ['__orchestrator_init__'])
      assert.equal(process.exitCode, 1)
    })
    test('detectNewModels failure reports __orchestrator_init__', async () => {
      deps.detectNewModels = async () => { throw new Error('provider API failed') }
      await run()
      assert.deepEqual(failure()[1].failedProviders, ['__orchestrator_init__'])
      assert.equal(process.exitCode, 1)
    })
    test('readRepoModelsJson result is passed as currentModelsJson', async () => {
      const currentModelsJson = { providers: { openai: { models: [{ id: 'gpt-4' }] } } }
      deps.readRepoModelsJson = async () => currentModelsJson
      let detectedDeps
      deps.detectNewModels = async (d) => { detectedDeps = d; return [] }
      await run()
      assert.strictEqual(detectedDeps.currentModelsJson, currentModelsJson)
    })
    test('step 7 failure propagates without an init failure report', async () => {
      const error = new Error('health check failed')
      deps.reportModelNewWatchSuccess = async () => { throw error }
      await assert.rejects(run(), (actual) => actual === error)
      assert.equal(calls.filter(([name]) => name === 'reportModelNewWatchFailure').length, 0)
    })
  })

  describe('step 3.5: early OpenAI observed-id recording', () => {
    test('observedIdsToRecord is recorded before PR creation', async () => {
      const order = []
      const recordedIds = []
      deps.detectNewModels = async () => [result('openai', { observedIdsToRecord: ['baseline', 'denylisted'], candidates: { autoAdd: [{ id: 'gpt-new' }], needsReview: [] } })]
      deps.recordObservedIds = async (provider, ids) => {
        order.push('record')
        assert.equal(provider, 'openai')
        recordedIds.push(ids)
      }
      deps.createModelUpdatePr = async () => { order.push('pr') }
      await run()
      // observedIdsToRecord(denylist該当分)の記録(ステップ3.5)はPR作成の成否と無関係に
      // 即座に行われ、同じ結果にcandidates.autoAdd(denylist非該当の新規候補)が含まれる
      // 場合はPR作成(ステップ4)も別途行われ、PR成功後に改めてautoAdd候補IDが記録される
      // (ステップ5)。design.md「単一オーケストレーター方式」節ステップ3.5・4・5は独立
      assert.deepEqual(order, ['record', 'pr', 'record'])
      assert.deepEqual(recordedIds, [['baseline', 'denylisted'], ['gpt-new']])
    })
    test('an initial baseline records all returned IDs', async () => {
      deps.detectNewModels = async () => [result('openai', { observedIdsToRecord: ['model-a', 'model-b'] })]
      await run()
      assert.deepEqual(records().map(([, provider, ids]) => [provider, ids]), [['openai', ['model-a', 'model-b']]])
    })
    test('early recording failure is aggregated and health reporting still runs', async () => {
      deps.detectNewModels = async () => [result('openai', { observedIdsToRecord: ['model-a'] })]
      deps.recordObservedIds = async () => { throw new Error('state write forbidden') }
      await run()
      assert.deepEqual(failure()[1].failedProviders, ['openai'])
      assert.equal(process.exitCode, 1)
    })
  })

  describe('steps 4 / 5: PR and post-success OpenAI recording', () => {
    test('autoAdd IDs are recorded only after PR creation succeeds', async () => {
      const order = []
      deps.detectNewModels = async () => [result('openai', { candidates: { autoAdd: [{ id: 'gpt-new-1' }, { id: 'gpt-new-2' }], needsReview: [] } })]
      deps.createModelUpdatePr = async () => { order.push('pr') }
      deps.recordObservedIds = async (provider, ids) => {
        order.push('record')
        assert.equal(provider, 'openai')
        assert.deepEqual(ids, ['gpt-new-1', 'gpt-new-2'])
      }
      await run()
      assert.deepEqual(order, ['pr', 'record'])
    })
    test('PR failure does not record autoAdd IDs', async () => {
      deps.detectNewModels = async () => [result('openai', { candidates: { autoAdd: [{ id: 'gpt-new' }], needsReview: [] } })]
      deps.createModelUpdatePr = async () => { throw new Error('PR failed') }
      await run()
      assert.equal(records().length, 0)
      assert.deepEqual(failure()[1].failedProviders, ['openai'])
    })
    test('after a failed PR, a subsequent run still does not record the candidate', async () => {
      deps.detectNewModels = async () => [result('openai', { candidates: { autoAdd: [{ id: 'gpt-new' }], needsReview: [] } })]
      deps.createModelUpdatePr = async (d) => { calls.push(['createModelUpdatePr', d]); throw new Error('PR failed') }
      await run()
      assert.equal(records().length, 0)
      calls.length = 0
      process.exitCode = undefined
      await run()
      assert.equal(records().length, 0)
      assert.equal(calls.filter(([name]) => name === 'createModelUpdatePr').length, 1)
    })
  })

  describe('step 6: review notifications and isolation', () => {
    test('PR failure does not prevent another provider notification', async () => {
      deps.detectNewModels = async () => [
        result('openai', { candidates: { autoAdd: [{ id: 'gpt-new' }], needsReview: [] } }),
        result('claude', { candidates: { autoAdd: [], needsReview: ['claude-new'] } }),
      ]
      deps.createModelUpdatePr = async () => { throw new Error('PR failed') }
      await run()
      assert.equal(calls.filter(([name, provider]) => name === 'notifyNeedsReview' && provider === 'claude').length, 1)
    })
    test('notification exception adds that provider to failedProviders', async () => {
      deps.detectNewModels = async () => [result('gemini', { candidates: { autoAdd: [], needsReview: ['gemini-new'] } })]
      deps.notifyNeedsReview = async () => { throw new Error('issue failed') }
      await run()
      assert.deepEqual(failure()[1].failedProviders, ['gemini'])
    })
    test('stateUpdateFailed is treated as a provider failure', async () => {
      deps.detectNewModels = async () => [result('claude', { candidates: { autoAdd: [], needsReview: ['claude-new'] } })]
      deps.notifyNeedsReview = async () => ({ status: 'success', stateUpdateFailed: true })
      await run()
      assert.deepEqual(failure()[1].failedProviders, ['claude'])
    })
    test('one notification failure does not stop the next provider', async () => {
      deps.detectNewModels = async () => [
        result('gemini', { candidates: { autoAdd: [], needsReview: ['gemini-new'] } }),
        result('claude', { candidates: { autoAdd: [], needsReview: ['claude-new'] } }),
      ]
      deps.notifyNeedsReview = async (provider, ids, d) => {
        calls.push(['notifyNeedsReview', provider, ids, d])
        if (provider === 'gemini') throw new Error('gemini failed')
        return { status: 'success' }
      }
      await run()
      assert.deepEqual(calls.filter(([name]) => name === 'notifyNeedsReview').map(([, provider]) => provider), ['gemini', 'claude'])
      assert.deepEqual(failure()[1].failedProviders, ['gemini'])
    })
  })

  describe('step 7 and failure aggregation', () => {
    test('provider error reports failure and sets process.exitCode', async () => {
      deps.detectNewModels = async () => [{ provider: 'openai', status: 'error', error: 'rate limited' }]
      await run()
      assert.deepEqual(failure()[1].failedProviders, ['openai'])
      assert.equal(process.exitCode, 1)
    })
    test('all providers succeeding reports success', async () => {
      deps.detectNewModels = async () => [result('openai'), result('gemini'), result('claude')]
      await run()
      assert.equal(calls.filter(([name]) => name === 'reportModelNewWatchSuccess').length, 1)
      assert.equal(calls.filter(([name]) => name === 'reportModelNewWatchFailure').length, 0)
    })
    test('failure reporting itself propagates without an init report', async () => {
      deps.detectNewModels = async () => [{ provider: 'openai', status: 'error', error: 'API failed' }]
      const error = new Error('failure report failed')
      deps.reportModelNewWatchFailure = async (d) => { calls.push(['reportModelNewWatchFailure', d]); throw error }
      await assert.rejects(run(), (actual) => actual === error)
      assert.equal(calls.filter(([name]) => name === 'reportModelNewWatchFailure').length, 1)
    })
    test('duplicate failures for one provider are removed', async () => {
      deps.detectNewModels = async () => [result('openai', { observedIdsToRecord: ['id'], candidates: { autoAdd: [{ id: 'new' }], needsReview: [] } })]
      deps.recordObservedIds = async () => { throw new Error('state failed') }
      deps.createModelUpdatePr = async () => { throw new Error('PR failed') }
      await run()
      assert.deepEqual(failure()[1].failedProviders, ['openai'])
    })
    test('all failed providers are retained', async () => {
      deps.detectNewModels = async () => [
        { provider: 'openai', status: 'error', error: 'openai failed' },
        { provider: 'gemini', status: 'error', error: 'gemini failed' },
        result('claude'),
      ]
      await run()
      assert.deepEqual(failure()[1].failedProviders, ['openai', 'gemini'])
    })
    test('Gemini autoAdd candidates reach PR creation without review notification', async () => {
      deps.detectNewModels = async () => [result('gemini', { candidates: { autoAdd: [{ id: 'gemini-new' }], needsReview: [] } })]
      await run()
      assert.equal(calls.filter(([name]) => name === 'createModelUpdatePr').length, 1)
      assert.equal(calls.filter(([name]) => name === 'notifyNeedsReview').length, 0)
    })
  })

  test('resolved env dependencies reach detection, PR creation, and success reporting', async () => {
    deps.env = { OPENAI_API_KEY: 'openai', GEMINI_API_KEY: 'gemini', GITHUB_TOKEN: 'github' }
    let detectedDeps
    let prDeps
    let successDeps
    deps.detectNewModels = async (d) => { detectedDeps = d; return [result('openai', { candidates: { autoAdd: [{ id: 'new' }], needsReview: [] } })] }
    deps.createModelUpdatePr = async (d) => { prDeps = d }
    deps.reportModelNewWatchSuccess = async (d) => { successDeps = d }
    await run()
    for (const received of [detectedDeps, prDeps, successDeps]) {
      assert.equal(received.openaiApiKey, 'openai')
      assert.equal(received.geminiApiKey, 'gemini')
      assert.equal(received.githubToken, 'github')
    }
  })
})
