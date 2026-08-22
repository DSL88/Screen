#pragma once

#include <cstddef>
#include <vector>

// Modelo de Markov nativo (paridade com src/quant/markovEngine.js):
//   9 estados = zonaBB (pctB<0.33→0 | >0.66→2 | senão 1)
//             + zonaADX (adx<20→0 | >40→2 | senão 1) × 3
//   Matriz com suavização de Laplace α=0.1 e normalização por linha.
//   Valores NaN/infinito em bbPct/adx são tratados como null (-1).
struct MarkovModelResult {
  std::vector<std::vector<double>> transitionMatrix; // 9×9
  int currentState;                                  // pode ser -1
};

MarkovModelResult computeMarkovEngineNative(const std::vector<double>& bbPct,
                                            const std::vector<double>& adx,
                                            size_t window);
