"""
Markov State Model & Regime-Switching Monte Carlo Simulation (2nd Order Markov Chain).

This module implements:
1. Discrete-Time 2nd-Order Markov Chain (3 states: Bearish=0, Neutral=1, Bullish=2; 27 transition combinations).
2. 2nd-Order Transition Probability Matrix (9x3) estimation with robust row smoothing and uniform fallbacks.
3. State return distributions per regime N(mu_s, sigma_s).
4. Regime-Switching Monte Carlo stochastic simulation (5,000+ paths, H=21 days).
5. Stochastic output metrics: WinRate_MC, ExpectedReturn_MC, VaR_95, CVaR_95 (Expected Shortfall), and paths_sample (10 trajectories).
"""

from __future__ import annotations

from typing import Dict, Any, Tuple, Union, Optional, List
import numpy as np
import pandas as pd


STATE_LABELS = {0: "Bearish", 1: "Neutral", 2: "Bullish"}
PAIR_LABELS = {
    (0, 0): "Bearish / Bearish (0, 0)",
    (0, 1): "Bearish / Neutral (0, 1)",
    (0, 2): "Bearish / Bullish (0, 2)",
    (1, 0): "Neutral / Bearish (1, 0)",
    (1, 1): "Neutral / Neutral (1, 1)",
    (1, 2): "Neutral / Bullish (1, 2)",
    (2, 0): "Bullish / Bearish (2, 0)",
    (2, 1): "Bullish / Neutral (2, 1)",
    (2, 2): "Bullish / Bullish (2, 2)",
}


def compute_markov_transition_matrix(
    returns: Union[pd.Series, np.ndarray],
    n_states: int = 3,
    std_multiplier: float = 0.5
) -> Tuple[np.ndarray, np.ndarray, int, Dict[int, Tuple[float, float]]]:
    """
    Discretiza os retornos em 3 Estados e constrói a Matriz de Transição de 1ª Ordem (3x3).
    (Mantida para compatibilidade e diagnóstico comparativo).
    """
    if isinstance(returns, pd.Series):
        ret_arr = returns.dropna().to_numpy(dtype=np.float64)
    else:
        ret_arr = np.array(returns, dtype=np.float64)
        ret_arr = ret_arr[~np.isnan(ret_arr)]

    if len(ret_arr) < 5:
        uniform_p = np.full((n_states, n_states), 1.0 / n_states, dtype=np.float64)
        states = np.ones(len(ret_arr), dtype=int) if len(ret_arr) > 0 else np.array([1], dtype=int)
        default_params = {0: (-0.01, 0.02), 1: (0.0005, 0.01), 2: (0.01, 0.015)}
        return uniform_p, states, 1, default_params

    mean_ret = float(np.mean(ret_arr))
    std_ret = float(np.std(ret_arr))
    if std_ret < 1e-8:
        std_ret = 1e-4

    lower_bound = mean_ret - std_multiplier * std_ret
    upper_bound = mean_ret + std_multiplier * std_ret

    states = np.ones(len(ret_arr), dtype=int)
    states[ret_arr < lower_bound] = 0
    states[ret_arr > upper_bound] = 2

    # Construir matriz de transição de 1ª ordem (3x3)
    transition_matrix = np.zeros((n_states, n_states), dtype=np.float64)
    for t in range(len(states) - 1):
        s_curr = states[t]
        s_next = states[t + 1]
        if 0 <= s_curr < n_states and 0 <= s_next < n_states:
            transition_matrix[s_curr, s_next] += 1.0

    row_sums = transition_matrix.sum(axis=1, keepdims=True)
    for i in range(n_states):
        if row_sums[i, 0] == 0:
            transition_matrix[i, :] = 1.0 / n_states
        else:
            transition_matrix[i, :] /= row_sums[i, 0]

    # Parâmetros de retorno por estado (mu_s, sigma_s)
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
            if s == 0:
                state_params[s] = (mean_ret - 0.75 * std_ret, std_ret * 1.3)
            elif s == 1:
                state_params[s] = (mean_ret, std_ret * 0.8)
            else:
                state_params[s] = (mean_ret + 0.75 * std_ret, std_ret * 1.0)

    current_state = int(states[-1]) if len(states) > 0 else 1
    return transition_matrix, states, current_state, state_params


