'use strict';

/**
 * Regressões de auditoria F2/F3/F4 e correção do bug 2d.
 *
 *  F3 — `renderer/quantRenderer.js`: `renderFullWorkstationReport` deixou de
 *       referenciar a variável indefinida `recs`. Com `top_20: []` aplica o
 *       fallback `data.top_recommendations || []` e, se também estiver vazio,
 *       usa `assets`. Coberto com asserção estática + avaliação pura da lógica.
 *
 *  F2 — `src/db/database.js`: `saveQualifiedToMonitoring` (e os aliases
 *       `saveAllToMonitoring`/`saveRemainingToMonitoring`) purga, DENTRO da
 *       transação, as linhas de `investment_monitoring_universe` do dia cujo
 *       ticker não pertence à lista recebida, antes dos UPSERTs. Lista efetiva
 *       de tickers vazia devolve 0 sem apagar nada. Erro a meio faz rollback
 *       da purga (atomicidade).
 *
 *  F4 — `python_engine/run_pipeline.py`: `_finite_float` em
 *       `consolidate_and_split_pipeline` impede NaN/inf/strings inválidas de
 *       entrarem na triagem (`current_price` -> 0 -> skip; `win_rate` -> 0 ->
 *       skip) e garante defaults finitos nos restantes campos.
 *
 *  2d — CORRIGIDO: `build_pipeline_output` também usa `_finite_float`
 *       (`current_price` default 0 -> skip; `mc_win_rate` 50.0; `cvar_95` 5.0;
 *       `expected_return` 0.0; `quality_score` 50.0). Existe ainda
 *       `sanitize_non_finite(obj)` recursivo, aplicado aos `json.dumps` de
 *       `run_pipeline.py` e `scripts/run_quant_pipeline.py`. Coberto por
 *       asserções estáticas e por runtime Python: payload sem NaN/inf,
 *       `allow_nan=False` sem erro, `"62.5%"` excluído sem lançar e ativo
 *       válido inalterado.
 *
 * Rede real: nenhuma. Yahoo/Stooq são mocks dos ficheiros existentes; aqui o
 * Python corre offline e o SQLite é sempre temporário.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const childProcess = require('child_process');
const DB = require('../src/db/database');
const { makeTempDir, removeTempDir } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const VENV_PYTHON = path.join(ROOT, '.venv', 'bin', 'python');

// Guarda: qualquer teste que chame saveTop20ToTracker aponta o sync canónico
// para um caminho temporário INEXISTENTE. O quant_tracker.db real nunca é
// criado nem escrito a partir deste ficheiro.
const NOSYNC_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'test-audit-nosync-'));
const GUARD_DB_PATH = path.join(NOSYNC_DIR, 'quant_tracker.db');
const ORIGINAL_QUANT_TRACKER_DB_PATH = process.env.QUANT_TRACKER_DB_PATH;
process.env.QUANT_TRACKER_DB_PATH = GUARD_DB_PATH;

test.after(() => {
  if (ORIGINAL_QUANT_TRACKER_DB_PATH === undefined) {
    delete process.env.QUANT_TRACKER_DB_PATH;
  } else {
    process.env.QUANT_TRACKER_DB_PATH = ORIGINAL_QUANT_TRACKER_DB_PATH;
  }
  removeTempDir(NOSYNC_DIR);
});

function tableCount(db, table) {
  return db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

function todayIso() {
  return new Date().toISOString().split('T')[0];
}

function monitoringAsset(i, overrides = {}) {
  return {
    ticker: `M${String(i).padStart(2, '0')}`,
    company_name: `Monitoring ${i}`,
    country: 'PT',
    sector: 'Technology',
    direction: i % 3 === 0 ? 'VENDA' : 'COMPRA',
    current_price: 50 + i,
    target_price: 52.4 + i,
    stop_loss: 48.8 + i,
    win_rate_mc: 55 + i,
    cvar_95: 4.0,
    graham_score: 60 + i,
    alpha_score: 80 - i,
    ...overrides
  };
}

// Extrai o texto de uma função JS pelo balanceamento de chavetas. O corpo de
// `renderFullWorkstationReport` não contém chavetas dentro de strings.
function extractFunctionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Função ${name} não encontrada na fonte`);
  let depth = 0;
  let end = -1;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  assert.notEqual(end, -1, `Fecho da função ${name} não encontrado`);
  return source.slice(start, end + 1);
}

// Executa a função extraída num sandbox mínimo, com stubs para as dependências
// de DOM/render. Devolve o `window` falso e a lista entregue à tabela mestra.
function runRenderFullWorkstationReport(fnSource, data) {
  const captured = { recList: undefined };
  const win = {};
  const body = `"use strict";\n${fnSource}\nrenderFullWorkstationReport(__data__);`;
  const factory = new Function(
    '__data__',
    'window',
    'updateGlobalSymmetricKPIs',
    'renderMasterRecommendationsTable',
    body
  );
  factory(
    data,
    win,
    () => {},
    (list) => { captured.recList = list; }
  );
  return { win, captured };
}

// Extrai o texto de uma função Python até ao próximo `def ` de topo.
function extractPythonFunction(source, name) {
  const start = source.indexOf(`def ${name}(`);
  assert.notEqual(start, -1, `Função Python ${name} não encontrada`);
  const rest = source.slice(start + 1);
  const next = rest.search(/\ndef /);
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
}

// Invoca o runtime Python do projeto, com skip explícito se o interpretador
// não existir ou as dependências não importarem.
function runPython(t, script, marker) {
  if (!fs.existsSync(VENV_PYTHON)) {
    t.skip('Interpretador .venv/bin/python inexistente; cobertura estática mantém-se.');
    return null;
  }
  const result = childProcess.spawnSync(VENV_PYTHON, ['-c', script], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, PYTHONWARNINGS: 'ignore' }
  });
  if (result.error) {
    t.skip(`Não foi possível invocar o Python (${result.error.message}); cobertura estática mantém-se.`);
    return null;
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr || '');
    if (/ModuleNotFoundError|ImportError/.test(stderr)) {
      t.skip('Dependências Python do motor não estão instaladas neste ambiente; cobertura estática mantém-se.');
      return null;
    }
    assert.fail(`Python terminou com código ${result.status}:\n${stderr.slice(-2000)}`);
  }
  const match = String(result.stdout || '').match(new RegExp(`${marker}:(\\{.*\\})`));
  assert.ok(match, `Payload ${marker} não encontrado no stdout: ${String(result.stdout).slice(-500)}`);
  return JSON.parse(match[1]);
}

// ─────────────────────────────────────────────────────────────────────────
// F3 — renderer/quantRenderer.js (fallback do relatório full workstation)
// ─────────────────────────────────────────────────────────────────────────

test('F3 estático: `recs` removido e fallbacks currentTopRecommendations/recList presentes', () => {
  const quantJs = read('renderer/quantRenderer.js');

  // A variável indefinida que provocava ReferenceError não pode reaparecer.
  assert.doesNotMatch(quantJs, /\brecs\b/, 'A referência indefinida `recs` foi removida');

  assert.match(
    quantJs,
    /window\.currentTopRecommendations = splitTop20\.length > 0 \? splitTop20 : \(data\.top_recommendations \|\| \[\]\)/,
    'Fallback F3: splitTop20 -> data.top_recommendations -> []'
  );
  assert.match(quantJs, /const recList = window\.currentTopRecommendations\.length > 0/);
  assert.match(
    quantJs,
    /\? window\.currentTopRecommendations\s*: assets;/,
    'Fallback final: recList cai em `assets` quando não há recomendações'
  );
});

test('F3 comportamento: top_20 vazio não lança ReferenceError e usa top_recommendations/assets', () => {
  const quantJs = read('renderer/quantRenderer.js');
  const fnSource = extractFunctionSource(quantJs, 'renderFullWorkstationReport');
  const assets = [{ ticker: 'ASSET_ONLY', alpha_score: 1 }];

  // top_20 vazio + top_recommendations vazio -> currentTopRecommendations = [] e recList = assets.
  const empty = runRenderFullWorkstationReport(fnSource, {
    summary: {}, phases: {}, assets, top_20: [], top_recommendations: []
  });
  assert.deepEqual(empty.win.currentTopRecommendations, []);
  assert.equal(empty.captured.recList, assets, 'Sem recomendações, recList deve ser a mesma referência de assets');
  assert.deepEqual(empty.win.currentAnalysisTop20, []);
  assert.deepEqual(empty.win.currentAnalysisRemaining, []);
  assert.deepEqual(empty.win.currentMonitoringPool, []);
  assert.equal(empty.win.currentAllAnalyzedAssets, assets);

  // top_20 vazio + top_recommendations preenchido -> usa top_recommendations.
  const fallback = [{ ticker: 'R1', alpha_score: 2 }];
  const fb = runRenderFullWorkstationReport(fnSource, {
    summary: {}, phases: {}, assets, top_20: [], top_recommendations: fallback
  });
  assert.equal(fb.win.currentTopRecommendations, fallback);
  assert.equal(fb.captured.recList, fallback);

  // top_20 preenchido -> tem prioridade sobre top_recommendations.
  const split = [{ ticker: 'T1', alpha_score: 3 }];
  const sp = runRenderFullWorkstationReport(fnSource, {
    summary: {}, phases: {}, assets, top_20: split, top_recommendations: fallback
  });
  assert.equal(sp.win.currentTopRecommendations, split);
  assert.equal(sp.captured.recList, split);

  // Payload mínimo, sem top_20/top_recommendations/assets: continua sem lançar.
  const bare = runRenderFullWorkstationReport(fnSource, { summary: {}, phases: {} });
  assert.deepEqual(bare.win.currentTopRecommendations, []);
  assert.deepEqual(bare.captured.recList, []);
});

// ─────────────────────────────────────────────────────────────────────────
// F2 — purge transacional em saveQualifiedToMonitoring + aliases
// ─────────────────────────────────────────────────────────────────────────

test('F2 purge: regravar o mesmo dia com subconjunto substitui o snapshot e preserva metadata', async () => {
  const dir = makeTempDir('audit-f2-purge-');
  let db;
  try {
    db = new DB(dir);
    await db.init();

    const first = Array.from({ length: 25 }, (_, i) => monitoringAsset(i));
    assert.equal(db.saveQualifiedToMonitoring(first), 25);
    assert.equal(tableCount(db, 'investment_monitoring_universe'), 25);

    const before = db.db.prepare('SELECT * FROM investment_monitoring_universe WHERE ticker = ?').get('M03');
    assert.ok(before);

    const second = [
      monitoringAsset(3, { alpha_score: 99.5, current_price: 133.0 }),
      monitoringAsset(7)
    ];
    assert.equal(db.saveQualifiedToMonitoring(second), 2);

    const rows = db.getMonitoringUniverse();
    assert.equal(rows.length, 2, 'Purge deve deixar apenas a última lista do dia');
    assert.deepEqual(rows.map((r) => r.ticker).sort(), ['M03', 'M07']);

    const after = db.db.prepare('SELECT * FROM investment_monitoring_universe WHERE ticker = ?').get('M03');
    assert.equal(after.id, before.id, 'UPSERT reutiliza a mesma linha');
    assert.equal(after.created_at, before.created_at, 'created_at é metadata preservada');
    assert.equal(after.status, 'MONITORIZANDO', 'status preservado');
    assert.equal(after.analysis_date, todayIso());
    assert.equal(after.alpha_score, 99.5, 'Métricas são atualizadas');
    assert.equal(after.entry_price, 133.0, 'entry_price reflete current_price no UPSERT');
  } finally {
    if (db) db.close();
    removeTempDir(dir);
  }
});

test('F2 purge: só as linhas de hoje são substituídas; dias anteriores ficam intactos', async () => {
  const dir = makeTempDir('audit-f2-days-');
  let db;
  try {
    db = new DB(dir);
    await db.init();

    db.db.prepare(`
      INSERT INTO investment_monitoring_universe
        (ticker, company_name, country, sector, direction, entry_price, target_price, stop_loss,
         current_price, win_rate_mc, cvar_95, graham_score, alpha_score, analysis_date)
      VALUES ('OLD1', 'Ativo Antigo', 'PT', 'Geral', 'COMPRA', 10, 10.48, 9.76,
              10, 55, 4, 60, 50, '2000-01-01')
    `).run();

    assert.equal(db.saveQualifiedToMonitoring([monitoringAsset(0), monitoringAsset(1)]), 2);
    assert.equal(db.saveQualifiedToMonitoring([monitoringAsset(2)]), 1);

    const old = db.db.prepare('SELECT * FROM investment_monitoring_universe WHERE ticker = ?').get('OLD1');
    assert.ok(old, 'Linha histórica não pode ser purgada');
    assert.equal(old.analysis_date, '2000-01-01');
    assert.equal(old.alpha_score, 50);

    const today = db.db.prepare('SELECT ticker FROM investment_monitoring_universe WHERE analysis_date = ? ORDER BY ticker').all(todayIso());
    assert.deepEqual(today.map((r) => r.ticker), ['M02'], 'Hoje contém apenas a última lista');
  } finally {
    if (db) db.close();
    removeTempDir(dir);
  }
});

test('F2: []/null/undefined e listas sem tickers devolvem 0 sem apagar nem escrever', async () => {
  const dir = makeTempDir('audit-f2-empty-');
  let db;
  try {
    db = new DB(dir);
    await db.init();

    const initial = Array.from({ length: 5 }, (_, i) => monitoringAsset(i));
    assert.equal(db.saveQualifiedToMonitoring(initial), 5);

    for (const payload of [
      [],
      null,
      undefined,
      [{}, { ticker: '' }, { ticker: '   ' }],
      [null, undefined]
    ]) {
      assert.equal(db.saveQualifiedToMonitoring(payload), 0, `Lista efetiva vazia deve devolver 0 (${JSON.stringify(payload)})`);
    }

    // Os aliases herdam a mesma guarda de lista efetiva vazia.
    for (const alias of ['saveAllToMonitoring', 'saveRemainingToMonitoring']) {
      assert.equal(db[alias]([]), 0);
      assert.equal(db[alias](null), 0);
      assert.equal(db[alias]([{ ticker: '  ' }]), 0);
    }

    assert.equal(tableCount(db, 'investment_monitoring_universe'), 5, 'Nenhuma linha pode ser apagada');
    assert.deepEqual(
      db.getMonitoringUniverse().map((r) => r.ticker).sort(),
      ['M00', 'M01', 'M02', 'M03', 'M04']
    );
  } finally {
    if (db) db.close();
    removeTempDir(dir);
  }
});

test('F2: aliases saveAllToMonitoring/saveRemainingToMonitoring purgam o mesmo dia', async () => {
  const dir = makeTempDir('audit-f2-aliases-');
  let db;
  try {
    db = new DB(dir);
    await db.init();

    assert.equal(
      db.saveQualifiedToMonitoring([monitoringAsset(0), monitoringAsset(1), monitoringAsset(2)]),
      3
    );

    assert.equal(db.saveAllToMonitoring([monitoringAsset(0)]), 1);
    assert.deepEqual(db.getMonitoringUniverse().map((r) => r.ticker), ['M00']);

    assert.equal(db.saveRemainingToMonitoring([monitoringAsset(2), monitoringAsset(3)]), 2);
    assert.deepEqual(db.getMonitoringUniverse().map((r) => r.ticker).sort(), ['M02', 'M03']);

    // O alias que gravou por último define o snapshot do dia.
    assert.equal(db.saveAllToMonitoring([monitoringAsset(4)]), 1);
    assert.deepEqual(db.getMonitoringUniverse().map((r) => r.ticker), ['M04']);
    assert.equal(tableCount(db, 'investment_monitoring_universe'), 1);
  } finally {
    if (db) db.close();
    removeTempDir(dir);
  }
});

test('F2 misto: itens inválidos são ignorados mas os válidos são persistidos e a purga usa só tickers efetivos', async () => {
  const dir = makeTempDir('audit-f2-mixed-');
  let db;
  try {
    db = new DB(dir);
    await db.init();

    assert.equal(db.saveQualifiedToMonitoring([monitoringAsset(0), monitoringAsset(1)]), 2);

    // Mistura válidos com null/objetos sem ticker: persiste apenas M02/M03 e
    // purga M00/M01 por não pertencerem à lista efetiva.
    const mixed = [
      null,
      monitoringAsset(2),
      {},
      { ticker: '   ' },
      undefined,
      monitoringAsset(3)
    ];
    assert.equal(db.saveQualifiedToMonitoring(mixed), 2);
    assert.deepEqual(db.getMonitoringUniverse().map((r) => r.ticker).sort(), ['M02', 'M03']);
    assert.equal(tableCount(db, 'investment_monitoring_universe'), 2);
  } finally {
    if (db) db.close();
    removeTempDir(dir);
  }
});

test('F2 atomicidade: erro a meio do UPSERT reverte a purga e não deixa estado parcial', async () => {
  const dir = makeTempDir('audit-f2-rollback-');
  let db;
  try {
    db = new DB(dir);
    await db.init();

    const initial = [monitoringAsset(0), monitoringAsset(1), monitoringAsset(2)];
    assert.equal(db.saveQualifiedToMonitoring(initial), 3);
    const beforeRows = db.db.prepare('SELECT ticker, alpha_score FROM investment_monitoring_universe ORDER BY ticker').all();

    // Força um erro DEPOIS da purga: o getter rebenta no segundo loop do UPSERT.
    const boom = { ticker: 'ZZZ' };
    Object.defineProperty(boom, 'current_price', {
      get() { throw new Error('f2-boom'); }
    });
    assert.throws(
      () => db.saveQualifiedToMonitoring([monitoringAsset(9), boom]),
      /f2-boom/,
      'O erro deve propagar para fora da transação'
    );

    const afterRows = db.db.prepare('SELECT ticker, alpha_score FROM investment_monitoring_universe ORDER BY ticker').all();
    assert.deepEqual(afterRows, beforeRows, 'Rollback deve repor exatamente as linhas originais');
    assert.equal(tableCount(db, 'investment_monitoring_universe'), 3);
    assert.equal(
      db.db.prepare('SELECT COUNT(*) AS n FROM investment_monitoring_universe WHERE ticker IN (?, ?)').get('M09', 'ZZZ').n,
      0,
      'Nenhum UPSERT parcial pode sobreviver'
    );
  } finally {
    if (db) db.close();
    removeTempDir(dir);
  }
});

test('Guarda QUANT_TRACKER_DB_PATH: saveTop20ToTracker não materializa o tracker real', async () => {
  assert.equal(process.env.QUANT_TRACKER_DB_PATH, GUARD_DB_PATH);
  assert.equal(fs.existsSync(GUARD_DB_PATH), false, 'O caminho guardado deve começar inexistente');

  const dir = makeTempDir('audit-guard-');
  let db;
  try {
    db = new DB(dir);
    await db.init();

    assert.equal(db.saveTop20ToTracker([monitoringAsset(0)]), 1);
    assert.equal(tableCount(db, 'alphaquant_top20_tracker'), 1);
    assert.equal(
      fs.existsSync(GUARD_DB_PATH),
      false,
      'O sync canónico tem de parar no early-return (ficheiro guardado inexistente)'
    );
  } finally {
    if (db) db.close();
    removeTempDir(dir);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// F4 — python_engine/run_pipeline.py
// ─────────────────────────────────────────────────────────────────────────

test('F4 estático: _finite_float na triagem canónica e no payload legado', () => {
  const py = read('python_engine/run_pipeline.py');

  assert.match(py, /def _finite_float\(value: Any, default: float\) -> float:/);
  assert.match(py, /current_price = _finite_float\(asset\.get\('current_price'/);
  assert.match(py, /win_rate = _finite_float\(asset\.get\('mc_win_rate'/);
  assert.match(py, /cvar_95 = _finite_float\(asset\.get\('cvar_95'/);
  assert.match(py, /exp_return = _finite_float\(asset\.get\('expected_return'/);
  assert.match(py, /quality_score = _finite_float\(asset\.get\('quality_score'/);

  const consolidateSrc = extractPythonFunction(py, 'consolidate_and_split_pipeline');
  assert.match(consolidateSrc, /_finite_float/, 'A triagem usa conversão finita');

  // 2d corrigido: o payload legado também usa conversão finita e já não tem
  // o float() cru sobre mc_win_rate.
  const buildSrc = extractPythonFunction(py, 'build_pipeline_output');
  assert.match(buildSrc, /_finite_float/, 'O payload legado usa conversão finita');
  assert.doesNotMatch(
    buildSrc,
    /(^|[^_\w])float\(asset\.get\('mc_win_rate'/m,
    'Sem float() cru em mc_win_rate'
  );
});

const F4_TRIAGE_SCRIPT = `
import json
from python_engine.run_pipeline import consolidate_and_split_pipeline

assets = [
    {"ticker": "NAN_WIN", "current_price": 100.0, "mc_win_rate": float("nan"), "cvar_95": 4.0, "expected_return": 2.0, "graham_score": 60.0},
    {"ticker": "INF_PRICE", "current_price": float("inf"), "mc_win_rate": 80.0, "cvar_95": 4.0, "expected_return": 2.0, "graham_score": 60.0},
    {"ticker": "PCT_PRICE", "current_price": "62.5%", "mc_win_rate": 80.0, "cvar_95": 4.0, "expected_return": 2.0, "graham_score": 60.0},
    {"ticker": "NAN_CVAR", "current_price": 100.0, "mc_win_rate": 80.0, "cvar_95": float("nan"), "expected_return": 3.0, "graham_score": 70.0},
    {"ticker": "OK", "current_price": 100.0, "mc_win_rate": 80.0, "cvar_95": 4.0, "expected_return": 3.0, "graham_score": 70.0},
]
res = consolidate_and_split_pipeline(assets)
combined = {a["ticker"]: a for a in (res["top_20"] + res["monitoring_pool"])}
try:
    json.dumps(res, allow_nan=False)
    finite_serializable = True
except (TypeError, ValueError):
    finite_serializable = False

invalid_batch = [
    {"ticker": "B1", "current_price": float("nan"), "mc_win_rate": 80.0},
    {"ticker": "B2", "current_price": float("inf"), "mc_win_rate": 80.0},
    {"ticker": "B3", "current_price": "62.5%", "mc_win_rate": 80.0},
    {"ticker": "B4", "current_price": 10.0, "mc_win_rate": float("inf")},
    {"ticker": "B5", "current_price": 10.0, "mc_win_rate": "62.5%"},
    {"ticker": "B6", "current_price": 0.0, "mc_win_rate": 80.0},
    {"ticker": "B7", "current_price": 10.0, "mc_win_rate": 49.9},
]
empty = consolidate_and_split_pipeline(invalid_batch)
try:
    json.dumps(empty, allow_nan=False)
    empty_serializable = True
except (TypeError, ValueError):
    empty_serializable = False

print("AUDIT_F4_JSON:" + json.dumps({
    "qualified_tickers": sorted(combined.keys()),
    "total": res["total_qualified_count"],
    "monitoring_count": res["monitoring_count"],
    "nan_cvar_cvar": combined["NAN_CVAR"]["cvar_95"],
    "nan_cvar_alpha": combined["NAN_CVAR"]["alpha_score"],
    "ok_price": combined["OK"]["current_price"],
    "ok_win": combined["OK"]["win_rate_mc"],
    "ok_target": combined["OK"]["target_price"],
    "ok_stop": combined["OK"]["stop_loss"],
    "ok_alpha": combined["OK"]["alpha_score"],
    "finite_serializable": finite_serializable,
    "empty_top20": len(empty["top_20"]),
    "empty_pool": len(empty["monitoring_pool"]),
    "empty_total": empty["total_qualified_count"],
    "empty_serializable": empty_serializable,
}))
`;

test('F4 runtime: NaN/inf/"62.5%" excluídos, cvar NaN usa default finito e lote inválido fica vazio', (t) => {
  const out = runPython(t, F4_TRIAGE_SCRIPT, 'AUDIT_F4_JSON');
  if (!out) return;

  assert.deepEqual(out.qualified_tickers, ['NAN_CVAR', 'OK'], 'Só ativos com preço e win rate finitos/válidos passam');
  assert.equal(out.total, 2, 'total_qualified_count reflete apenas válidos');
  assert.equal(out.monitoring_count, 0, 'top_20 absorve os 2 qualificados');

  assert.equal(out.nan_cvar_cvar, 5.0, 'cvar_95 NaN cai no default finito 5.0');
  assert.equal(out.nan_cvar_alpha, 71.0, 'alpha calculado com valores finitos (70*0.3 + 80*0.4 + 0.6*30)');

  assert.equal(out.ok_price, 100.0);
  assert.equal(out.ok_win, 80.0);
  assert.equal(out.ok_target, 104.8, 'Target COMPRA = +4.8%');
  assert.equal(out.ok_stop, 97.6, 'Stop COMPRA = -2.4%');
  assert.equal(out.ok_alpha, 75.5, 'Ativo válido mantém os valores esperados');

  assert.equal(out.finite_serializable, true, 'json.dumps(..., allow_nan=False) não pode lançar');

  assert.equal(out.empty_top20, 0, 'Lote só inválido -> top_20 vazio');
  assert.equal(out.empty_pool, 0, 'Lote só inválido -> monitoring_pool vazio');
  assert.equal(out.empty_total, 0, 'Lote só inválido -> total 0');
  assert.equal(out.empty_serializable, true, 'Resultado vazio continua serializável sem NaN');
});

// CORREÇÃO DO BUG 2d: build_pipeline_output protege os campos numéricos com
// _finite_float e o projeto conta ainda com sanitize_non_finite (recursivo)
// aplicado aos json.dumps de run_pipeline.py e scripts/run_quant_pipeline.py.
// O runtime confirma: sem NaN/inf no payload, allow_nan=False sem erro,
// "62.5%" excluído sem lançar e ativo válido com valores inalterados.
const BUILD_PIPELINE_SCRIPT = `
import json
from python_engine.run_pipeline import build_pipeline_output, sanitize_non_finite

assets = [
    {"ticker": "NAN_WIN", "current_price": 100.0, "mc_win_rate": float("nan"), "cvar_95": 4.0, "expected_return": 2.0, "graham_score": 60.0},
    {"ticker": "INF_PRICE", "current_price": float("inf"), "mc_win_rate": 80.0, "cvar_95": 4.0, "expected_return": 2.0, "graham_score": 60.0},
    {"ticker": "PCT_PRICE", "current_price": "62.5%", "mc_win_rate": 80.0, "cvar_95": 4.0, "expected_return": 2.0, "graham_score": 60.0},
    {"ticker": "OK", "current_price": 100.0, "mc_win_rate": 62.5, "cvar_95": 4.0, "expected_return": 3.0, "graham_score": 70.0, "alpha_score": 64.8},
]
out = build_pipeline_output(assets)
rows = {a["ticker"]: a for a in out["all_analyzed_assets"]}
try:
    json.dumps(out, allow_nan=False)
    allow_nan_false_ok = True
except (TypeError, ValueError):
    allow_nan_false_ok = False

# "62.5%" não pode lançar ValueError; deve ser tratado como 0 -> excluído.
percent_skipped = False
try:
    pct_out = build_pipeline_output([{"ticker": "PCT", "current_price": "62.5%", "mc_win_rate": 80.0}])
    percent_skipped = pct_out["total_analyzed_count"] == 0 and pct_out["top_recommendations"] == []
except ValueError:
    percent_skipped = False

# sanitize_non_finite: recursivo em dict/list/aninhados; finitos intactos.
sanitized = sanitize_non_finite({
    "nan": float("nan"),
    "pos_inf": float("inf"),
    "list": [float("-inf"), 1.5, {"nested": float("nan"), "finite": 2}],
    "text": "txt",
    "int": 3,
    "none": None,
})
sanitize_ok = (
    sanitized["nan"] is None
    and sanitized["pos_inf"] is None
    and sanitized["list"][0] is None
    and sanitized["list"][1] == 1.5
    and sanitized["list"][2]["nested"] is None
    and sanitized["list"][2]["finite"] == 2
    and sanitized["text"] == "txt"
    and sanitized["int"] == 3
    and sanitized["none"] is None
)
try:
    json.dumps(sanitized, allow_nan=False)
    sanitized_serializable = True
except (TypeError, ValueError):
    sanitized_serializable = False

print("AUDIT_BUILD_JSON:" + json.dumps({
    "nan_win_present": "NAN_WIN" in rows,
    "nan_win_win_rate": rows["NAN_WIN"]["win_rate_mc"] if "NAN_WIN" in rows else None,
    "nan_win_alpha": rows["NAN_WIN"]["alpha_score"] if "NAN_WIN" in rows else None,
    "inf_price_present": "INF_PRICE" in rows,
    "pct_price_present": "PCT_PRICE" in rows,
    "allow_nan_false_ok": allow_nan_false_ok,
    "percent_skipped_without_raise": percent_skipped,
    "ok_price": rows["OK"]["current_price"] if "OK" in rows else None,
    "ok_win": rows["OK"]["win_rate_mc"] if "OK" in rows else None,
    "ok_alpha": rows["OK"]["alpha_score"] if "OK" in rows else None,
    "ok_target": rows["OK"]["target_price"] if "OK" in rows else None,
    "ok_stop": rows["OK"]["stop_loss"] if "OK" in rows else None,
    "total_analyzed": out["total_analyzed_count"],
    "sanitize_ok": sanitize_ok,
    "sanitized_serializable": sanitized_serializable,
    "sanitized_nan": sanitized["nan"],
    "sanitized_inf": sanitized["pos_inf"],
    "sanitized_nested_nan": sanitized["list"][2]["nested"],
    "sanitized_finite": sanitized["list"][1],
}, allow_nan=False))
`;

test('2d — CORREÇÃO: build_pipeline_output finito e sanitize_non_finite no payload', (t) => {
  // ── Estático ──────────────────────────────────────────────────────────
  const py = read('python_engine/run_pipeline.py');
  const scriptPy = read('scripts/run_quant_pipeline.py');

  assert.match(py, /def sanitize_non_finite\(obj\):/, 'sanitize_non_finite definido no motor');

  const buildSrc = extractPythonFunction(py, 'build_pipeline_output');
  assert.match(buildSrc, /_finite_float\(asset\.get\('current_price'/);
  assert.match(buildSrc, /_finite_float\(asset\.get\('mc_win_rate'/);
  assert.match(buildSrc, /_finite_float\(asset\.get\('cvar_95'/);
  assert.match(buildSrc, /_finite_float\(asset\.get\('expected_return'/);
  assert.match(buildSrc, /_finite_float\(asset\.get\('quality_score'/);
  assert.doesNotMatch(
    buildSrc,
    /(^|[^_\w])float\(asset\.get\('mc_win_rate'/m,
    '2d: mc_win_rate já não passa por float() cru'
  );

  // O entrypoint de script e o __main__ do motor sanitizam antes do json.dumps.
  assert.match(
    scriptPy,
    /from python_engine\.run_pipeline import[\s\S]*?sanitize_non_finite/,
    'scripts/run_quant_pipeline.py importa sanitize_non_finite'
  );
  assert.match(scriptPy, /print\(json\.dumps\(sanitize_non_finite\(/);
  assert.match(py, /print\(json\.dumps\(sanitize_non_finite\(/);

  // ── Runtime ───────────────────────────────────────────────────────────
  const out = runPython(t, BUILD_PIPELINE_SCRIPT, 'AUDIT_BUILD_JSON');
  if (!out) return;

  // mc_win_rate=NaN não é expulso: cai no default finito 50.0 e propaga um
  // alpha finito (60*0.3 + 50*0.4 + (2/4)*30 = 53.0).
  assert.equal(out.nan_win_present, true, 'NaN em mc_win_rate usa default finito em vez de excluir');
  assert.equal(out.nan_win_win_rate, 50.0, 'mc_win_rate não finito cai no default 50.0');
  assert.equal(out.nan_win_alpha, 53.0, 'alpha calculado apenas com valores finitos');
  assert.equal(out.inf_price_present, false, 'current_price=inf -> default 0 -> excluído');
  assert.equal(out.pct_price_present, false, '"62.5%" em current_price -> default 0 -> excluído');
  assert.equal(out.allow_nan_false_ok, true, 'payload não pode conter NaN/inf');
  assert.equal(out.percent_skipped_without_raise, true, '"62.5%" não pode lançar ValueError');

  // Ativo válido inalterado.
  assert.equal(out.ok_price, 100.0);
  assert.equal(out.ok_win, 62.5, 'win_rate válido é preservado');
  assert.equal(out.ok_alpha, 64.8, 'alpha válido é preservado');
  assert.equal(out.ok_target, 104.8, 'Target COMPRA = +4.8%');
  assert.equal(out.ok_stop, 97.6, 'Stop COMPRA = -2.4%');
  assert.equal(out.total_analyzed, 2, 'Só NAN_WIN (default) e OK entram');

  // sanitize_non_finite funcional em dict/list/aninhado.
  assert.equal(out.sanitize_ok, true, 'não finitos -> None; finitos intactos');
  assert.equal(out.sanitized_serializable, true, 'resultado sanitizado é serializável com allow_nan=False');
  assert.equal(out.sanitized_nan, null);
  assert.equal(out.sanitized_inf, null);
  assert.equal(out.sanitized_nested_nan, null);
  assert.equal(out.sanitized_finite, 1.5);
});
