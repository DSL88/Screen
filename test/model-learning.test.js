'use strict';

/**
 * Motor Estatístico Local (ModelLearningEngine) — feedback loop da monitorização:
 *  (a) MOTOR — leitura direta do SQLite, Brier Score exato, curva de calibração
 *      por patamar MC, matriz de penalização setorial (>= 5 amostras, hit rate
 *      < 45%, floor 0.60), gate de amostra (>= 30) e recalibração via
 *      Descida de Gradiente (Regressão Logística em JS puro).
 *  (b) DB — colunas expected_return/realized_return_pct, gravação e snapshot.
 *  (c) IPC/PRELOAD estático — canais train-model-calibration e
 *      get-calibrated-weights, guardas do motor, injeção da última calibração
 *      nos payloads do screener e métodos nos 2 bridges.
 *  (d) PYTHON — pesos calibrados (snake_case) aplicados no motor de triagem.
 *  (e) UI — painel de auto-calibração com gráfico Teórico vs. Real (Chart.js).
 *
 * Rede real: nenhuma. SQLite sempre temporário.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const childProcess = require('child_process');
const { makeTempDir, removeTempDir } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const ModelLearningEngine = require('../src/engine/modelLearningEngine');

let DB = null;
let SQLITE_AVAILABLE = false;
try {
  require('better-sqlite3');
  DB = require('../src/db/database');
  SQLITE_AVAILABLE = true;
} catch (_) {
  // ABI nativo indisponível: os testes de DB ficam em skip.
}

// Isola o sync do tracker canónico.
const NOSYNC_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'test-model-learning-nosync-'));
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

// ── helpers ────────────────────────────────────────────────────────────
function row(overrides = {}) {
  return {
    ticker: 'AAA',
    sector: 'Tecnologia',
    direction: 'COMPRA',
    entry_price: 100,
    target_price: 104.8,
    stop_loss: 97.6,
    cvar_95: 4,
    expected_return: 0.048,
    win_rate_mc: 60,
    graham_score: 60,
    status: 'TARGET_ATINGIDO',
    pnl_pct: 4.8,
    ...overrides
  };
}

// 60 concluídos: 30 "BOM" (MC 75% → target) e 30 "MAU" (MC 52% → stop).
// Graham é ruído não correlacionado e expected_return/cvar constantes.
function buildCorrelatedDataset() {
  const rows = [];
  for (let i = 0; i < 30; i++) {
    rows.push(row({ ticker: `G${i}`, win_rate_mc: 75, graham_score: 50 + (i % 40), status: 'TARGET_ATINGIDO', pnl_pct: 4.8 }));
  }
  for (let i = 0; i < 30; i++) {
    rows.push(row({ ticker: `B${i}`, win_rate_mc: 52, graham_score: 50 + (i % 40), status: 'STOP_ATINGIDO', pnl_pct: -2.4 }));
  }
  return rows;
}

function insertMonitoringRows(db, rows) {
  const stmt = db.db.prepare(`
    INSERT INTO investment_monitoring_universe (
      ticker, sector, direction, entry_price, target_price, stop_loss,
      cvar_95, expected_return, win_rate_mc, graham_score, analysis_date, status, pnl_pct
    ) VALUES (
      @ticker, @sector, @direction, @entry_price, @target_price, @stop_loss,
      @cvar_95, @expected_return, @win_rate_mc, @graham_score, '2026-01-05', @status, @pnl_pct
    )
  `);
  for (const r of rows) stmt.run(r);
}

async function withEngine(fn) {
  const dir = makeTempDir('test-model-learning-');
  let db;
  try {
    db = new DB(dir);
    await db.init();
    const engine = new ModelLearningEngine(db);
    await fn(db, engine);
  } finally {
    if (db) db.close();
    removeTempDir(dir);
  }
}

// ── (a) MOTOR ──────────────────────────────────────────────────────────
test('MOTOR: gate de amostra — < 30 concluídos devolve success false sem gravar', { skip: !SQLITE_AVAILABLE }, async () => {
  await withEngine(async (db, engine) => {
    insertMonitoringRows(db, buildCorrelatedDataset().slice(0, 29));

    const res = engine.runStatisticalEvaluation(30);
    assert.equal(res.success, false);
    assert.match(res.message, /Registos concluídos: 29\/30/);

    // Nada gravado na tabela de calibração
    const count = engine.db.prepare('SELECT COUNT(*) AS n FROM model_calibrated_weights').get().n;
    assert.equal(count, 0);
    // Defaults ativos
    const latest = engine.getLatestCalibration();
    assert.deepEqual(latest, {
      weight_graham: 0.3,
      weight_mc: 0.4,
      weight_efficiency: 30.0,
      min_mc_threshold: 50.0,
      sector_penalties: {}
    });
  });
});

test('MOTOR: treino >= 30 — Brier exato, curva de calibração e gravação no SQLite', { skip: !SQLITE_AVAILABLE }, async () => {
  await withEngine(async (db, engine) => {
    const rows = buildCorrelatedDataset();
    insertMonitoringRows(db, rows);

    const res = engine.runStatisticalEvaluation(30);
    assert.equal(res.success, true);
    assert.equal(res.sampleSize, 60);

    // Brier = média((p - y)²): p=0.75/y=1 → 0.25²; p=0.52/y=0 → 0.52²
    assert.equal(res.brierScore, 0.1665);

    const tier50 = res.tierCalibration['50-54'];
    const tier70 = res.tierCalibration['70+'];
    assert.equal(tier50.total, 30);
    assert.equal(tier50.hits, 0);
    assert.equal(tier70.total, 30);
    assert.equal(tier70.hits, 30);
    assert.equal(res.tierCalibration['55-59'].total, 0);

    // Pesos gravados e legíveis via getLatestCalibration
    const latest = engine.getLatestCalibration();
    assert.equal(latest.weight_graham, res.weights.graham);
    assert.equal(latest.weight_mc, res.weights.monteCarlo);
    assert.equal(latest.weight_efficiency, res.weights.efficiency);
    assert.equal(latest.min_mc_threshold, res.weights.minMCThreshold);
    assert.equal(latest.brier_score, res.brierScore);
    assert.equal(latest.sample_size, 60);
    assert.equal(latest.updated_at != null, true);
  });
});

test('MOTOR: regressão logística (gradiente) — MC preditivo domina Graham ruído', { skip: !SQLITE_AVAILABLE }, async () => {
  await withEngine(async (db, engine) => {
    insertMonitoringRows(db, buildCorrelatedDataset());
    const res = engine.runStatisticalEvaluation(30);

    // MC é o fator preditivo do dataset → peso MC >= peso Graham
    assert.ok(res.weights.monteCarlo >= res.weights.graham,
      `esperado MC >= Graham (MC=${res.weights.monteCarlo}, G=${res.weights.graham})`);

    // Escala do sistema: graham + mc dividem 0.7; eficiência ∈ [10, 60]
    assert.ok(res.weights.graham >= 0.1 && res.weights.graham <= 0.7);
    assert.ok(res.weights.monteCarlo >= 0.2 && res.weights.monteCarlo <= 0.7);
    assert.ok(res.weights.efficiency >= 10.0);

    // Determinismo
    const second = engine.runStatisticalEvaluation(30);
    assert.deepEqual(res.weights, second.weights);
    assert.equal(res.brierScore, second.brierScore);
    assert.equal(engine.db.prepare('SELECT COUNT(*) AS n FROM model_calibrated_weights').get().n, 2);
  });
});

test('MOTOR: matriz setorial — >= 5 amostras e hit rate < 45% penaliza com floor 0.60', { skip: !SQLITE_AVAILABLE }, async () => {
  await withEngine(async (db, engine) => {
    const rows = [];
    // Fraco: 3 targets / 12 = 25% → max(0.6, 0.25/0.5) = 0.60
    for (let i = 0; i < 3; i++) rows.push(row({ ticker: `FT${i}`, sector: 'Fraco', status: 'TARGET_ATINGIDO' }));
    for (let i = 0; i < 9; i++) rows.push(row({ ticker: `FS${i}`, sector: 'Fraco', status: 'STOP_ATINGIDO' }));
    // Médio: 2 targets / 5 = 40% → 0.40/0.5 = 0.80
    for (let i = 0; i < 2; i++) rows.push(row({ ticker: `MT${i}`, sector: 'Medio', status: 'TARGET_ATINGIDO' }));
    for (let i = 0; i < 3; i++) rows.push(row({ ticker: `MS${i}`, sector: 'Medio', status: 'STOP_ATINGIDO' }));
    // Bom: 10/10 = 100% → 1.0
    for (let i = 0; i < 10; i++) rows.push(row({ ticker: `BT${i}`, sector: 'Bom', status: 'TARGET_ATINGIDO' }));
    // Pequeno: 0/4 → hit rate < 45% mas amostra < 5 → 1.0
    for (let i = 0; i < 4; i++) rows.push(row({ ticker: `PS${i}`, sector: 'Pequeno', status: 'STOP_ATINGIDO' }));
    insertMonitoringRows(db, rows);

    const res = engine.runStatisticalEvaluation(30);
    assert.equal(res.success, true, 'amostra de 31 registos concluídos');
    assert.equal(res.sectorPenalties.Fraco, 0.6);
    assert.equal(res.sectorPenalties.Medio, 0.8);
    assert.equal(res.sectorPenalties.Bom, 1.0);
    assert.equal(res.sectorPenalties.Pequeno, 1.0);

    // Persistido em JSON
    const latest = engine.getLatestCalibration();
    assert.deepEqual(latest.sector_penalties, { Fraco: 0.6, Medio: 0.8, Bom: 1.0, Pequeno: 1.0 });
  });
});

test('MOTOR: limiar mínimo de MC sobe para 55 se o patamar 50-54 falhar (< 35%, >= 8 amostras)', { skip: !SQLITE_AVAILABLE }, async () => {
  await withEngine(async (db, engine) => {
    // 50-54: 30 rows, 0 hits → < 35% → minMC 55
    insertMonitoringRows(db, buildCorrelatedDataset());
    const res = engine.runStatisticalEvaluation(30);
    assert.equal(res.weights.minMCThreshold, 55.0);
  });

  await withEngine(async (db, engine) => {
    // 50-54 com precisão >= 35% → mantém 50
    const rows = [];
    for (let i = 0; i < 30; i++) rows.push(row({ ticker: `G${i}`, win_rate_mc: 75, status: 'TARGET_ATINGIDO' }));
    for (let i = 0; i < 30; i++) {
      rows.push(row({ ticker: `M${i}`, win_rate_mc: 52, status: i < 11 ? 'TARGET_ATINGIDO' : 'STOP_ATINGIDO' }));
    }
    insertMonitoringRows(db, rows);
    const res = engine.runStatisticalEvaluation(30);
    assert.equal(res.weights.minMCThreshold, 50.0);
  });

  await withEngine(async (db, engine) => {
    // 50-54 com precisão < 35% mas só 7 amostras → mantém 50
    const rows = [];
    for (let i = 0; i < 23; i++) rows.push(row({ ticker: `G${i}`, win_rate_mc: 75, status: 'TARGET_ATINGIDO' }));
    for (let i = 0; i < 7; i++) rows.push(row({ ticker: `M${i}`, win_rate_mc: 52, status: 'STOP_ATINGIDO' }));
    insertMonitoringRows(db, rows);
    const res = engine.runStatisticalEvaluation(30);
    assert.equal(res.weights.minMCThreshold, 50.0);
  });
});

test('MOTOR: snapshot de calibração sem treino — Brier e contagem por patamar', { skip: !SQLITE_AVAILABLE }, async () => {
  await withEngine(async (db, engine) => {
    // Universo vazio
    let snap = engine.getCalibrationSnapshot();
    assert.equal(snap.sampleSize, 0);
    assert.equal(snap.brierScore, null);

    insertMonitoringRows(db, [
      row({ ticker: 'A', win_rate_mc: 75, status: 'TARGET_ATINGIDO' }),
      row({ ticker: 'B', win_rate_mc: 52, status: 'STOP_ATINGIDO' })
    ]);
    snap = engine.getCalibrationSnapshot();
    assert.equal(snap.sampleSize, 2);
    assert.equal(snap.brierScore, 0.1665);
    assert.equal(snap.tierCalibration['70+'].total, 1);
    assert.equal(snap.tierCalibration['50-54'].total, 1);

    // Registos em monitorização ativa não entram
    db.db.prepare(`
      INSERT INTO investment_monitoring_universe (ticker, direction, entry_price, target_price, stop_loss, analysis_date, status)
      VALUES ('P', 'COMPRA', 100, 104.8, 97.6, '2026-01-05', 'MONITORIZANDO')
    `).run();
    assert.equal(engine.getCalibrationSnapshot().sampleSize, 2);
  });
});

test('MOTOR: modos de construção — caminho SQLite direto e ligação compartilhada', { skip: !SQLITE_AVAILABLE }, async () => {
  const dir = makeTempDir('test-model-learning-modes-');
  let db;
  let pathEngine = null;
  try {
    db = new DB(dir);
    await db.init();

    // Modo wrapper (compartilhado)
    const shared = new ModelLearningEngine(db);
    assert.equal(shared.db, db.db);
    shared.runStatisticalEvaluation(30); // universo vazio → success false, não lança

    // Modo caminho direto (dono da ligação)
    const dbFile = path.join(dir, 'trades.db');
    pathEngine = new ModelLearningEngine(dbFile);
    assert.notEqual(pathEngine.db, db.db);
    const res = pathEngine.getLatestCalibration();
    assert.equal(res.weight_mc, 0.4, 'tabela criada no ficheiro próprio com defaults');
    pathEngine.close();
    pathEngine = null;

    assert.throws(() => new ModelLearningEngine(42), /caminho SQLite|ligação/);
  } finally {
    if (pathEngine) pathEngine.close();
    if (db) db.close();
    removeTempDir(dir);
  }
});

// ── (b) DB ─────────────────────────────────────────────────────────────
test('DB: colunas de telemetria expected_return e realized_return_pct', { skip: !SQLITE_AVAILABLE }, async () => {
  const dir = makeTempDir('test-model-learning-cols-');
  let db;
  try {
    db = new DB(dir);
    await db.init();

    const cols = db.db.prepare('PRAGMA table_info(investment_monitoring_universe)').all().map((c) => c.name);
    assert.equal(cols.includes('expected_return'), true);
    assert.equal(cols.includes('realized_return_pct'), true);

    // saveQualifiedToMonitoring: default ±0.048 pela direção
    db.saveQualifiedToMonitoring([
      { ticker: 'BUY1', direction: 'COMPRA', current_price: 100, target_price: 104.8, stop_loss: 97.6, win_rate_mc: 60, cvar_95: 4, graham_score: 60, alpha_score: 80 },
      { ticker: 'SELL1', direction: 'VENDA', current_price: 200, target_price: 190.4, stop_loss: 204.8, win_rate_mc: 60, cvar_95: 4, graham_score: 60, alpha_score: 80 },
      { ticker: 'ER1', direction: 'COMPRA', current_price: 100, target_price: 104.8, stop_loss: 97.6, win_rate_mc: 60, cvar_95: 4, graham_score: 60, alpha_score: 80, expected_return: 0.07 }
    ]);
    const stored = {};
    for (const r of db.db.prepare('SELECT ticker, expected_return FROM investment_monitoring_universe').all()) {
      stored[r.ticker] = r.expected_return;
    }
    assert.equal(stored.BUY1, 0.048);
    assert.equal(stored.SELL1, -0.048);
    assert.equal(stored.ER1, 0.07);
  } finally {
    if (db) db.close();
    removeTempDir(dir);
  }
});

// ── (c) IPC / PRELOAD estático ─────────────────────────────────────────
test('IPC/preload: canais de treino e calibração ativa nos 2 bridges', () => {
  const main = read('main.js');
  const preload = read('preload.js');

  assert.match(main, /new ModelLearningEngine\(db\)/);
  assert.match(main, /ipcMain\.handle\(['"]train-model-calibration['"]/);
  assert.match(main, /ipcMain\.handle\(['"]get-calibrated-weights['"]/);
  assert.match(main, /learningEngine\.runStatisticalEvaluation\(30\)/);
  assert.match(main, /learningEngine\.getLatestCalibration\(\)/);
  assert.match(main, /learningEngine\.getCalibrationSnapshot\(\)/);
  assert.doesNotMatch(main, /train-monitoring-model/);

  // Guardas: motor não inicializado
  const trainBlock = main.slice(main.indexOf("ipcMain.handle('train-model-calibration'"), main.indexOf("ipcMain.handle('train-model-calibration'") + 500);
  assert.match(trainBlock, /if \(!learningEngine\)/);
  const calibBlock = main.slice(main.indexOf("ipcMain.handle('get-calibrated-weights'"), main.indexOf("ipcMain.handle('get-calibrated-weights'") + 500);
  assert.match(calibBlock, /if \(!learningEngine\)/);

  // Última calibração injetada nos varrimentos futuros
  assert.match(main, /enrichedPayload\.model_weights = learningEngine\.getLatestCalibration\(\)/);

  const trainPattern = /trainModelCalibration:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(['"]train-model-calibration['"]\)/g;
  const calibPattern = /getCalibratedWeights:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(['"]get-calibrated-weights['"]\)/g;
  const statusPattern = /getModelTrainingStatus:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(['"]get-model-training-status['"]\)/g;
  assert.equal((preload.match(trainPattern) || []).length, 2, 'trainModelCalibration nos 2 bridges');
  assert.equal((preload.match(calibPattern) || []).length, 2, 'getCalibratedWeights nos 2 bridges');
  assert.equal((preload.match(statusPattern) || []).length, 2, 'getModelTrainingStatus nos 2 bridges');
  assert.doesNotMatch(preload, /trainMonitoringModel/);
});

test('PYTHON estático: pesos calibrados (snake_case) extraídos e aplicados no motor de triagem', () => {
  const py = read('python_engine/run_pipeline.py');
  assert.match(py, /def _extract_model_weights\(params: Dict\[str, Any\]\)/);
  assert.match(py, /params\.get\("model_weights"\)/);
  assert.match(py, /_get\("weightGraham", "weight_graham", default=0\.3\)/);
  assert.match(py, /_get\("weightMc", "weight_mc", default=0\.4\)/);
  assert.match(py, /_get\("weightEfficiency", "weight_efficiency", default=30\.0\)/);
  assert.match(py, /_get\("minMcThreshold", "min_mc_threshold", default=50\.0\)/);
  assert.match(py, /_get\("sectorPenalties", "sector_penalties", default=\{\}\)/);
  assert.match(py, /if win_rate < min_mc_threshold:/);
  assert.match(py, /alpha = \(quality_score \* w_graham\) \+ \(win_rate \* w_mc\) \+ \(efficiency \* w_efficiency\)/);
  assert.match(py, /alpha \*= sector_penalty/);
});

// ── (d) PYTHON runtime (determinístico, sem rede) ──────────────────────
const VENV_PYTHON = path.join(ROOT, '.venv', 'bin', 'python');
const MODEL_WEIGHTS_SCRIPT = `
import json
from python_engine.run_pipeline import consolidate_and_split_pipeline

assets = []
for i in range(3):
    assets.append({
        "ticker": "A%d" % i,
        "current_price": 100.0,
        "mc_win_rate": 80.0,
        "cvar_95": 4.0,
        "expected_return": 0.05,
        "graham_score": 70.0,
        "sector": "Tech" if i == 0 else "Energy",
        "signal_direction": "COMPRA",
    })
rejected = [{
    "ticker": "R1",
    "current_price": 100.0,
    "mc_win_rate": 45.0,
    "cvar_95": 4.0,
    "expected_return": 0.05,
    "graham_score": 70.0,
    "sector": "Tech",
}]

calibrated = {
    "weight_graham": 0.3,
    "weight_mc": 0.4,
    "weight_efficiency": 30.0,
    "min_mc_threshold": 50.0,
    "sector_penalties": {"Energy": 0.6},
}
res = consolidate_and_split_pipeline(assets + rejected, horizon_days=35, model_weights=calibrated)
by = {}
for a in res["top_20"] + res["monitoring_pool"]:
    by[a["ticker"]] = a

print(json.dumps({
    "cleanAlpha": by["A0"]["alpha_score"],
    "penalizedAlpha": by["A1"]["alpha_score"],
    "rejectedIncluded": "R1" in by,
}))

res2 = consolidate_and_split_pipeline(assets + rejected, horizon_days=35, model_weights={
    "weight_graham": 0.3, "weight_mc": 0.4, "weight_efficiency": 30.0,
    "min_mc_threshold": 40.0, "sector_penalties": {},
})
by2 = {a["ticker"] for a in res2["top_20"] + res2["monitoring_pool"]}
print(json.dumps({"threshold40Included": "R1" in by2}))

res3 = consolidate_and_split_pipeline(assets + rejected, horizon_days=35)
by3 = {a["ticker"] for a in res3["top_20"] + res3["monitoring_pool"]}
print(json.dumps({"defaultExcludes45": "R1" not in by3}))
`;

test('PYTHON runtime: calibração ativa aplica threshold, alpha e penalização setorial', { skip: !fs.existsSync(VENV_PYTHON) }, () => {
  const result = childProcess.spawnSync(VENV_PYTHON, ['-c', MODEL_WEIGHTS_SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000
  });
  assert.equal(result.status, 0, `python falhou: ${result.stderr}`);
  const lines = (result.stdout || '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

  const [first, threshold, defaults] = lines;

  assert.equal(first.cleanAlpha, 53.4);
  assert.equal(first.rejectedIncluded, false);
  assert.equal(first.penalizedAlpha, Math.round(53.36 * 0.6 * 10) / 10);
  assert.equal(first.penalizedAlpha < first.cleanAlpha, true);

  assert.equal(threshold.threshold40Included, true, 'threshold calibrado 40 inclui MC=45');
  assert.equal(defaults.defaultExcludes45, true, 'sem calibração, threshold 50 exclui MC=45');
});

// ── (e) UI estática ────────────────────────────────────────────────────
test('UI estática: painel de auto-calibração com gráfico Teórico vs Real e cartões de diagnóstico', () => {
  const html = read('renderer/index.html');

  assert.match(html, /id="btn-train-model"/);
  assert.match(html, /Treinar e Calibrar Pesos/);
  assert.match(html, /Auto-Calibração &amp; Telemetria do Modelo/);
  assert.match(html, /id="calibrationChart"/);
  assert.match(html, /id="stat-brier"/);
  assert.match(html, /id="stat-weights"/);
  assert.match(html, /id="stat-sectors"/);
  // Modal antigo removido (diagnóstico inline)
  assert.doesNotMatch(html, /modal-train-report/);
});

test('UI estática: renderer controla o gráfico de calibração e o fluxo de treino', () => {
  const renderer = read('renderer/renderer.js');

  assert.match(renderer, /let calibrationChartInstance = null/);
  assert.match(renderer, /function renderCalibrationChart\(tierData\)/);
  assert.match(renderer, /Previsão MC Teórica/);
  assert.match(renderer, /Acerto Real Observado/);
  assert.match(renderer, /\[52\.5, 57\.5, 62\.5, 67\.5, 75\.0\]/);
  assert.match(renderer, /api\.trainModelCalibration\(\)/);
  assert.match(renderer, /alert\(res && res\.message \? res\.message/);
  assert.match(renderer, /api\.getModelTrainingStatus\(\)/);
  assert.match(renderer, /Graham: \$\{Number\(w\.graham\)\.toFixed\(2\)\} \| MC: \$\{Number\(w\.monteCarlo\)/);
  assert.match(renderer, /Nenhum setor degradado/);
  assert.doesNotMatch(renderer, /trainMonitoringModel/);
  assert.doesNotMatch(renderer, /modal-train-report/);

  const tabFn = renderer.slice(
    renderer.indexOf('async function loadMonitoringTab()'),
    renderer.indexOf('async function loadMonitoringTab()') + 700
  );
  assert.match(tabFn, /refreshTrainingPanel\(\)/);
});
