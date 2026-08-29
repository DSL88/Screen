"""
Markov State Model & Regime-Switching Monte Carlo Simulation.

This module implements:
1. Discrete-Time Markov Chain (3 states: Bearish=0, Neutral=1, Bullish=2).
2. Transition Probability Matrix estimation with smoothing.
3. Multi-period state projection via matrix exponentiation (P^h).
4. Regime-Switching Monte Carlo stochastic simulation (5,000+ paths).
5. Stochastic output metrics: WinRate_MC, ExpectedReturn_MC, VaR_95, CVaR_95 (Expected Shortfall).
"""

from __future__ import annotations

from typing import Dict, Any, Tuple, Union, Optional
import numpy as np
import pandas as pd


def compute_markov_transition_matrix(
    returns: Union[pd.Series, np.ndarray],
    n_states: int = 3,
    std_multiplier: float = 0.5
) -> Tuple[np.ndarray, np.ndarray, int, Dict[int, Tuple[float, float]]]:
    """
    Discretiza os retornos e constrói a Matriz de Transição de Markov (P).
    
    Parameters:
    -----------
    returns : pd.Series or np.ndarray
        Série de retornos percentuais.
    n_states : int
        Número de regimes (default=3: 0=Bearish, 1=Neutral, 2=Bullish).
    std_multiplier : float
        Multiplicador do desvio padrão para limites dos estados (default=0.5).
        
    Returns:
    --------
    Tuple[np.ndarray, np.ndarray, int, Dict[int, Tuple[float, float]]]
        (transition_matrix, states_array, current_state, state_params)
    """
    if isinstance(returns, pd.Series):
        ret_arr = returns.dropna().to_numpy(dtype=np.float64)
    else:
        ret_arr = np.array(returns, dtype=np.float64)
        ret_arr = ret_arr[~np.isnan(ret_arr)]

    if len(ret_arr) < 5:
        # Fallback uniforme se dados insuficientes
        uniform_p = np.full((n_states, n_states), 1.0 / n_states, dtype=np.float64)
        states = np.ones(len(ret_arr), dtype=int) if len(ret_arr) > 0 else np.array([1], dtype=int)
        default_params = {0: (-0.01, 0.02), 1: (0.0005, 0.01), 2: (0.01, 0.015)}
        return uniform_p, states, 1, default_params

    mean_ret = float(np.mean(ret_arr))
    std_ret = float(np.std(ret_arr))
    if std_ret < 1e-8:
        std_ret = 1e-4

    # 1. Discretizar retornos em 3 Estados
    # 0 = Bearish (r < mean - std_multiplier * std)
    # 1 = Neutral (mean - std_multiplier * std <= r <= mean + std_multiplier * std)
    # 2 = Bullish (r > mean + std_multiplier * std)
    lower_bound = mean_ret - std_multiplier * std_ret
    upper_bound = mean_ret + std_multiplier * std_ret

    states = np.ones(len(ret_arr), dtype=int)
    states[ret_arr < lower_bound] = 0
    states[ret_arr > upper_bound] = 2

    # 2. Construir matriz de transição de contagem
    transition_matrix = np.zeros((n_states, n_states), dtype=np.float64)
    for t in range(len(states) - 1):
        s_curr = states[t]
        s_next = states[t + 1]
        if 0 <= s_curr < n_states and 0 <= s_next < n_states:
            transition_matrix[s_curr, s_next] += 1.0

    # Normalizar linhas para obter distribuição de probabilidade estocástica
    row_sums = transition_matrix.sum(axis=1, keepdims=True)
    for i in range(n_states):
        if row_sums[i, 0] == 0:
            transition_matrix[i, :] = 1.0 / n_states
        else:
            transition_matrix[i, :] /= row_sums[i, 0]

    # 3. Estimar parâmetros de retorno e volatilidade (mu_s, sigma_s) por estado
    state_params: Dict[int, Tuple[float, float]] = {}
    for s in range(n_states):
        s_rets = ret_arr[states == s]
        if len(s_rets) >= 3:
            s_mu = float(np.mean(s_rets))
            s_sigma = float(np.std(s_rets))
            if s_sigma < 1e-6:
                s_sigma = std_ret
            state_params[s] = (s_mu, s_sigma)
        else:
            # Fallback adaptativo baseado no desvio padrão global
            if s == 0:
                state_params[s] = (mean_ret - 0.75 * std_ret, std_ret * 1.3)
            elif s == 1:
                state_params[s] = (mean_ret, std_ret * 0.8)
            else:
                state_params[s] = (mean_ret + 0.75 * std_ret, std_ret * 1.0)

    current_state = int(states[-1]) if len(states) > 0 else 1
    return transition_matrix, states, current_state, state_params


