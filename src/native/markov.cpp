#include "markov.hpp"

#include <algorithm>
#include <cmath>

namespace {

constexpr int kNumStates = 9;
constexpr double kLaplaceAlpha = 0.1;

inline int classifyState(double bbPctVal, double adxVal) {
  if (!std::isfinite(bbPctVal) || !std::isfinite(adxVal)) return -1;
  const int bbZone = bbPctVal < 0.33 ? 0 : (bbPctVal > 0.66 ? 2 : 1);
  const int adxZone = adxVal < 20.0 ? 0 : (adxVal > 40.0 ? 2 : 1);
  return bbZone + adxZone * 3;
}

} // namespace

MarkovModelResult computeMarkovEngineNative(const std::vector<double>& bbPct,
                                            const std::vector<double>& adx,
                                            size_t window) {
  MarkovModelResult result;
  result.currentState = -1;
  result.transitionMatrix.assign(kNumStates,
                                 std::vector<double>(kNumStates, kLaplaceAlpha));

  const size_t n = std::min(bbPct.size(), adx.size());
  if (n == 0) return result;

  // Série de estados; NaN/infinito → -1 (equivalente a null em JS)
  std::vector<int> states(n, -1);
  for (size_t i = 0; i < n; ++i) {
    states[i] = classifyState(bbPct[i], adx[i]);
  }
  result.currentState = states[n - 1];

  // Contagem de transições na janela [max(0, n-window), n-1)
  size_t start = 0;
  if (window < n) start = n - window;

  for (size_t i = start; i + 1 < n; ++i) {
    const int a = states[i];
    const int b = states[i + 1];
    if (a < 0 || b < 0) continue;
    result.transitionMatrix[a][b] += 1.0;
  }

  // Normalização por linha (rowSum <= 0 → identidade, paridade JS)
  for (int i = 0; i < kNumStates; ++i) {
    double rowSum = 0.0;
    for (int j = 0; j < kNumStates; ++j) rowSum += result.transitionMatrix[i][j];
    if (rowSum > 0.0) {
      for (int j = 0; j < kNumStates; ++j) result.transitionMatrix[i][j] /= rowSum;
    } else {
      result.transitionMatrix[i][i] = 1.0;
    }
  }

  return result;
}
