"""
Unit tests for Markov State Model + Regime-Switching Monte Carlo integration.
"""

import json
import subprocess
import sys
import numpy as np
import pandas as pd
import pytest

from src.features.markov_monte_carlo import (
    compute_markov_transition_matrix,
    run_regime_switching_monte_carlo,
    run_markov_monte_carlo,
)
from python_engine.run_pipeline import (
    execute_alpha_quant_engine,
)


def test_compute_markov_transition_matrix_stochastic_property():
    """Matriz de transição deve ser estocástica (soma de cada linha = 1.0)."""
    np.random.seed(42)
    returns = np.random.normal(0.0005, 0.015, 300)
    p_matrix, states, current_s, state_params = compute_markov_transition_matrix(
        returns, n_states=3, std_multiplier=0.5
    )

    assert p_matrix.shape == (3, 3)
    assert current_s in (0, 1, 2)
    for row in p_matrix:
        assert np.isclose(np.sum(row), 1.0, atol=1e-5)
        assert np.all(row >= 0.0)
        assert np.all(row <= 1.0)

    assert len(state_params) == 3
    for s in (0, 1, 2):
        mu, sigma = state_params[s]
        assert isinstance(mu, float)
        assert isinstance(sigma, float)
        assert sigma > 0.0


def test_compute_markov_2nd_order_transition_matrix():
    """Matriz de transição de 2ª ordem deve ter shape (9, 3), 27 combinações e soma por linha = 1.0."""
    from src.features.markov_monte_carlo import compute_markov_2nd_order_transition_matrix

    np.random.seed(42)
    returns = np.random.normal(0.0005, 0.015, 250)
    p_matrix_2nd, states, current_pair, state_params = compute_markov_2nd_order_transition_matrix(
        returns, n_states=3, std_multiplier=0.5
    )

    assert p_matrix_2nd.shape == (9, 3)
    assert len(current_pair) == 2
    assert current_pair[0] in (0, 1, 2)
    assert current_pair[1] in (0, 1, 2)

    for row in p_matrix_2nd:
        assert np.isclose(np.sum(row), 1.0, atol=1e-5)
        assert np.all(row >= 0.0)
        assert np.all(row <= 1.0)

    # Teste de fallback uniforme em amostra pequena
    small_returns = np.array([0.01, -0.02])
    p_small, _, pair_small, _ = compute_markov_2nd_order_transition_matrix(small_returns)
    assert p_small.shape == (9, 3)
    for row in p_small:
        assert np.allclose(row, 1.0 / 3.0)


def test_regime_switching_monte_carlo_metrics():
    """Testa geração de 5000 trajetórias e cálculo de WinRate, VaR95, CVaR95."""
    transition_matrix = np.array([
        [0.6, 0.3, 0.1],
        [0.2, 0.6, 0.2],
        [0.1, 0.3, 0.6],
    ])
    state_params = {
        0: (-0.01, 0.025),
        1: (0.0005, 0.010),
        2: (0.012, 0.015),
    }

    res = run_regime_switching_monte_carlo(
        transition_matrix=transition_matrix,
        current_state=2,
        state_params=state_params,
        horizon=21,
        n_simulations=5000,
        seed=42
    )

    assert res["n_simulations"] == 5000
    assert res["horizon"] == 21
    assert 0.0 <= res["win_rate"] <= 100.0
    assert isinstance(res["expected_return_pct"], float)
    assert isinstance(res["var_95_pct"], float)
    assert isinstance(res["cvar_95_pct"], float)
    # CVaR (Expected Shortfall) é a média na cauda, logo CVaR >= VaR em magnitude de perda
    assert res["cvar_95_pct"] >= res["var_95_pct"] - 1e-4


def test_run_markov_monte_carlo_bullish_vs_bearish():
    """Série com forte tendência de alta deve gerar maior WinRate e Expected Return que série em queda."""
    np.random.seed(42)
    # Série Bullish
    bull_prices = 100.0 * np.exp(np.cumsum(np.random.normal(0.008, 0.008, 252)))
    bull_res = run_markov_monte_carlo(bull_prices, window=252, horizon=21, n_simulations=2000, seed=42)

    # Série Bearish
    bear_prices = 100.0 * np.exp(np.cumsum(np.random.normal(-0.008, 0.012, 252)))
    bear_res = run_markov_monte_carlo(bear_prices, window=252, horizon=21, n_simulations=2000, seed=42)

    assert bull_res["win_rate"] > bear_res["win_rate"]
    assert bull_res["expected_return_pct"] > bear_res["expected_return_pct"]
    assert bull_res["cvar_95_pct"] < bear_res["cvar_95_pct"] or bull_res["var_95_pct"] <= bear_res["var_95_pct"]


def test_execute_alpha_quant_engine_payload_contract():
    """Valida que o payload retornado segue exatamente a estrutura contratual requerida."""
    params = {
        "tickers": ["NVDA", "MSFT", "AAPL", "PFE"],
        "janelaMarkov": 252,
        "horizonte": 21,
        "n_simulations": 1000
    }
    result = execute_alpha_quant_engine(params)

    assert result["success"] is True
    assert "summary" in result
    assert "assets" in result
    assert "phases" in result

    summary = result["summary"]
    assert summary["total_analyzed"] == 4
    assert "approved_count" in summary
    assert "sharpe_oos" in summary
    assert "dsr_p_value" in summary
    assert "pbo_percentage" in summary
    assert "markov_regime_summary" in summary
    assert "bullish_pct" in summary["markov_regime_summary"]
    assert "bearish_pct" in summary["markov_regime_summary"]

    assets = result["assets"]
    assert len(assets) == 4
    for asset in assets:
        assert "ticker" in asset
        assert "sector" in asset
        assert "graham_score" in asset
        assert "mcginley_status" in asset
        assert "markov_bullish_prob" in asset
        assert "mc_win_rate" in asset
        assert "mc_cvar_95" in asset
        assert "purified_alpha_score" in asset
        assert "status" in asset
        assert asset["status"] in ("Aprovado", "Rejeitado")


def test_run_pipeline_cli_execution():
    """Valida execução via CLI do subprocesso Python como especificado no prompt."""
    payload_str = '{"tickers": ["AAPL", "NVDA", "MSFT"], "janelaMarkov": 252, "horizonte": 21, "n_simulations": 500}'
    cmd = [sys.executable, "python_engine/run_pipeline.py", payload_str]
    proc = subprocess.run(cmd, capture_output=True, text=True)

    assert proc.returncode == 0
    stdout_lines = proc.stdout.strip().split("\n")
    last_line = stdout_lines[-1]
    parsed = json.loads(last_line)

    assert parsed["success"] is True
    assert len(parsed["assets"]) == 3
    assert "markov_regime_summary" in parsed["summary"]
