// ─────────────────────────────────────────────────────────────
//  addon.cpp – Wrapper N-API do motor quantitativo nativo
//
//  Exporta:
//    computeMarkovModel(bbPctArr, adxArr, window)
//        → { transitionMatrix: number[][], currentState: number }
//    runMonteCarlo(matrixArr, returnsArr, currentState, startPrice, optsObj)
//        → { winRate, tpHits, slHits, expired,
//            isApproved, mcTier, mcLabel, expectedValue }
//
//  Compilado com NAPI_DISABLE_CPP_EXCEPTIONS (erros via
//  ThrowAsJavaScriptException).
// ─────────────────────────────────────────────────────────────
#include <napi.h>

#include <cctype>
#include <cmath>
#include <cstdint>
#include <limits>
#include <string>
#include <vector>

#include "markov.hpp"
#include "monte_carlo.hpp"

namespace {

constexpr int kDefaultIterations = 1000;
constexpr int kDefaultDaysAhead = 20;
constexpr double kDefaultSlPct = 0.014;
constexpr double kDefaultTpPct = 0.028;

// Conversão posicional para séries de indicadores:
// mantém o alinhamento dos índices; não-numéricos → NaN
// (o motor trata NaN como null/-1).
std::vector<double> ArrayToStatesVector(const Napi::Array& arr) {
  std::vector<double> out;
  out.reserve(arr.Length());
  for (uint32_t i = 0; i < arr.Length(); ++i) {
    const Napi::Value v = arr[i];
    if (!v.IsNumber()) {
      out.push_back(std::numeric_limits<double>::quiet_NaN());
      continue;
    }
    out.push_back(v.As<Napi::Number>().DoubleValue());
  }
  return out;
}

// Conversão null-safe: salta valores não-numéricos/NaN.
// Usada na matriz e nas linhas ragged de retornos.
std::vector<double> ArrayToDoubleVector(const Napi::Array& arr) {
  std::vector<double> out;
  out.reserve(arr.Length());
  for (uint32_t i = 0; i < arr.Length(); ++i) {
    const Napi::Value v = arr[i];
    if (!v.IsNumber()) continue;
    const double d = v.As<Napi::Number>().DoubleValue();
    if (std::isnan(d)) continue;
    out.push_back(d);
  }
  return out;
}

std::vector<std::vector<double>> ToMatrix(const Napi::Array& arr) {
  std::vector<std::vector<double>> out;
  out.reserve(arr.Length());
  for (uint32_t i = 0; i < arr.Length(); ++i) {
    const Napi::Value row = arr[i];
    if (!row.IsArray()) {
      out.emplace_back(); // tolerância a linhas ragged/malformadas
      continue;
    }
    out.push_back(ArrayToDoubleVector(row.As<Napi::Array>()));
  }
  return out;
}

Napi::Array VectorToArray(Napi::Env env, const std::vector<double>& v) {
  Napi::Array out = Napi::Array::New(env, v.size());
  for (size_t i = 0; i < v.size(); ++i) {
    out.Set(static_cast<uint32_t>(i), Napi::Number::New(env, v[i]));
  }
  return out;
}

Napi::Array MatrixToArray(Napi::Env env,
                          const std::vector<std::vector<double>>& m) {
  Napi::Array out = Napi::Array::New(env, m.size());
  for (size_t i = 0; i < m.size(); ++i) {
    out.Set(static_cast<uint32_t>(i), VectorToArray(env, m[i]));
  }
  return out;
}

Napi::Object BuildResultObject(Napi::Env env, const MonteCarloResult& r) {
  Napi::Object out = Napi::Object::New(env);
  out.Set("winRate", Napi::Number::New(env, r.winRate));
  out.Set("winRateMC", Napi::Number::New(env, r.winRate));
  out.Set("tpHits", Napi::Number::New(env, static_cast<double>(r.tpHits)));
  out.Set("slHits", Napi::Number::New(env, static_cast<double>(r.slHits)));
  out.Set("expired", Napi::Number::New(env, static_cast<double>(r.expired)));
  out.Set("isApproved", Napi::Boolean::New(env, r.mcApproved));
  out.Set("mcApproved", Napi::Boolean::New(env, r.mcApproved));
  out.Set("mcTier", Napi::String::New(env, r.mcTier));
  out.Set("mcLabel", Napi::String::New(env, r.mcLabel));
  out.Set("expectedValue", Napi::Number::New(env, r.expectedValue));
  return out;
}

double GetFiniteNumberOr(const Napi::Object& opts, const char* key,
                         double fallback) {
  const Napi::Value v = opts.Get(key);
  if (!v.IsNumber()) return fallback;
  const double d = v.As<Napi::Number>().DoubleValue();
  return std::isfinite(d) ? d : fallback;
}

Napi::Value RunMonteCarlo(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 4 || !info[0].IsArray() || !info[1].IsArray() ||
      !info[2].IsNumber() || !info[3].IsNumber()) {
    Napi::TypeError::New(
        env, "runMonteCarlo(matrixArr, returnsArr, currentState, startPrice, optsObj?)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const std::vector<std::vector<double>> matrix =
      ToMatrix(info[0].As<Napi::Array>());
  const std::vector<std::vector<double>> returnsByState =
      ToMatrix(info[1].As<Napi::Array>());
  const int currentState = info[2].As<Napi::Number>().Int32Value();
  const double startPrice = info[3].As<Napi::Number>().DoubleValue();

  // Spec compat: 8 args (matrix, returns, state, price, iterations, horizon, sl, tp)
  bool isSpecCall = info.Length() >= 8 && info[4].IsNumber() && info[5].IsNumber() && info[6].IsNumber() && info[7].IsNumber();
  double iterationsD = kDefaultIterations;
  double daysAheadD = kDefaultDaysAhead;
  double slPct = kDefaultSlPct;
  double tpPct = kDefaultTpPct;
  std::string side = "LONG";
  bool useSeed = false;
  uint32_t seed = 0;

  if (isSpecCall) {
    iterationsD = info[4].As<Napi::Number>().DoubleValue();
    daysAheadD = info[5].As<Napi::Number>().DoubleValue();
    slPct = info[6].As<Napi::Number>().DoubleValue();
    tpPct = info[7].As<Napi::Number>().DoubleValue();
    if (iterationsD < 1.0) iterationsD = kDefaultIterations;
    if (daysAheadD < 1.0) daysAheadD = kDefaultDaysAhead;
    if (!std::isfinite(slPct)) slPct = kDefaultSlPct;
    if (!std::isfinite(tpPct)) tpPct = kDefaultTpPct;
  } else {
    const Napi::Object opts =
        (info.Length() >= 5 && info[4].IsObject()) ? info[4].As<Napi::Object>()
                                                   : Napi::Object::New(env);
    // Defaults paridade JS: iterations/daysAhead com `||`, sl/tp com `!= null`
    {
      const Napi::Value v = opts.Get("iterations");
      if (v.IsNumber()) {
        const double d = v.As<Napi::Number>().DoubleValue();
        if (d >= 1.0) iterationsD = d;
      }
    }
    {
      const Napi::Value v = opts.Get("daysAhead");
      if (v.IsNumber()) {
        const double d = v.As<Napi::Number>().DoubleValue();
        if (d >= 1.0) daysAheadD = d;
      }
    }
    slPct = GetFiniteNumberOr(opts, "slPct", kDefaultSlPct);
    tpPct = GetFiniteNumberOr(opts, "tpPct", kDefaultTpPct);
    {
      const Napi::Value v = opts.Get("side");
      if (v.IsString()) side = v.As<Napi::String>().Utf8Value();
      for (char& c : side) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    }
    {
      const Napi::Value v = opts.Get("seed");
      if (v.IsNumber()) {
        const double d = v.As<Napi::Number>().DoubleValue();
        if (std::isfinite(d)) { useSeed = true; seed = v.As<Napi::Number>().Uint32Value(); }
      }
    }
  }

  const MonteCarloResult result = runMonteCarloSimulationNative(
      matrix, returnsByState, currentState, startPrice,
      static_cast<int>(iterationsD), static_cast<int>(daysAheadD),
      slPct, tpPct, side.c_str(), useSeed, seed);

  return BuildResultObject(env, result);
}

Napi::Value ComputeMarkovModel(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 3 || !info[0].IsArray() || !info[1].IsArray() ||
      !info[2].IsNumber()) {
    Napi::TypeError::New(env, "computeMarkovModel(bbPctArr, adxArr, window)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const std::vector<double> bbPct =
      ArrayToStatesVector(info[0].As<Napi::Array>());
  const std::vector<double> adx =
      ArrayToStatesVector(info[1].As<Napi::Array>());

  const double windowD = info[2].As<Napi::Number>().DoubleValue();
  size_t window = 0;
  if (std::isfinite(windowD) && windowD > 0.0) {
    window = static_cast<size_t>(windowD);
  }

  const MarkovModelResult result =
      computeMarkovEngineNative(bbPct, adx, window);

  Napi::Object out = Napi::Object::New(env);
  out.Set("transitionMatrix", MatrixToArray(env, result.transitionMatrix));
  out.Set("currentState", Napi::Number::New(env, result.currentState));
  return out;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("runMonteCarlo", Napi::Function::New(env, RunMonteCarlo));
  exports.Set("computeMarkovModel",
              Napi::Function::New(env, ComputeMarkovModel));
  return exports;
}

} // namespace

NODE_API_MODULE(quant_engine, Init)
