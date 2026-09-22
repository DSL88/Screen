'use strict';

/**
 * Motor Estatístico Local — Auto-Calibração do Modelo (Feedback Loop).
 *
 * Leitura direta do SQLite (better-sqlite3), avaliação da calibração das
 * probabilidades de Monte Carlo, taxa de falha setorial e otimização dos
 * pesos da fórmula de Alpha via Descida de Gradiente (Regressão Logística
 * em JS puro), gravando os novos parâmetros na tabela `model_calibrated_weights`.
 *
 * Telemetria exclusiva: registos CONCLUÍDOS de investment_monitoring_universe
 * (TARGET_ATINGIDO / STOP_ATINGIDO / EXPIRADO). Rede: nenhuma.
 */

const Database = require('better-sqlite3');

class ModelLearningEngine {
  /**
   * @param {string|Object} dbSource Caminho do ficheiro SQLite OU uma
   *        instância better-sqlite3 existente OU o wrapper DB da app
   *        (reutiliza a ligação compartilhada do processo principal).
   */
  constructor(dbSource) {
    if (typeof dbSource === 'string') {
      this._ownsConnection = true;
      this.db = new Database(dbSource);
    } else if (dbSource && dbSource.db && typeof dbSource.db.prepare === 'function') {
      // Wrapper DB da aplicação (src/db/database.js)
      this._ownsConnection = false;
      this.db = dbSource.db;
    } else if (dbSource && typeof dbSource.prepare === 'function') {
      // Instância better-sqlite3 direta
      this._ownsConnection = false;
      this.db = dbSource;
    } else {
      throw new Error('ModelLearningEngine requer um caminho SQLite ou uma ligação existente.');
    }
    this.initLearningSchema();
  }

  initLearningSchema() {
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS model_calibrated_weights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        weight_graham REAL DEFAULT 0.3,
        weight_mc REAL DEFAULT 0.4,
        weight_efficiency REAL DEFAULT 30.0,
        min_mc_threshold REAL DEFAULT 50.0,
        sector_penalties_json TEXT DEFAULT '{}',
        brier_score REAL,
        sample_size INTEGER
      )
    `).run();
  }

  close() {
    if (this._ownsConnection && this.db) {
      this.db.close();
    }
    this._ownsConnection = false;
  }

  // 1. Sigmoide para Regressão Logística (protegida contra overflow)
  sigmoid(z) {
    return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, z))));
  }

  // 2. Executar Auditoria Estatística e Treino Autónomo
  runStatisticalEvaluation(minSampleSize = 30) {
    // Consulta apenas os registos concluídos
    const stmt = this.db.prepare(`
      SELECT
        ticker,
        sector,
        win_rate_mc,
        cvar_95,
        expected_return,
        graham_score,
        status,
        realized_return_pct
      FROM investment_monitoring_universe
      WHERE status IN ('TARGET_ATINGIDO', 'STOP_ATINGIDO', 'EXPIRADO')
    `);

    const records = stmt.all();

    if (records.length < minSampleSize) {
      return {
        success: false,
        message: `Amostra insuficiente para treino estatístico. Registos concluídos: ${records.length}/${minSampleSize}.`,
        sampleSize: records.length,
        minSampleSize
      };
    }

    // A. Cálculo do Brier Score & Curva de Calibração
    let brierSum = 0;
    const tierCounts = {
      '50-54': { total: 0, hits: 0 },
      '55-59': { total: 0, hits: 0 },
      '60-64': { total: 0, hits: 0 },
      '65-69': { total: 0, hits: 0 },
      '70+': { total: 0, hits: 0 }
    };

    records.forEach((r) => {
      const y = r.status === 'TARGET_ATINGIDO' ? 1 : 0;
      const p = Math.min(1.0, Math.max(0.0, (r.win_rate_mc || 50) / 100.0));
      brierSum += Math.pow(p - y, 2);

      const wr = r.win_rate_mc;
      let tier = '50-54';
      if (wr >= 70) tier = '70+';
      else if (wr >= 65) tier = '65-69';
      else if (wr >= 60) tier = '60-64';
      else if (wr >= 55) tier = '55-59';

      tierCounts[tier].total++;
      if (y === 1) tierCounts[tier].hits++;
    });

    const brierScore = brierSum / records.length;

    // B. Análise Setorial e Matriz de Descontos (Penalizações)
    const sectorStats = {};
    records.forEach((r) => {
      const sec = r.sector || 'Geral';
      if (!sectorStats[sec]) sectorStats[sec] = { total: 0, hits: 0 };
      sectorStats[sec].total++;
      if (r.status === 'TARGET_ATINGIDO') sectorStats[sec].hits++;
    });

    const sectorPenalties = {};
    for (const [sec, data] of Object.entries(sectorStats)) {
      if (data.total >= 5) {
        const hitRate = data.hits / data.total;
        // Se a taxa de acerto real for inferior a 45%, penaliza
        // proporcionalmente (mínimo 0.60)
        if (hitRate < 0.45) {
          sectorPenalties[sec] = Math.max(0.60, Number((hitRate / 0.50).toFixed(2)));
        } else {
          sectorPenalties[sec] = 1.0;
        }
      } else {
        sectorPenalties[sec] = 1.0;
      }
    }

    // C. Regressão Logística em JS Puro para Calibração de Pesos de Alpha
    // Features normalizadas: [x1: Graham/100, x2: WinRateMC/100, x3: Eficiência (abs(ret)/cvar)]
    const X = [];
    const Y = [];

    records.forEach((r) => {
      const x1 = (r.graham_score || 50) / 100.0;
      const x2 = (r.win_rate_mc || 50) / 100.0;
      const cvar = Math.max(0.5, r.cvar_95 || 2.4);
      const x3 = Math.min(3.0, Math.abs(r.expected_return || 0) / cvar);

      X.push([x1, x2, x3]);
      Y.push(r.status === 'TARGET_ATINGIDO' ? 1 : 0);
    });

    // Otimização por Gradiente Descendente
    let w1 = 0.3, w2 = 0.4, w3 = 1.0; // Pesos base escalados
    const lr = 0.05;
    const epochs = 400;

    for (let epoch = 0; epoch < epochs; epoch++) {
      let grad1 = 0, grad2 = 0, grad3 = 0;

      for (let i = 0; i < X.length; i++) {
        const z = (w1 * X[i][0]) + (w2 * X[i][1]) + (w3 * X[i][2]);
        const yPred = this.sigmoid(z);
        const error = yPred - Y[i];

        grad1 += error * X[i][0];
        grad2 += error * X[i][1];
        grad3 += error * X[i][2];
      }

      w1 -= (lr * grad1) / X.length;
      w2 -= (lr * grad2) / X.length;
      w3 -= (lr * grad3) / X.length;
    }

    // Normalização dos novos pesos para a escala do sistema
    const totalW = Math.max(0.1, Math.abs(w1) + Math.abs(w2));
    const calibratedGraham = Number((Math.max(0.1, Math.abs(w1) / totalW) * 0.7).toFixed(2));
    const calibratedMC = Number((Math.max(0.2, Math.abs(w2) / totalW) * 0.7).toFixed(2));
    const calibratedEfficiency = Number((Math.max(10.0, Math.abs(w3) * 20.0)).toFixed(1));

    // Determina o limiar mínimo de MC: sobe se o patamar 50-54% tiver precisão < 35%
    let minMC = 50.0;
    if (tierCounts['50-54'].total >= 8 && (tierCounts['50-54'].hits / tierCounts['50-54'].total) < 0.35) {
      minMC = 55.0;
    }

    // D. Gravação dos Pesos Calibrados no SQLite
    this.db.prepare(`
      INSERT INTO model_calibrated_weights (
        weight_graham,
        weight_mc,
        weight_efficiency,
        min_mc_threshold,
        sector_penalties_json,
        brier_score,
        sample_size
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      calibratedGraham,
      calibratedMC,
      calibratedEfficiency,
      minMC,
      JSON.stringify(sectorPenalties),
      Number(brierScore.toFixed(4)),
      records.length
    );