def compute_markov_2nd_order_transition_matrix(
    returns: Union[pd.Series, np.ndarray],
    n_states: int = 3,
    std_multiplier: float = 0.5
) -> Tuple[np.ndarray, np.ndarray, Tuple[int, int], Dict[int, Tuple[float, float]]]:
    """
    Discretiza os retornos em 3 Estados e constrói a Matriz de Transição de Markov de 2ª Ordem (9x3).
    
    Espaço de estados: (s_{t-2}, s_{t-1}) -> s_t
    - 9 pares de estados anteriores (linhas: 0..8)
    - 3 estados futuros possíveis (colunas: 0=Bearish, 1=Neutral, 2=Bullish)
    - Total de 27 combinações estocásticas possíveis.
    
    Tratamento de linhas nulas: normalização com fallback uniforme [1/3, 1/3, 1/3].
    
    Parameters:
    -----------
    returns : pd.Series or np.ndarray
        Série de retornos percentuais.
    n_states : int
        Número de regimes elementares (default=3).
    std_multiplier : float
        Multiplicador do desvio padrão para limites dos estados (default=0.5).
        
    Returns:
    --------
    Tuple[np.ndarray, np.ndarray, Tuple[int, int], Dict[int, Tuple[float, float]]]
        (matrix_9x3, states_array, current_pair, state_params)
    """
    if isinstance(returns, pd.Series):
        ret_arr = returns.dropna().to_numpy(dtype=np.float64)
    else:
        ret_arr = np.array(returns, dtype=np.float64)
        ret_arr = ret_arr[~np.isnan(ret_arr)]

    n_pairs = n_states * n_states  # 3 * 3 = 9 pares

    if len(ret_arr) < 5:
        uniform_p = np.full((n_pairs, n_states), 1.0 / n_states, dtype=np.float64)
        states = np.ones(len(ret_arr), dtype=int) if len(ret_arr) > 0 else np.array([1, 1], dtype=int)
        default_params = {0: (-0.01, 0.02), 1: (0.0005, 0.01), 2: (0.01, 0.015)}
        return uniform_p, states, (1, 1), default_params

    mean_ret = float(np.mean(ret_arr))
    std_ret = float(np.std(ret_arr))
    if std_ret < 1e-8:
        std_ret = 1e-4

    # 1. Discretização de Retornos em 3 Estados
    # Estado 0 (Bearish): Retorno < (Média - 0.5 * Desvio)
    # Estado 1 (Neutral): Retorno entre (Média - 0.5 * Desvio) e (Média + 0.5 * Desvio)
    # Estado 2 (Bullish): Retorno > (Média + 0.5 * Desvio)
    lower_bound = mean_ret - std_multiplier * std_ret
    upper_bound = mean_ret + std_multiplier * std_ret

    states = np.ones(len(ret_arr), dtype=int)
    states[ret_arr < lower_bound] = 0
    states[ret_arr > upper_bound] = 2

    # 2. Construir Matriz de Transição de 2ª Ordem (9x3)
    # Contagem de transições (s_{t-2}, s_{t-1}) -> s_t
    transition_matrix_2nd = np.zeros((n_pairs, n_states), dtype=np.float64)

    for t in range(len(states) - 2):
        s_prev2 = states[t]
        s_prev1 = states[t + 1]
        s_next = states[t + 2]
        
        if 0 <= s_prev2 < n_states and 0 <= s_prev1 < n_states and 0 <= s_next < n_states:
            row_idx = s_prev2 * n_states + s_prev1
            transition_matrix_2nd[row_idx, s_next] += 1.0

    # Normalização por linha com tratamento para linhas nulas (distribuição uniforme 1/3)
    row_sums = transition_matrix_2nd.sum(axis=1, keepdims=True)
    for i in range(n_pairs):
        if row_sums[i, 0] == 0:
            transition_matrix_2nd[i, :] = 1.0 / n_states
        else:
            transition_matrix_2nd[i, :] /= row_sums[i, 0]

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
            if s == 0:
                state_params[s] = (mean_ret - 0.75 * std_ret, std_ret * 1.3)
            elif s == 1:
                state_params[s] = (mean_ret, std_ret * 0.8)
            else:
                state_params[s] = (mean_ret + 0.75 * std_ret, std_ret * 1.0)

    # Par atual mais recente (s_{T-1}, s_T)
    if len(states) >= 2:
        current_pair = (int(states[-2]), int(states[-1]))
    elif len(states) == 1:
        current_pair = (1, int(states[-1]))
    else:
        current_pair = (1, 1)

    return transition_matrix_2nd, states, current_pair, state_params


