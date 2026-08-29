"""
Markov State Model Module (Discrete-Time Markov Chain).

Provides:
- Discrete-time Markov regime modeling on financial time series.
- Discretization into 3 regimes (Bearish, Neutral, Bullish).
- Row-normalized transition probability matrix computation.
- Horizon projection via matrix exponentiation (P^h).
- Bullish regime transition probability & Markov Edge extraction.
"""

from __future__ import annotations

from typing import Dict, Optional, Tuple, Union
import numpy as np
import pandas as pd


def compute_markov_regime_probabilities(
    price_series: Union[pd.Series, np.ndarray],
    window: int = 252,
    horizon: int = 5,
    n_states: int = 3
) -> Tuple[float, np.ndarray]:
    """
    Calcula o Modelo de Cadeias de Markov de Tempo Discreto para a série de preços.
    Retorna a probabilidade de transição para o estado de alta e a matriz de transição.

    Parameters:
    -----------
    price_series : pd.Series or np.ndarray
        Série temporal de preços de fecho.
    window : int
        Janela de observação móvel em barras/dias (ex.: 252 para 1 ano de negociação).
    horizon : int
        Horizonte de projeção temporal 'h' para cálculo de P^h (ex.: 5 dias).
    n_states : int
        Número de estados discretos (default = 3: 0=Bearish, 1=Neutral, 2=Bullish).

    Returns:
    --------
    Tuple[float, np.ndarray]
        (markov_bullish_prob, transition_matrix)
    """
    if not isinstance(price_series, pd.Series):
        price_series = pd.Series(price_series)

    # Validate sufficient data
    clean_prices = price_series.dropna()
    if len(clean_prices) < max(window, 10):
        # Fallback uniform stochastic matrix
        uniform_p = np.full((n_states, n_states), 1.0 / n_states)
        return 1.0 / n_states, uniform_p

    # 1. Obter os últimos 'window' dias de retornos
    returns = clean_prices.tail(window).pct_change().dropna()
    if len(returns) < 5:
        uniform_p = np.full((n_states, n_states), 1.0 / n_states)
        return 1.0 / n_states, uniform_p

    # 2. Discretizar os retornos em 3 Estados:
    # Estado 0: Bearish (Retorno < mean - 0.5 * std)
    # Estado 1: Neutral (Entre mean - 0.5 * std e mean + 0.5 * std)
    # Estado 2: Bullish (Retorno > mean + 0.5 * std)
    mean_ret = float(returns.mean())
    std_ret = float(returns.std()) + 1e-8

    ret_arr = returns.to_numpy(dtype=np.float64)
    states = np.ones(len(ret_arr), dtype=int)  # default to state 1 (neutral)

    states[ret_arr > (mean_ret + 0.5 * std_ret)] = 2
    states[(ret_arr >= (mean_ret - 0.5 * std_ret)) & (ret_arr <= (mean_ret + 0.5 * std_ret))] = 1
    states[ret_arr < (mean_ret - 0.5 * std_ret)] = 0

    # 3. Construir a Matriz de Transição (Contagem de Frequência)
    transition_matrix = np.zeros((n_states, n_states), dtype=np.float64)
    for t in range(len(states) - 1):
        current_s = states[t]
        next_s = states[t + 1]
        if 0 <= current_s < n_states and 0 <= next_s < n_states:
            transition_matrix[current_s, next_s] += 1.0

    # Normalizar para obter as Probabilidades de Transição (P_ij)
    row_sums = transition_matrix.sum(axis=1, keepdims=True)
    # Laplace / uniform smoothing for empty rows
    for i in range(n_states):
        if row_sums[i, 0] == 0:
            transition_matrix[i, :] = 1.0 / n_states
        else:
            transition_matrix[i, :] /= row_sums[i, 0]

    # 4. Projetar a Probabilidade para o Horizonte 'h' (Matriz P^h)
    h = max(int(horizon), 1)
    p_horizon = np.linalg.matrix_power(transition_matrix, h)

    # Estado Atual
    current_state = int(states[-1]) if len(states) > 0 else 1

    # Probabilidade de transitar ou manter-se no Estado 2 (Bullish) no horizonte 'h'
    markov_bullish_prob = float(p_horizon[current_state, min(2, n_states - 1)])

    # Ensure valid finite float in [0.0, 1.0]
    if np.isnan(markov_bullish_prob) or np.isinf(markov_bullish_prob):
        markov_bullish_prob = 1.0 / n_states
    markov_bullish_prob = max(0.0, min(1.0, markov_bullish_prob))

    return markov_bullish_prob, transition_matrix


def calculate_markov_edge(bullish_prob: float, base_prob: float = 0.333333) -> float:
    """
    Calcula a vantagem probabilística percentual (Edge) sobre o regime neutro aleatório.
    """
    return (float(bullish_prob) - base_prob) * 100.0
