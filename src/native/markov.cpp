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

// Spec Passo 4 – 6 estados (closes/adx/bbUpper/bbLower)
MarkovResult computeMarkovEngineNative(
    const double* closes,
    const double* adx,
    const double* bbUpper,
    const double* bbLower,
    size_t length,
    size_t windowSize
) {
    MarkovResult res;
    res.isValid = false;
    if (length < windowSize || windowSize < 10) {
        return res;
    }
    const int NUM_STATES = 6;
    res.transitionMatrix.assign(NUM_STATES, std::vector<double>(NUM_STATES, 0.0));
    res.stateReturns.assign(NUM_STATES, std::vector<double>());
    std::vector<int> states(length, 0);
    for (size_t i = 0; i < length; ++i) {
        bool strongTrend = (adx[i] >= 25.0);
        bool aboveUpper = (closes[i] >= bbUpper[i]);
        bool belowLower = (closes[i] <= bbLower[i]);
        if (strongTrend) {
            if (aboveUpper) states[i] = 0;
            else if (belowLower) states[i] = 1;
            else states[i] = 2;
        } else {
            if (aboveUpper) states[i] = 3;
            else if (belowLower) states[i] = 4;
            else states[i] = 5;
        }
    }
    size_t startIdx = length - windowSize;
    std::vector<std::vector<int>> counts(NUM_STATES, std::vector<int>(NUM_STATES, 0));
    std::vector<int> rowSums(NUM_STATES, 0);
    for (size_t i = startIdx; i < length - 1; ++i) {
        int sFrom = states[i];
        int sTo = states[i + 1];
        counts[sFrom][sTo]++;
        rowSums[sFrom]++;
        double ret = (closes[i + 1] - closes[i]) / closes[i];
        res.stateReturns[sFrom].push_back(ret);
    }
    for (int i = 0; i < NUM_STATES; ++i) {
        for (int j = 0; j < NUM_STATES; ++j) {
            if (rowSums[i] > 0) {
                res.transitionMatrix[i][j] = static_cast<double>(counts[i][j]) / static_cast<double>(rowSums[i]);
            } else {
                res.transitionMatrix[i][j] = (i == j) ? 1.0 : 0.0;
            }
        }
    }
    res.currentState = states[length - 1];
    res.isValid = true;
    return res;
}
