import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuditorBackend, selectAuditorBackend } from '../src/core/auditor-backend.mjs';
import { createJevAuditorBackend, resolveJevApiKey, JEV_MODEL } from '../src/core/jev-backend.mjs';
import { projectBackendFailure } from '../src/hooks/parent-output-projector.mjs';
import { createCodexCliAuditorBackend } from '../src/core/codex-cli-backend.mjs';
import { createHaikuAuditorBackend } from '../src/core/auditor-backend.mjs';
import { runAuditorModelMatrixCommand } from '../src/cli/auditor-model-matrix-cmd.mjs';
import { runCodexUserPromptSubmitHook } from '../src/cli/codex-hook-cmd.mjs';
import { createEvaluationStore } from '../src/core/evaluation-store.mjs';
import { compactQuestions } from '../scripts/jev-selection-candidates.mjs';

const env = { TYPESAFE_API_KEY: 'test-secret' };
const catalog = [{ name: 'caveat', description: '既知の罠を検索する' }, { name: 'calendar', description: '予定を検索する' }];

test('旧backendの直接生成と旧model比較もJev設定時に他modelを呼ばない', async () => {
  for (const create of [createCodexCliAuditorBackend, createHaikuAuditorBackend]) {
    assert.throws(() => create({ env, catalog }), { code: 'E_JEV_PRIORITY' });
  }
  await assert.rejects(runAuditorModelMatrixCommand({ env }), { code: 'E_JEV_PRIORITY' });
});
function reply(values) {
  return { ok: true, json: async () => ({ model: JEV_MODEL,
    answers: Object.fromEntries(values.map((noul, i) => [`tool_${i}`, { type: 'noul', noul }])),
    usage: { input_tokens: 120, output_tokens: 8 },
  }) };
}

test('Jev認証があれば全hostと明示backend指定より優先する', async () => {
  for (const hostAgent of ['claude', 'codex', 'cursor', 'automation', 'unknown']) {
    for (const backend of ['auto', 'haiku', 'codex-cli', 'jev']) {
      const selected = selectAuditorBackend({ hostAgent, env: { ...env, SPOTTER_AUDITOR_BACKEND: backend },
        isCodexCliAvailable: () => { throw new Error('他モデルを探索してはいけない'); } });
      assert.equal(selected.backend, 'jev');
      const auditor = createAuditorBackend({ backend, hostAgent, env, catalog,
        haikuCaller: () => { throw new Error('Haikuを呼んではいけない'); },
        fetchFn: async () => reply([0.8, 0.2]),
      });
      assert.equal(auditor.name, 'jev');
      const result = await auditor.judge({ stage: 'user_input', userInput: '罠を探して' });
      assert.deepEqual(result.findings.map((f) => f.toolName), ['caveat']);
      assert.equal(result.meta.model, JEV_MODEL);
    }
  }
});

test('複数ツールを一括判定し、本文・カタログ以外の履歴を送らない', async () => {
  let calls = 0;
  const auditor = createJevAuditorBackend({ env, catalog, fetchFn: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    const body = JSON.parse(options.body);
    assert.equal(body.state.stage, 'user_input');
    assert.equal(body.state.text, '予定と罠を検索して');
    assert.deepEqual(body.questions, compactQuestions(catalog, 'user_input', 'noul'));
    assert.ok(!options.body.includes('送信禁止'));
    assert.equal(Object.keys(body.questions).length, 2);
    assert.equal(options.headers.authorization, 'Bearer test-secret');
    return reply([0.8, 0.9]);
  } });
  const result = await auditor.judge({ stage: 'user_input', userInput: '予定と罠を検索して', observerSnapshot: '送信禁止' });
  assert.equal(calls, 1);
  assert.equal(result.findings.length, 2);
  assert.equal(result.pass, false);
  assert.deepEqual(result.meta.diagnostics.tokenUsage, { inputTokens: 120, outputTokens: 8 });
});

test('Stopは使用済みツールを除外し、候補ゼロなら外部呼出しを行わない', async () => {
  let calls = 0;
  const auditor = createJevAuditorBackend({ env, catalog, fetchFn: async (_, options) => {
    calls++;
    assert.deepEqual(JSON.parse(options.body).questions, compactQuestions([catalog[1]], 'turn_end', 'noul'));
    return reply([0.8]);
  } });
  const result = await auditor.judge({ stage: 'turn_end', finalResponse: '確認しました', usedTools: ['caveat'] });
  assert.deepEqual(result.findings.map((f) => f.toolName), ['calendar']);
  assert.equal((await auditor.judge({ stage: 'turn_end', finalResponse: '完了', usedTools: ['caveat', 'calendar'] })).pass, true);
  assert.equal(calls, 1);
});

test('HTTP失敗は再試行・他モデル呼出しをせず固定エラーにする', async () => {
  for (const [status, code] of [[401, 'E_JEV_AUTH'], [429, 'E_JEV_USAGE_LIMIT'], [529, 'E_JEV_HTTP']]) {
    let calls = 0;
    const auditor = createAuditorBackend({ backend: 'haiku', env, catalog,
      haikuCaller: () => assert.fail('他モデル呼出し'),
      fetchFn: async () => { calls++; return { ok: false, status, json: () => assert.fail('provider本文の取得') }; },
    });
    await assert.rejects(auditor.judge({ stage: 'user_input', userInput: '調査して' }), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.backend, 'jev');
      assert.ok(!JSON.stringify(error).includes('test-secret'));
      return true;
    });
    assert.equal(calls, 1);
  }
  assert.equal(projectBackendFailure('E_JEV_AUTH').code, 'E_SPOTTER_AUDIT_AUTH');
  assert.equal(projectBackendFailure('E_JEV_TIMEOUT').code, 'E_SPOTTER_AUDIT_TIMEOUT');
});

