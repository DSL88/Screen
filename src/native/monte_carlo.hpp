// ─────────────────────────────────────────────────────────────
//  monte_carlo.hpp – Simulação de Monte Carlo nativa
//
//  Paridade com src/quant/monteCarloEngine.js:
//    Por dia: 1º draw = transição de estado (sampleState);
//             2º draw = retorno APENAS se a linha do estado
//             não estiver vazia (senão preço fica).
//    LONG : tp = p0*(1+tp), sl = p0*(1-sl); TP price>=tp, SL price<=sl
//    SHORT: tp = p0*(1-tp), sl = p0*(1+sl); TP price<=tp, SL price>=sl
//    Escalões: winRate >= 65 → ELITE | >= 50 → MODERATE | senão REJECTED
// ─────────────────────────────────────────────────────────────
#pragma once

#include <cstdint>
#include <string>
#include <vector>

struct MonteCarloResult {
  double winRate = 0.0;
  int tpHits = 0;
  int slHits = 0;
  int expired = 0;
  bool mcApproved = false;
  std::string mcTier;
  std::string mcLabel;
  double expectedValue = 0.0;
};

MonteCarloResult runMonteCarloSimulationNative(
    const std::vector<std::vector<double>>& matrix,        // 9×9
    const std::vector<std::vector<double>>& returnsByState, // ragged, 9 linhas
    int currentState,
    double startPrice,
    int iterations,
    int daysAhead,
    double slPct,
    double tpPct,
    const char* side, // "LONG" | "SHORT"
    bool useSeed,
    uint32_t seed);