def run_regime_switching_monte_carlo(
    transition_matrix: np.ndarray,
    current_state: int,
    state_params: Dict[int, Tuple[float, float]],
    horizon: int = 21,
    n_simulations: int = 5000,
    seed: Optional[int] = 42
) -> Dict[str, Any]:
    """
    Executa a Simulação de Monte Carlo por Troca de Regimes (Regime-Switching MC).
    
    A cada passo da trajetória, o estado do mercado transita de acordo com a
    Matriz de Markov P, e o retorno daquele passo é amostrado da distribuição
    específica do regime ativo N(mu_s, sigma_s).
    
    Parameters:
    -----------
    transition_matrix : np.ndarray
        Matriz estocástica de transição de Markov (3x3).
    current_state : int
        Estado inicial do ativo (0, 1 ou 2).
    state_params : Dict[int, Tuple[float, float]]
        Dicionário mapeando cada estado para (mu_s, sigma_s).
    horizon : int
        Horizonte de projeção temporal em dias/barras (default=21).
    n_simulations : int
        Número de trajetórias estocásticas simuladas (default=5000).
    seed : Optional[int]
        Semente para reprodutibilidade.
        
    Returns:
    --------
    Dict[str, Any]
        Dicionário com métricas estocásticas calculadas.
    """
    rng = np.random.default_rng(seed)
    h = max(int(horizon), 1)
    n_sims = max(int(n_simulations), 100)
    n_states = transition_matrix.shape[0]

    # Matriz cumulativa de transição para amostragem rápida
    cum_trans = np.cumsum(transition_matrix, axis=1)
    cum_trans[:, -1] = 1.0  # Garantir término exato em 1.0

    # Vetor de estados simulados: shape (n_sims, h + 1)
    sim_states = np.zeros((n_sims, h + 1), dtype=np.int32)
    sim_states[:, 0] = current_state

    # Vetor de retornos a cada passo: shape (n_sims, h)
    step_returns = np.zeros((n_sims, h), dtype=np.float64)

    # Amostragem temporal por troca de regimes
    for t in range(h):
        curr_s = sim_states[:, t]
        
        # Gerar números uniformes para transição de estado
        u_trans = rng.uniform(0.0, 1.0, size=n_sims)
        
        # Determinar próximo estado para cada trajetória
        # Usamos broadcasting com a linha correspondente de cum_trans
        next_s = np.zeros(n_sims, dtype=np.int32)
        for s in range(n_states):
            mask_curr = (curr_s == s)
            if np.any(mask_curr):
                u_sub = u_trans[mask_curr, None]
                row_cum = cum_trans[s, :]
                # Encontrar primeiro índice onde u_sub <= row_cum
                s_next_sub = np.argmax(u_sub <= row_cum, axis=1)
                next_s[mask_curr] = s_next_sub

        sim_states[:, t + 1] = next_s

        # Amostrar retorno N(mu_s, sigma_s) para cada trajetória conforme o estado sorteado
        z = rng.standard_normal(size=n_sims)
        for s in range(n_states):
            mask_next = (next_s == s)
            if np.any(mask_next):
                mu_s, sig_s = state_params.get(s, (0.0, 0.015))
                step_returns[mask_next, t] = mu_s + sig_s * z[mask_next]

    # Retorno acumulado total de cada trajetória a h dias: R_i = prod(1 + r_t) - 1
    cum_returns = np.prod(1.0 + step_returns, axis=1) - 1.0

    # 1. Win Rate MC (% de trajetórias com retorno positivo a h dias)
    positive_count = int(np.sum(cum_returns > 0))
    win_rate = (positive_count / n_sims) * 100.0

    # 2. Expected Return MC (Mediana do retorno simulado em %)
    expected_return_pct = float(np.median(cum_returns)) * 100.0
    mean_return_pct = float(np.mean(cum_returns)) * 100.0

    # 3. Value at Risk a 95% de confiança (VaR 95)
    # 5º percentil dos retornos acumulados.
    var_95_ret = float(np.percentile(cum_returns, 5.0))
    # Expressar como percentual de risco / perda potencial positiva (ex.: se retorno for -0.042, VaR = 4.2%)
    var_95_pct = abs(var_95_ret) * 100.0 if var_95_ret < 0 else 0.0

    # 4. Conditional Value at Risk (CVaR 95 / Expected Shortfall)
    # Média dos retornos situados na cauda esquerda abaixo do VaR 95
    tail_returns = cum_returns[cum_returns <= var_95_ret]
    if len(tail_returns) > 0:
        cvar_95_ret = float(np.mean(tail_returns))
        cvar_95_pct = abs(cvar_95_ret) * 100.0 if cvar_95_ret < 0 else 0.0
    else:
        cvar_95_pct = var_95_pct

    return {
        "n_simulations": n_sims,
        "horizon": h,
        "win_rate": round(win_rate, 2),
        "expected_return_pct": round(expected_return_pct, 2),
        "mean_return_pct": round(mean_return_pct, 2),
        "var_95_pct": round(var_95_pct, 2),
        "cvar_95_pct": round(cvar_95_pct, 2),
        "min_return_pct": round(float(np.min(cum_returns)) * 100.0, 2),
        "max_return_pct": round(float(np.max(cum_returns)) * 100.0, 2),
        "std_return_pct": round(float(np.std(cum_returns)) * 100.0, 2),
        "cumulative_returns": cum_returns,
    }