test('不正な回答・欠落・別モデル応答をpassへ変換しない', async () => {
  for (const body of [{}, { model: JEV_MODEL, answers: {} }, { model: 'other', answers: {} },
    { model: JEV_MODEL, answers: { tool_0: { type: 'choice', choice: 'invented' }, tool_1: { type: 'choice', choice: 'skip' } } }]) {
    const auditor = createJevAuditorBackend({ env, catalog, fetchFn: async () => ({ ok: true, json: async () => body }) });
    await assert.rejects(auditor.judge({ stage: 'user_input', userInput: '調査して' }), { code: 'E_JEV_SCHEMA' });
  }
});

test('Noulは0.5超だけ提案し、不正な確率をpassへ変換しない', async () => {
  for (const [value, selected] of [[0, false], [0.49, false], [0.5, false], [0.5001, true], [1, true]]) {
    const auditor = createJevAuditorBackend({ env, catalog: [catalog[0]], fetchFn: async () => reply([value]) });
    assert.equal((await auditor.judge({ stage: 'user_input', userInput: '罠を検索して' })).findings.length, selected ? 1 : 0);
  }
  for (const value of [null, undefined, '0.9', true, -0.1, 1.1, NaN, Infinity]) {
    const auditor = createJevAuditorBackend({ env, catalog: [catalog[0]], fetchFn: async () => reply([value]) });
    await assert.rejects(auditor.judge({ stage: 'user_input', userInput: '罠を検索して' }), { code: 'E_JEV_SCHEMA' });
  }
});

test('タイムアウトと通信失敗は秘密を含めず返す', async () => {
  const auditor = createJevAuditorBackend({ env, catalog, timeoutMs: 10,
    fetchFn: (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('test-secret')))),
  });
  await assert.rejects(auditor.judge({ stage: 'user_input', userInput: '調査して' }), { code: 'E_JEV_TIMEOUT' });
  const failed = createJevAuditorBackend({ env, catalog, fetchFn: async () => { throw new Error('test-secret'); } });
  await assert.rejects(failed.judge({ stage: 'user_input', userInput: '調査して' }), (error) => error.code === 'E_JEV_NETWORK' && !error.message.includes('test-secret'));
});

test('認証fileは不在だけ未設定とし、破損・明示pathの失敗を隠さない', () => {
  const home = mkdtempSync(join(tmpdir(), 'spotter-jev-'));
  try {
    assert.equal(resolveJevApiKey({ env: { HOME: home } }), null);
    const path = join(home, 'key.env');
    writeFileSync(path, 'TYPESAFE_API_KEY="file-secret"\n');
    assert.equal(resolveJevApiKey({ env: { SPOTTER_JEV_ENV_FILE: path } }), 'file-secret');
    assert.equal(resolveJevApiKey({ env: { ...env, SPOTTER_JEV_ENV_FILE: path } }), 'test-secret');
    writeFileSync(path, 'OTHER=value\n');
    assert.throws(() => selectAuditorBackend({ hostAgent: 'codex', env: { SPOTTER_JEV_ENV_FILE: path } }), { code: 'E_JEV_CONFIG' });
    assert.throws(() => resolveJevApiKey({ env: { SPOTTER_JEV_ENV_FILE: join(home, 'missing') } }), { code: 'E_JEV_CONFIG' });
    assert.throws(() => createAuditorBackend({ backend: 'jev', env: { HOME: home } }), { code: 'E_JEV_AUTH' });
    assert.equal(selectAuditorBackend({ hostAgent: 'codex', env: { HOME: home } }).backend, 'codex-cli');
  } finally { rmSync(home, { recursive: true }); }
});

test('Codex hookの実選択と評価storeにJevのmodelが残る', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spotter-jev-hook-'));
  const previous = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = env.TYPESAFE_API_KEY;
  mkdirSync(join(root, '.spotter'));
  writeFileSync(join(root, '.spotter', 'marker.json'), '{"markerVersion":"1"}');
  const databasePath = join(root, 'evaluation.db');
  try {
    await runCodexUserPromptSubmitHook({
      readInput: async () => ({ cwd: root, session_id: 'jev-test', prompt: '罠を探して' }),
      readLocalFn: async () => [{ name: 'mcp__caveat__caveat_search', description: '既知の罠を検索' }],
      createAuditorBackendFn: (options) => {
        assert.equal(options.backend, 'jev');
        return createAuditorBackend({ ...options, fetchFn: async () => reply([0.8]) });
      },
      createEvaluationStoreFn: () => createEvaluationStore({ databasePath }),
      loadEvaluationContextFn: async () => ({ status: 'not_requested', snapshot: null }),
      recordHookEventFn: async () => {},
      writeOutput: () => {}, writeError: (message) => assert.fail(message),
    });
    const store = createEvaluationStore({ databasePath });
    try {
      const row = store.database.prepare('SELECT backend, model, audit_status FROM evaluation_turns').get();
      assert.equal(row.backend, 'jev');
      assert.equal(row.model, JEV_MODEL);
      assert.equal(row.audit_status, 'success');
    } finally { store.close(); }
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
    rmSync(root, { recursive: true });
  }
});
