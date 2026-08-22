// ─────────────────────────────────────────────────────────────
//  monte_carlo.cpp – Motor de Monte Carlo nativo
//
//  RNG determinístico: mulberry32 canónico (bit-a-bit idêntico ao JS)
//  RNG rápido (sem seed): mt19937_64 semeado por random_device
//
//  Ordem de draws por dia (paridade com src/quant/monteCarloEngine.js):
//    1º draw → transição de estado (sampleState, SEMPRE)
//    2º draw → retorno APENAS se a linha do estado não estiver vazia
// ─────────────────────────────────────────────────────────────
#include "monte_carlo.hpp"

#include <cmath>
#include <random>

namespace {

inline uint32_t imul(uint32_t x, uint32_t y) {
  return static_cast<uint32_t>((static_cast<uint64_t>(x) * y) & 0xFFFFFFFFu);
}

// mulberry32 — implementação fiel do canónico JS:
//   function mulberry32(a){return function(){
//     a|=0; a=a+0x6D2B79F5|0;
//     var t=Math.imul(a^a>>>15,1|a);
//     t=t+Math.imul(t^(t>>>7),61|t)^t;
//     return((t^(t>>>14))>>>0)/4294967296}}
struct Mulberry32 {
  uint32_t a_;
  explicit Mulberry32(uint32_t seed) : a_(seed) {}

  inline uint32_t nextU32() {
    a_ += 0x6D2B79F5u;
    uint32_t t = a_;
    t = imul(t ^ (t >> 15), 1u | t);
    t = (t + imul(t ^ (t >> 7), 61u | t)) ^ t;
    return t ^ (t >> 14);
  }

  inline double next() { return static_cast<double>(nextU32()) / 4294967296.0; }
};

// Caminho rápido sem seed: SplitMix64 (muito mais leve que mt19937_64)
// → double em [0, 1) com 53 bits. Estatisticamente equivalente; o caminho
// determinístico (com seed) continua a usar Mulberry32 para paridade JS.
inline uint64_t splitmix64(uint64_t& s) {
  s += 0x9E3779B97F4A7C15ull;
  uint64_t z = s;
  z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ull;
  z = (z ^ (z >> 27)) * 0x94D049BB133111EBull;
  return z ^ (z >> 31);
}

struct FastRng {
  uint64_t s_;
  FastRng() {
    const uint32_t hi = std::random_device{}();
    const uint32_t lo = std::random_device{}();
    s_ = (static_cast<uint64_t>(hi) << 32) | static_cast<uint64_t>(lo);
    if (s_ == 0) s_ = 0x9E3779B97F4A7C15ull;
  }
  inline double next() {
    return static_cast<double>(splitmix64(s_) >> 11) * (1.0 / 9007199254740992.0);
  }
};

// Paridade com sampleState() do JS: primeiro índice com r <= acumulado,
// fallback último índice. As acumuladas são pré-calculadas UMA vez por
// chamada com exatamente a mesma ordem de somas sequenciais → decisões
// bit-idênticas às do cálculo on-the-fly.
inline void buildCumulativeRows(const std::vector<std::vector<double>>& matrix,
                                std::vector<std::vector<double>>& out) {
  out.assign(matrix.size(), {});
  for (size_t i = 0; i < matrix.size(); ++i) {
    out[i].resize(matrix[i].size());
    double cumulative = 0.0;
    for (size_t j = 0; j < matrix[i].size(); ++j) {
      cumulative += matrix[i][j];
      out[i][j] = cumulative;
    }
  }
}

inline size_t sampleState(const std::vector<double>& cum, double r) {
  const size_t n = cum.size();
  for (size_t i = 0; i < n; ++i) {
    if (r <= cum[i]) return i;
  }
  return n - 1;
}

template <typename Rng>
void simulate(MonteCarloResult& result,
              const std::vector<std::vector<double>>& cumRows,
              const std::vector<std::vector<double>>& matrix,
              const std::vector<std::vector<double>>& returnsByState,
              size_t startState,
              double startPrice,
              int iterations,
              int daysAhead,
              double slPct,
              double tpPct,
              bool isShort,
              Rng& rng) {
  // TP/SL fixos sobre o preço de entrada, calculados uma vez (paridade JS)
  const double tpPrice = startPrice * (1.0 + (isShort ? -tpPct : tpPct));
  const double slPrice = startPrice * (1.0 + (isShort ? slPct : -slPct));

  const size_t numMatrixRows = matrix.size();
  const size_t numReturnRows = returnsByState.size();

  result.tpHits = 0;
  result.slHits = 0;
  result.expired = 0;

  for (int iter = 0; iter < iterations; ++iter) {
    double price = startPrice;
    size_t state = startState;
    bool exited = false;

    for (int d = 0; d < daysAhead; ++d) {
      // Defensivo: linha de transição vazia/malformada (input ragged)
      if (state >= cumRows.size() || cumRows[state].empty()) continue;
      state = sampleState(cumRows[state], rng.next());
      if (state >= numMatrixRows) state = numMatrixRows - 1;

      if (state >= numReturnRows) continue; // defensivo: sem linha de retornos
      const std::vector<double>& returns = returnsByState[state];
      if (returns.empty()) continue; // linha vazia → NÃO consome draw de retorno

      size_t idx = static_cast<size_t>(
          rng.next() * static_cast<double>(returns.size()));
      if (idx >= returns.size()) idx = returns.size() - 1; // clamp defensivo
      price *= (1.0 + returns[idx]);

      if (isShort) {
        if (price <= tpPrice) { ++result.tpHits; exited = true; break; }
        if (price >= slPrice) { ++result.slHits; exited = true; break; }
      } else {
        if (price >= tpPrice) { ++result.tpHits; exited = true; break; }
        if (price <= slPrice) { ++result.slHits; exited = true; break; }
      }
    }

    if (!exited) ++result.expired;
  }
}

} // namespace