    return {
      success: true,
      brierScore: Number(brierScore.toFixed(4)),
      sampleSize: records.length,
      weights: {
        graham: calibratedGraham,
        monteCarlo: calibratedMC,
        efficiency: calibratedEfficiency,
        minMCThreshold: minMC
      },
      sectorPenalties,
      tierCalibration: tierCounts
    };
  }

  // Amostra concluída disponível (para telemetria do painel)
  getConcludedSampleSize() {
    return this.db.prepare(`
      SELECT COUNT(*) AS n
      FROM investment_monitoring_universe
      WHERE status IN ('TARGET_ATINGIDO', 'STOP_ATINGIDO', 'EXPIRADO')
    `).get().n;
  }

  /**
   * Snapshot da curva de calibração (patamar MC + Brier) SEM treino — usado
   * pelo painel de telemetria no load da aba, mesmo com amostra < 30.
   */
  getCalibrationSnapshot() {
    const records = this.db.prepare(`
      SELECT win_rate_mc, status
      FROM investment_monitoring_universe
      WHERE status IN ('TARGET_ATINGIDO', 'STOP_ATINGIDO', 'EXPIRADO')
    `).all();

    const tierCounts = {
      '50-54': { total: 0, hits: 0 },
      '55-59': { total: 0, hits: 0 },
      '60-64': { total: 0, hits: 0 },
      '65-69': { total: 0, hits: 0 },
      '70+': { total: 0, hits: 0 }
    };
    let brierSum = 0;
    for (const r of records) {
      const y = r.status === 'TARGET_ATINGIDO' ? 1 : 0;
      const p = Math.min(1.0, Math.max(0.0, (r.win_rate_mc || 50) / 100.0));
      brierSum += Math.pow(p - y, 2);
      let tier = '50-54';
      const wr = r.win_rate_mc;
      if (wr >= 70) tier = '70+';
      else if (wr >= 65) tier = '65-69';
      else if (wr >= 60) tier = '60-64';
      else if (wr >= 55) tier = '55-59';
      tierCounts[tier].total++;
      if (y === 1) tierCounts[tier].hits++;
    }

    return {
      sampleSize: records.length,
      brierScore: records.length > 0 ? Number((brierSum / records.length).toFixed(4)) : null,
      tierCalibration: tierCounts
    };
  }

  // Devolve a última calibração ativa para consumo do Scanner e Workstation
  getLatestCalibration() {
    const row = this.db.prepare(`
      SELECT * FROM model_calibrated_weights ORDER BY id DESC LIMIT 1
    `).get();

    if (!row) {
      return {
        weight_graham: 0.3,
        weight_mc: 0.4,
        weight_efficiency: 30.0,
        min_mc_threshold: 50.0,
        sector_penalties: {}
      };
    }

    let penalties = {};
    try {
      penalties = JSON.parse(row.sector_penalties_json || '{}') || {};
    } catch (_) {
      penalties = {};
    }

    return {
      weight_graham: row.weight_graham,
      weight_mc: row.weight_mc,
      weight_efficiency: row.weight_efficiency,
      min_mc_threshold: row.min_mc_threshold,
      sector_penalties: penalties,
      brier_score: row.brier_score,
      sample_size: row.sample_size,
      updated_at: row.updated_at
    };
  }
}

module.exports = ModelLearningEngine;