def run_markov_monte_carlo(
    price_series: Union[pd.Series, np.ndarray, list],
    window: int = 252,
    horizon: int = 21,
    n_simulations: int = 5000,
    seed: Optional[int] = 42
) -> Dict[str, Any]:
    """
    Executa a integração completa: Modelo de Markov (P, P^h) + Simulação de Monte Carlo por Troca de Regimes.
    
    Parameters:
    -----------
    price_series : pd.Series, np.ndarray or list
        Série histórica de preços de fecho.
    window : int
        Janela temporal de observação (ex.: 252 dias).
    horizon : int
        Horizonte de projeção estocástica (ex.: 21 dias).
    n_simulations : int
        Quantidade de caminhos simulados no Monte Carlo (default=5000).
    seed : Optional[int]
        Semente aleatória.
        
    Returns:
    --------
    Dict[str, Any]
        Métricas estocásticas consolidadas:
        - markov_bullish_prob (0 a 100%)
        - win_rate (WinRate_MC em %)
        - expected_return_pct (ExpectedReturn_MC em %)
        - var_95_pct (VaR_95 em %)
        - cvar_95_pct (CVaR_95 em %)
        - current_regime (0=Bearish, 1=Neutral, 2=Bullish)
        - current_regime_label
        - transition_matrix
    """
    if not isinstance(price_series, pd.Series):
        price_series = pd.Series(price_series)

    clean_prices = price_series.dropna()
    window_effective = min(len(clean_prices), max(window, 10))
    
    # Calcular retornos
    returns = clean_prices.tail(window_effective).pct_change().dropna()

    # 1. Matriz de Transição e Parâmetros dos Regimes
    p_matrix, states, current_s, state_params = compute_markov_transition_matrix(
        returns, n_states=3, std_multiplier=0.5
    )

    # 2. Projeção por Exponenciação de Matriz (P^h)
    h = max(int(horizon), 1)
    p_horizon = np.linalg.matrix_power(p_matrix, h)
    
    # Probabilidade de transitar ou manter-se no Estado 2 (Bullish) a h passos
    bullish_prob = float(p_horizon[current_s, 2])
    if np.isnan(bullish_prob) or np.isinf(bullish_prob):
        bullish_prob = 1.0 / 3.0
    bullish_prob = max(0.0, min(1.0, bullish_prob))

    # 3. Regime-Switching Monte Carlo
    mc_results = run_regime_switching_monte_carlo(
        transition_matrix=p_matrix,
        current_state=current_s,
        state_params=state_params,
        horizon=h,
        n_simulations=n_simulations,
        seed=seed
    )

    regime_labels = {0: "Bearish", 1: "Neutral", 2: "Bullish"}

    return {
        "markov_bullish_prob": round(bullish_prob * 100.0, 2),
        "bullish_prob_raw": round(bullish_prob, 4),
        "markov_edge": round((bullish_prob - (1.0 / 3.0)) * 100.0, 2),
        "current_regime": current_s,
        "current_regime_label": regime_labels.get(current_s, "Neutral"),
        "transition_matrix": [[round(float(v), 4) for v in row] for row in p_matrix],
        "win_rate": mc_results["win_rate"],
        "expected_return_pct": mc_results["expected_return_pct"],
        "mean_return_pct": mc_results["mean_return_pct"],
        "var_95_pct": mc_results["var_95_pct"],
        "cvar_95_pct": mc_results["cvar_95_pct"],
        "mc_results": mc_results,
    }