MonteCarloResult runMonteCarloSimulationNative(
    const std::vector<std::vector<double>>& matrix,
    const std::vector<std::vector<double>>& returnsByState,
    int currentState,
    double startPrice,
    int iterations,
    int daysAhead,
    double slPct,
    double tpPct,
    const char* side,
    bool useSeed,
    uint32_t seed) {
  MonteCarloResult result;
  result.mcTier = "REJECTED";
  result.mcLabel = "Rejeitado";

  // ── Guard de input inválido ────────────────────────────────
  if (matrix.empty() || currentState < 0 ||
      static_cast<size_t>(currentState) >= matrix.size() ||
      !std::isfinite(startPrice) || startPrice <= 0.0 ||
      !std::isfinite(slPct) || !std::isfinite(tpPct) ||
      iterations <= 0 || daysAhead < 0) {
    result.expired = iterations > 0 ? iterations : 0;
    return result;
  }

  // Side case-insensitive (paridade com String(side).toUpperCase())
  bool isShort = false;
  if (side != nullptr) {
    char c0 = side[0];
    isShort = (c0 == 'S' || c0 == 's');
  }

  size_t startState = static_cast<size_t>(currentState);
  if (startState >= matrix.size()) startState = matrix.size() - 1;

  // Acumuladas pré-calculadas 1× por chamada (paridade bit-exata: mesma
  // ordem de somas do sampleState on-the-fly que o fallback JS replica)
  std::vector<std::vector<double>> cumRows;
  buildCumulativeRows(matrix, cumRows);

  if (useSeed) {
    Mulberry32 rng(seed);
    simulate(result, cumRows, matrix, returnsByState, startState, startPrice,
             iterations, daysAhead, slPct, tpPct, isShort, rng);
  } else {
    FastRng rng;
    simulate(result, cumRows, matrix, returnsByState, startState, startPrice,
             iterations, daysAhead, slPct, tpPct, isShort, rng);
  }

  result.winRate = (static_cast<double>(result.tpHits) /
                    static_cast<double>(iterations)) * 100.0;

  if (result.winRate >= 65.0) {
    result.mcApproved = true;
    result.mcTier = "ELITE";
    result.mcLabel = "Alta Probabilidade";
  } else if (result.winRate >= 50.0) {
    result.mcApproved = true;
    result.mcTier = "MODERATE";
    result.mcLabel = "Probabilidade Moderada";
  } else {
    result.mcApproved = false;
    result.mcTier = "REJECTED";
    result.mcLabel = "Rejeitado";
  }

  const double wr = result.winRate / 100.0;
  result.expectedValue = ((wr * tpPct) - ((1.0 - wr) * slPct)) * 100.0;

  return result;
}