def run_regime_switching_monte_carlo(
    transition_matrix: np.ndarray,
    current_state: Union[int, Tuple[int, int]],
    state_params: Dict[int, Tuple[float, float]],
    horizon: int = 21,
    n_simulations: int = 5000,
    seed: Optional[int] = 42
) -> Dict[str, Any]:
    """
    Executa a Simulação de Monte Carlo por Troca de Regimes (Markov de 2ª Ordem ou 1ª Ordem).
    
    5.000 caminhos estocásticos condicionados ao par de estados mais recente (s_{t-1}, s_t).
    Atualização de preços com drift (mu_s) e volatilidade (sigma_s) específicos de cada estado sorteado.
    
    Parameters:
    -----------
    transition_matrix : np.ndarray
        Matriz de transição de Markov (9x3 para 2ª ordem ou 3x3 para 1ª ordem).
    current_state : Union[int, Tuple[int, int]]
        Estado inicial ou par de estados inicial (s_{T-1}, s_T).
    state_params : Dict[int, Tuple[float, float]]
        Parâmetros de drift e volatilidade mapeados por estado {s: (mu_s, sigma_s)}.
    horizon : int
        Horizonte de projeção temporal em dias (default=21).
    n_simulations : int
        Número de trajetórias estocásticas simuladas (default=5000).
    seed : Optional[int]
        Semente para reprodutibilidade.
        
    Returns:
    --------
    Dict[str, Any]
        Dicionário com métricas estocásticas calculadas e amostra de trajetórias:
        - win_rate: % trajetórias com retorno positivo a h dias
        - expected_return_pct: mediana do retorno simulado
        - var_95_pct: VaR a 95% de confiança
        - cvar_95_pct: CVaR (Expected Shortfall) a 95% de confiança
        - paths_sample: amostra de 10 trajetórias temporais
    """
    rng = np.random.default_rng(seed)
    h = max(int(horizon), 1)
    n_sims = max(int(n_simulations), 100)
    
    is_2nd_order = (transition_matrix.shape[0] == 9 and transition_matrix.shape[1] == 3)
    n_states = 3

    # Normalização e matriz cumulativa para amostragem ultrarrápida
    cum_trans = np.cumsum(transition_matrix, axis=1)
    cum_trans[:, -1] = 1.0  # Garantir término em 1.0

    # Determinar estados iniciais s_{t-1} e s_t
    if isinstance(current_state, (tuple, list)) and len(current_state) >= 2:
        s_prev2 = int(current_state[0])
        s_prev1 = int(current_state[1])
    elif isinstance(current_state, int):
        s_prev2 = 1
        s_prev1 = int(current_state)
    else:
        s_prev2 = 1
        s_prev1 = 1

    # Vetor de estados simulados: shape (n_sims, h + 2)
    sim_states = np.zeros((n_sims, h + 2), dtype=np.int32)
    sim_states[:, 0] = s_prev2
    sim_states[:, 1] = s_prev1

    # Vetor de retornos a cada passo: shape (n_sims, h)
    step_returns = np.zeros((n_sims, h), dtype=np.float64)

    # Matriz cumulativa de caminhos de retorno (t=0..h) para extração de paths_sample
    # shape: (n_sims, h + 1)
    path_cumulative = np.zeros((n_sims, h + 1), dtype=np.float64)

    # Simulação temporal estocástica por troca de regimes
    for t in range(h):
        if is_2nd_order:
            # 2ª Ordem: par (s_{t-2}, s_{t-1}) determina a linha 0..8
            p2 = sim_states[:, t]
            p1 = sim_states[:, t + 1]
            row_indices = p2 * n_states + p1
        else:
            # 1ª Ordem fallback
            p1 = sim_states[:, t + 1]
            row_indices = p1

        u_trans = rng.uniform(0.0, 1.0, size=n_sims)
        next_s = np.zeros(n_sims, dtype=np.int32)

        # Transição vetorizada por cada uma das linhas possíveis
        n_rows = transition_matrix.shape[0]
        for r in range(n_rows):
            mask_r = (row_indices == r)
            if np.any(mask_r):
                u_sub = u_trans[mask_r, None]
                row_cum = cum_trans[r, :]
                s_next_sub = np.argmax(u_sub <= row_cum, axis=1)
                next_s[mask_r] = s_next_sub

        sim_states[:, t + 2] = next_s

        # Amostragem do retorno N(mu_s, sigma_s) condicionado ao regime sorteado
        z = rng.standard_normal(size=n_sims)
        for s in range(n_states):
            mask_next = (next_s == s)
            if np.any(mask_next):
                mu_s, sig_s = state_params.get(s, (0.0, 0.015))
                step_returns[mask_next, t] = mu_s + sig_s * z[mask_next]

        # Atualizar retorno acumulado no passo t
        path_cumulative[:, t + 1] = np.prod(1.0 + step_returns[:, :t + 1], axis=1) - 1.0

    # Retorno acumulado final de cada trajetória a h dias: R_i = prod(1 + r_t) - 1
    cum_returns = path_cumulative[:, -1]

    # 1. Win Rate MC (% trajetórias com retorno positivo)
    positive_count = int(np.sum(cum_returns > 0))
    win_rate = (positive_count / n_sims) * 100.0

    # 2. Expected Return MC (Mediana do retorno simulado em %)
    expected_return_pct = float(np.median(cum_returns)) * 100.0
    mean_return_pct = float(np.mean(cum_returns)) * 100.0

    # 3. Value at Risk a 95% de confiança (VaR 95)
    var_95_ret = float(np.percentile(cum_returns, 5.0))
    var_95_pct = abs(var_95_ret) * 100.0 if var_95_ret < 0 else 0.0

    # 4. Conditional Value at Risk (CVaR 95 / Expected Shortfall)
    tail_returns = cum_returns[cum_returns <= var_95_ret]
    if len(tail_returns) > 0:
        cvar_95_ret = float(np.mean(tail_returns))
        cvar_95_pct = abs(cvar_95_ret) * 100.0 if cvar_95_ret < 0 else 0.0
    else:
        cvar_95_pct = var_95_pct

    # 5. Amostra de 10 trajetórias para o gráfico do drawer
    # Selecionamos trajetórias representativas (percentis 5, 15, 25, 35, 50, 65, 75, 85, 95 e 99)
    sample_indices = [
        int(np.argsort(cum_returns)[int((n_sims - 1) * p)])
        for p in [0.05, 0.15, 0.25, 0.35, 0.50, 0.65, 0.75, 0.85, 0.95, 0.99]
    ]
    paths_sample = []
    for idx in sample_indices[:10]:
        traj = [round(float(val) * 100.0, 2) for val in path_cumulative[idx, :]]
        paths_sample.append(traj)

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
        "paths_sample": paths_sample,
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
    Executa o Motor Estocástico Unificado:
    1. Cadeia de Markov de 2ª Ordem (3x3 -> 3, 27 combinações).
    2. Simulação de Monte Carlo por Troca de Regimes (5.000 trajetórias).
    3. Métricas de risco, retorno e amostra de trajetórias para inspeção lateral.
    
    Parameters:
    -----------
    price_series : pd.Series, np.ndarray or list
        Série histórica de preços de fecho.
    window : int
        Janela de observação temporal (default=252).
    horizon : int
        Horizonte de projeção temporal em dias (default=21).
    n_simulations : int
        Quantidade de trajetórias no Monte Carlo (default=5000).
    seed : Optional[int]
        Semente aleatória.
        
    Returns:
    --------
    Dict[str, Any]
        Métricas e estruturas completas:
        - win_rate (WinRate_MC em %)
        - expected_return_pct (ExpectedReturn_MC em %)
        - var_95_pct (VaR 95 em %)
        - cvar_95_pct (CVaR 95 em %)
        - markov_bullish_prob (Probabilidade condicional de alta)
        - current_regime (Último estado 0, 1, 2)
        - current_regime_pair ((s_{T-1}, s_T))
        - current_regime_label (Texto descritivo)
        - transition_matrix_2nd_order (Matriz 9x3)
        - paths_sample (10 trajetórias para gráfico Plotly/Chart)
    """
    if not isinstance(price_series, pd.Series):
        price_series = pd.Series(price_series)

    clean_prices = price_series.dropna()
    window_effective = min(len(clean_prices), max(window, 10))
    
    returns = clean_prices.tail(window_effective).pct_change().dropna()

    # 1. Matriz de Transição de 2ª Ordem (9x3) e Parâmetros dos Regimes
    p_matrix_2nd, states, current_pair, state_params = compute_markov_2nd_order_transition_matrix(
        returns, n_states=3, std_multiplier=0.5
    )

    # Matriz de 1ª ordem para compatibilidade
    p_matrix_1st, _, _, _ = compute_markov_transition_matrix(
        returns, n_states=3, std_multiplier=0.5
    )

    # 2. Probabilidade Condicional Bullish do Próximo Passo
    pair_row_idx = current_pair[0] * 3 + current_pair[1]
    bullish_prob = float(p_matrix_2nd[pair_row_idx, 2])
    if np.isnan(bullish_prob) or np.isinf(bullish_prob):
        bullish_prob = 1.0 / 3.0
    bullish_prob = max(0.0, min(1.0, bullish_prob))

    # 3. Simulação de Monte Carlo por Troca de Regimes (5.000 caminhos)
    h = max(int(horizon), 1)
    mc_results = run_regime_switching_monte_carlo(
        transition_matrix=p_matrix_2nd,
        current_state=current_pair,
        state_params=state_params,
        horizon=h,
        n_simulations=n_simulations,
        seed=seed
    )

    current_s = current_pair[1]
    pair_label = PAIR_LABELS.get(current_pair, f"Estado ({current_pair[0]}, {current_pair[1]})")

    # Mapeamento detalhado da matriz 9x3 para inspeção no drawer
    matrix_breakdown = []
    pair_names = [
        ("Bearish (0)", "Bearish (0)"),
        ("Bearish (0)", "Neutral (1)"),
        ("Bearish (0)", "Bullish (2)"),
        ("Neutral (1)", "Bearish (0)"),
        ("Neutral (1)", "Neutral (1)"),
        ("Neutral (1)", "Bullish (2)"),
        ("Bullish (2)", "Bearish (0)"),
        ("Bullish (2)", "Neutral (1)"),
        ("Bullish (2)", "Bullish (2)"),
    ]
    for r_i in range(9):
        p_bear = round(float(p_matrix_2nd[r_i, 0]), 4)
        p_neut = round(float(p_matrix_2nd[r_i, 1]), 4)
        p_bull = round(float(p_matrix_2nd[r_i, 2]), 4)
        s_t2_lbl, s_t1_lbl = pair_names[r_i]
        matrix_breakdown.append({
            "from_pair": f"{s_t2_lbl} -> {s_t1_lbl}",
            "s_t2": r_i // 3,
            "s_t1": r_i % 3,
            "prob_bearish": p_bear,
            "prob_neutral": p_neut,
            "prob_bullish": p_bull,
            "is_current": (r_i == pair_row_idx)
        })

    return {
        "markov_bullish_prob": round(bullish_prob * 100.0, 2),
        "bullish_prob_raw": round(bullish_prob, 4),
        "markov_edge": round((bullish_prob - (1.0 / 3.0)) * 100.0, 2),
        "current_regime": current_s,
        "current_regime_label": STATE_LABELS.get(current_s, "Neutral"),
        "current_regime_pair": [int(current_pair[0]), int(current_pair[1])],
        "current_regime_pair_label": pair_label,
        "transition_matrix": [[round(float(v), 4) for v in row] for row in p_matrix_1st],
        "transition_matrix_2nd_order": [[round(float(v), 4) for v in row] for row in p_matrix_2nd],
        "matrix_breakdown": matrix_breakdown,
        "win_rate": mc_results["win_rate"],
        "expected_return_pct": mc_results["expected_return_pct"],
        "mean_return_pct": mc_results["mean_return_pct"],
        "var_95_pct": mc_results["var_95_pct"],
        "cvar_95_pct": mc_results["cvar_95_pct"],
        "paths_sample": mc_results["paths_sample"],
        "mc_results": mc_results,
    }
