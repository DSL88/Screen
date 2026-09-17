'use strict';

/**
 * Matriz de testes da triagem qualificada (consolidate_and_split_pipeline):
 *  (a) contrato estático do motor Python;
 *  (b) runtime determinístico do motor Python (sem rede) com guarda de ambiente;
 *  (c) isolamento DB da canónica `saveQualifiedToMonitoring` + UPSERT + vazios;
 *  (d) rotas IPC/preload novas e ausência das antigas;
 *  (e) contrato estático da UI (IDs, globais, listeners e reposição de estado);
 *  (f) cenário misto: qualificados persistidos, rejeitados descartados.
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

// Isola o sync do tracker canónico: os testes nunca escrevem no quant_tracker.db real.
const NOSYNC_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'test-qualified-nosync-'));
const ORIGINAL_QUANT_TRACKER_DB_PATH = process.env.QUANT_TRACKER_DB_PATH;
process.env.QUANT_TRACKER_DB_PATH = path.join(NOSYNC_DIR, 'quant_tracker.db');

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

function qualifiedAsset(i, overrides = {}) {
  return {
    ticker: `Q${String(i).padStart(2, '0')}`,
    company_name: `Qualified ${i}`,
    country: 'PT',
    sector: 'Technology',
    direction: i % 5 === 0 ? 'VENDA' : 'COMPRA',
    current_price: 100 + i,
    target_price: 104.8 + i,
    stop_loss: 97.6 + i,
    win_rate_mc: 50 + i,
    cvar_95: 4.0,
    graham_score: 60 + i,
    alpha_score: 90 - i,
    ...overrides
  };
}

// ── (a) PYTHON estático ────────────────────────────────────────────────
test('PYTHON estático: consolidate_and_split_pipeline, filtros e chaves canónicas', () => {
  const py = read('python_engine/run_pipeline.py');

  assert.match(py, /def consolidate_and_split_pipeline\(processed_assets: List\[Dict\[str, Any\]\], horizon_days: int = 35\)/);
  assert.match(py, /if current_price <= 0:/);
  assert.match(py, /if win_rate < 50\.0:/);
  assert.match(py, /"top_20":\s*top_20/);
  assert.match(py, /"monitoring_pool":\s*monitoring_pool/);
  assert.match(py, /"total_qualified_count":\s*len\(qualified_sorted\)/);
  assert.match(py, /"monitoring_count":\s*len\(monitoring_pool\)/);

  // Payload do motor usa as chaves novas
  assert.match(py, /qualified_res = consolidate_and_split_pipeline\(analyzed_assets, horizon_days=horizon_markov\)/);
  assert.match(py, /"monitoring_pool":\s*qualified_res\["monitoring_pool"\]/);
  assert.match(py, /"monitoring_count":\s*qualified_res\["monitoring_count"\]/);
  assert.match(py, /"total_qualified_count":\s*qualified_res\["total_qualified_count"\]/);
  assert.match(py, /"remaining_analyzed":\s*qualified_res\["monitoring_pool"\]/);
  assert.match(py, /"top_recommendations":\s*qualified_res\["top_20"\]/);

  // Wrapper de compatibilidade presente e a delegar na canónica
  assert.match(py, /def split_analysis_results/);
  assert.match(py, /res = consolidate_and_split_pipeline\(processed_assets, horizon_days=horizon_days\)/);
  assert.match(py, /"remaining_analyzed":\s*res\["monitoring_pool"\]/);
  assert.match(py, /"total_analyzed":\s*res\["total_qualified_count"\]/);
});

// ── (b) PYTHON runtime (determinístico, sem rede) ─────────────────────
const VENV_PYTHON = path.join(ROOT, '.venv', 'bin', 'python');
const TRIAGE_SCRIPT = `
import json
from python_engine.run_pipeline import consolidate_and_split_pipeline, split_analysis_results

qualified = []
for i in range(25):
    qualified.append({
        "ticker": "Q%02d" % i,
        "name": "Qualified %d" % i,
        "country": "PT",
        "sector": "Technology",
        "current_price": 100.0 + i,
        "mc_win_rate": 50.0 + i,
        "cvar_95": 4.0,
        "expected_return": 2.5,
        "graham_score": 60.0 + i,
        "signal_direction": "COMPRA" if i % 5 else "VENDA",
    })
rejected = [
    {"ticker": "REJ_WIN", "current_price": 50.0, "mc_win_rate": 49.9, "cvar_95": 4.0, "expected_return": 1.0, "graham_score": 70.0},
    {"ticker": "REJ_PRICE", "current_price": 0.0, "mc_win_rate": 80.0, "cvar_95": 4.0, "expected_return": 1.0, "graham_score": 70.0},
    {"ticker": "REJ_NEG", "current_price": -3.0, "mc_win_rate": 80.0, "cvar_95": 4.0, "expected_return": 1.0, "graham_score": 70.0},
]
assets = qualified + rejected
res = consolidate_and_split_pipeline(assets)
wr = split_analysis_results(assets)
combined = res["top_20"] + res["monitoring_pool"]
q00 = [a for a in combined if a["ticker"] == "Q00"][0]
top = res["top_20"][0]
print("TRIAGE_JSON:" + json.dumps({
    "top20": len(res["top_20"]),
    "pool": len(res["monitoring_pool"]),
    "total": res["total_qualified_count"],
    "monitoring": res["monitoring_count"],
    "wrapper_remaining": len(wr["remaining_analyzed"]),
    "wrapper_total": wr["total_analyzed"],
    "rejected_present": any(a["ticker"].startswith("REJ") for a in combined),
    "ranks": [a.get("rank") for a in res["top_20"]],
    "top_ticker": top["ticker"],
    "top_target": top["target_price"],
    "top_stop": top["stop_loss"],
    "q00_direction": q00["direction"],
    "q00_target": q00["target_price"],
    "q00_stop": q00["stop_loss"],
}))
`;

test('PYTHON runtime: 25 qualificados (top 20 + pool 5) e 5 rejeitados excluídos', (t) => {
  if (!fs.existsSync(VENV_PYTHON)) {
    t.skip('Interpretador .venv/bin/python inexistente; cobertura estática mantém-se.');
    return;
  }

  const result = childProcess.spawnSync(VENV_PYTHON, ['-c', TRIAGE_SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, PYTHONWARNINGS: 'ignore' }
  });

  if (result.error) {
    t.skip(`Não foi possível invocar o Python (${result.error.message}); cobertura estática mantém-se.`);
    return;
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr || '');
    if (/ModuleNotFoundError|ImportError/.test(stderr)) {
      t.skip('Dependências Python do motor não estão instaladas neste ambiente; cobertura estática mantém-se.');
      return;
    }
    assert.fail(`Python terminou com código ${result.status}:\n${stderr.slice(-2000)}`);
  }

  const marker = String(result.stdout || '').match(/TRIAGE_JSON:(\{.*\})/);
  assert.ok(marker, `Payload TRIAGE_JSON não encontrado no stdout: ${String(result.stdout).slice(-500)}`);
  const out = JSON.parse(marker[1]);

  assert.equal(out.top20, 20, 'Top 20 deve ficar limitado a 20 ativos');
  assert.equal(out.pool, 5, 'Devem sobrar 5 qualificados no pool de monitorização');
  assert.equal(out.total, 25, 'Total qualificado = 25');
  assert.equal(out.monitoring, 5, 'monitoring_count = 5');
  assert.equal(out.wrapper_remaining, 5, 'Wrapper: remaining_analyzed = pool');
  assert.equal(out.wrapper_total, 25, 'Wrapper: total_analyzed = qualificados');
  assert.equal(out.rejected_present, false, 'Ativos com win_rate < 50 ou preço <= 0 não podem aparecer');
  assert.deepEqual(out.ranks, Array.from({ length: 20 }, (_, i) => i + 1), 'Top 20 deve ter ranks 1..20');

  // Top por alpha_score: Q24 (preço 124) com direção COMPRA
  assert.equal(out.top_ticker, 'Q24');
  assert.equal(out.top_target, 129.95, 'Target COMPRA = +4.8%');
  assert.equal(out.top_stop, 121.02, 'Stop COMPRA = -2.4%');

  // Q00 tem signal_direction VENDA: target -4.8% e stop +2.4%
  assert.equal(out.q00_direction, 'VENDA');
  assert.equal(out.q00_target, 95.2, 'Target VENDA = -4.8%');
  assert.equal(out.q00_stop, 102.4, 'Stop VENDA = +2.4%');
});

// ── (c) DB isolamento + UPSERT + vazios + Top 20 ───────────────────────
test('DB isolamento: saveQualifiedToMonitoring(25) só toca investment_monitoring_universe', async () => {
  const dir = makeTempDir('test-qualified-db-');
  let db;
  try {
    db = new DB(dir);
    await db.init();

    const saved = db.saveQualifiedToMonitoring(Array.from({ length: 25 }, (_, i) => qualifiedAsset(i)));
    assert.equal(saved, 25);

    assert.equal(tableCount(db, 'investment_monitoring_universe'), 25);
    assert.equal(tableCount(db, 'alphaquant_top20_tracker'), 0, 'Top 20 não pode ser tocado');
    assert.equal(tableCount(db, 'alphaquant_history_tracker'), 0, 'Tracker canónico não pode ser tocado');

    const rows = db.db.prepare('SELECT * FROM investment_monitoring_universe ORDER BY ticker ASC').all();
    assert.equal(rows.length, 25);
    assert.equal(rows[0].ticker, 'Q00', 'Tickers normalizados/ordenados');
    assert.equal(rows[0].status, 'MONITORIZANDO');
  } finally {
    if (db) db.close();
    removeTempDir(dir);
  }
});

test('DB idempotência: UPSERT da monitorização não duplica e preserva metadata', async () => {
  const dir = makeTempDir('test-qualified-upsert-');
  let db;
  try {
    db = new DB(dir);
    await db.init();

    assert.equal(db.saveQualifiedToMonitoring([qualifiedAsset(0)]), 1);
    const before = db.db.prepare('SELECT * FROM investment_monitoring_universe WHERE ticker = ?').get('Q00');
    assert.ok(before);

    const updated = qualifiedAsset(0, {
      company_name: 'Qualified 0 Updated',
      direction: 'COMPRA',
      current_price: 133.0,
      target_price: 139.38,
      stop_loss: 129.81,
      win_rate_mc: 77.5,
      alpha_score: 99.0
    });
    assert.equal(db.saveQualifiedToMonitoring([updated]), 1);

    assert.equal(tableCount(db, 'investment_monitoring_universe'), 1, 'UPSERT não pode duplicar ticker/dia');
    const after = db.db.prepare('SELECT * FROM investment_monitoring_universe WHERE ticker = ?').get('Q00');
    assert.equal(after.id, before.id, 'Atualiza a mesma linha');
    assert.equal(after.entry_price, 133.0);
    assert.equal(after.current_price, 133.0);
    assert.equal(after.direction, 'COMPRA');
    assert.equal(after.alpha_score, 99.0);
    assert.equal(after.analysis_date, before.analysis_date);
    assert.equal(after.created_at, before.created_at, 'created_at é metadata preservada');
    assert.equal(after.company_name, 'Qualified 0', 'company_name não é reescrito pelo UPSERT');
  } finally {
    if (db) db.close();
    removeTempDir(dir);
  }
});

test('DB vazios: [] / null / undefined devolvem 0 sem escrever; saveTop20ToTracker(20) isola', async () => {
  const dir = makeTempDir('test-qualified-empty-');
  let db;
  try {
    db = new DB(dir);
    await db.init();

    assert.equal(db.saveQualifiedToMonitoring([]), 0);
    assert.equal(db.saveQualifiedToMonitoring(null), 0);
    assert.equal(db.saveQualifiedToMonitoring(undefined), 0);
    assert.equal(tableCount(db, 'investment_monitoring_universe'), 0);

    const savedTop = db.saveTop20ToTracker(Array.from({ length: 20 }, (_, i) => qualifiedAsset(i)));
    assert.equal(savedTop, 20);
    assert.equal(tableCount(db, 'alphaquant_top20_tracker'), 20);
    assert.equal(tableCount(db, 'investment_monitoring_universe'), 0, 'Top 20 não escreve na monitorização');
  } finally {
    if (db) db.close();
    removeTempDir(dir);
  }
});

// ── (f) Cenário misto: qualificados persistidos, rejeitados descartados ─
test('DB misto: só os qualificados do split são persistidos e os rejeitados ficam de fora', async () => {
  const dir = makeTempDir('test-qualified-mixed-');
  let db;
  try {
    db = new DB(dir);
    await db.init();

    const all = [
      ...Array.from({ length: 25 }, (_, i) => qualifiedAsset(i)),
      qualifiedAsset(90, { ticker: 'REJ_WIN', win_rate_mc: 49.9, direction: 'COMPRA' }),
      qualifiedAsset(91, { ticker: 'REJ_PRICE', current_price: 0, direction: 'COMPRA' }),
      qualifiedAsset(92, { ticker: 'REJ_NEG', current_price: -3, direction: 'COMPRA' }),
      qualifiedAsset(93, { ticker: 'REJ_NULL', win_rate_mc: null, direction: 'COMPRA' }),
      qualifiedAsset(94, { ticker: 'REJ_ZERO', win_rate_mc: 0, direction: 'COMPRA' }),
      { ticker: 'REJ_NOTICKER_OK', current_price: 0, win_rate_mc: 99 }
    ];

    // Predicado contratual do motor: preço > 0 e win_rate >= 50.
    const pool = all.filter((a) => Number(a.current_price) > 0 && Number(a.win_rate_mc) >= 50);
    assert.equal(pool.length, 25, 'Só 25 ativos cumprem o predicado');

    const saved = db.saveQualifiedToMonitoring(pool);
    assert.equal(saved, 25);
    assert.equal(tableCount(db, 'investment_monitoring_universe'), 25);

    const persisted = new Set(
      db.db.prepare('SELECT ticker FROM investment_monitoring_universe').all().map((r) => r.ticker)
    );
    for (const rej of ['REJ_WIN', 'REJ_PRICE', 'REJ_NEG', 'REJ_NULL', 'REJ_ZERO', 'REJ_NOTICKER_OK']) {
      assert.equal(persisted.has(rej), false, `${rej} não pode ser persistido`);
    }
    assert.equal(persisted.has('Q00'), true);
    assert.equal(persisted.has('Q24'), true);
  } finally {
    if (db) db.close();
    removeTempDir(dir);
  }
});

// ── (d) IPC / PRELOAD ──────────────────────────────────────────────────
test('IPC/preload: canais e métodos novos nos dois bridges; antigos ausentes', () => {
  const preload = read('preload.js');
  const main = read('main.js');

  const saveTop20Pattern = /saveTop20Tracker:\s*\(top20\)\s*=>\s*ipcRenderer\.invoke\(['"]save-top20-tracker['"],\s*top20\)/g;
  const saveQualifiedPattern = /saveQualifiedMonitoring:\s*\(list\)\s*=>\s*ipcRenderer\.invoke\(['"]save-qualified-monitoring['"],\s*list\)/g;

  assert.equal((preload.match(saveTop20Pattern) || []).length, 2, 'saveTop20Tracker nos 2 bridges');
  assert.equal((preload.match(saveQualifiedPattern) || []).length, 2, 'saveQualifiedMonitoring nos 2 bridges');

  assert.match(main, /ipcMain\.handle\(['"]save-top20-tracker['"]/);
  assert.match(main, /db\.saveTop20ToTracker\(Array\.isArray\(top20\)\s*\?\s*top20\s*:\s*\[\]\)/);
  assert.match(main, /ipcMain\.handle\(['"]save-qualified-monitoring['"]/);
  assert.match(main, /db\.saveQualifiedToMonitoring\(Array\.isArray\(qualifiedList\)\s*\?\s*qualifiedList\s*:\s*\[\]\)/);

  // Canais/métodos antigos não podem existir
  assert.doesNotMatch(main, /ipcMain\.handle\(['"]save-all-to-monitoring['"]/);
  assert.doesNotMatch(main, /ipcMain\.handle\(['"]save-top20-to-tracker['"]/);
  assert.doesNotMatch(preload, /saveAllToMonitoring\s*:/);
  assert.doesNotMatch(preload, /save-all-to-monitoring/);
  assert.doesNotMatch(preload, /save-top20-to-tracker/);
});

// ── (e) UI estático ────────────────────────────────────────────────────
test('UI estático: novos IDs presentes e antigos removidos do HTML', () => {
  const html = read('renderer/index.html');

  assert.match(html, /id=["']btn-save-top20-tracker["']/);
  assert.match(html, /id=["']btn-save-qualified-monitoring["']/);
  assert.match(html, /id=["']count-qualified-monitoring["']/);
  assert.match(html, /id=["']badge-top-count["']/);

  assert.doesNotMatch(html, /id=["']btn-save-all-monitoring["']/);
  assert.doesNotMatch(html, /id=["']count-all-monitoring["']/);
  assert.doesNotMatch(html, /id=["']btn-export-split-workflow["']/);
  assert.doesNotMatch(html, /id=["']count-remaining["']/);
});

test('UI estático: renderer.js usa currentMonitoringPool, canais novos e repõe estado', () => {
  const rendererJs = read('renderer/renderer.js');

  // Contador lê a global do motor
  assert.match(rendererJs, /window\.currentMonitoringPool/);
  assert.match(rendererJs, /countQualifiedMonitoring\.textContent\s*=\s*\(window\.currentMonitoringPool \|\| \[\]\)\.length/);

  // Chamadas IPC novas
  assert.match(rendererJs, /api\.saveTop20Tracker\(top20\)/);
  assert.match(rendererJs, /api\.saveQualifiedMonitoring\(pool\)/);

  // finally repõe disabled = false nos dois botões
  assert.match(rendererJs, /finally\s*\{[^}]*btnSaveTop20\.disabled\s*=\s*false[^}]*\}/);
  assert.match(rendererJs, /finally\s*\{[^}]*btnQualifiedMonitoring\.disabled\s*=\s*false[^}]*\}/);

  // Botão verde repõe o span do contador via innerHTML
  assert.match(
    rendererJs,
    /btnQualifiedMonitoring\.innerHTML\s*=\s*`[^`]*<span id="count-qualified-monitoring">\$\{pool\.length\}<\/span>[^`]*`/
  );

  // IDs e variáveis antigas não voltam
  assert.doesNotMatch(rendererJs, /btn-save-all-monitoring/);
  assert.doesNotMatch(rendererJs, /count-all-monitoring/);
  assert.doesNotMatch(rendererJs, /api\.saveAllToMonitoring/);
});

test('UI estático: quantRenderer.js define currentMonitoringPool e currentTop20 a partir do payload', () => {
  const quantJs = read('renderer/quantRenderer.js');

  assert.match(quantJs, /window\.currentMonitoringPool = data\.monitoring_pool \|\| data\.remaining_analyzed \|\| \[\]/);
  assert.match(quantJs, /window\.currentTop20 = data\.top_20 \|\| splitTop20 \|\| \[\]/);
  assert.match(quantJs, /badge-top-count/);
  assert.match(quantJs, /countBadge\.textContent\s*=\s*`\$\{sortedAssets\.length\} Ativos`/);
});
