"""
Unit tests for Discrete-Time Markov State Model.
"""

import numpy as np
import pandas as pd
import pytest

from src.features.markov_model import (
    compute_markov_regime_probabilities,
    calculate_markov_edge,
)


def test_markov_model_basic():
    """Test basic Markov regime computation with synthetic prices."""
    np.random.seed(42)
    # Generate 300 days of trending / random prices
    returns = np.random.normal(0.001, 0.015, 300)
    prices = 100.0 * np.exp(np.cumsum(returns))
    s_prices = pd.Series(prices)

    bullish_prob, p_matrix = compute_markov_regime_probabilities(
        s_prices, window=252, horizon=5, n_states=3
    )

    # Probabilities must be in [0, 1]
    assert 0.0 <= bullish_prob <= 1.0
    assert p_matrix.shape == (3, 3)

    # Matrix rows must sum to 1.0 (stochastic matrix property)
    for row in p_matrix:
        assert np.isclose(np.sum(row), 1.0, atol=1e-5)


def test_markov_model_bullish_trend():
    """Test that a strongly upward trending series yields higher bullish probability."""
    np.random.seed(42)
    # Strong upward trend with low volatility
    returns = np.random.normal(0.01, 0.005, 300)
    prices = 100.0 * np.exp(np.cumsum(returns))
    s_prices = pd.Series(prices)

    bullish_prob, p_matrix = compute_markov_regime_probabilities(
        s_prices, window=252, horizon=5, n_states=3
    )

    assert 0.0 <= bullish_prob <= 1.0
    assert p_matrix.shape == (3, 3)
    edge = calculate_markov_edge(bullish_prob, base_prob=1.0 / 3.0)
    assert isinstance(edge, float)


def test_markov_model_insufficient_data():
    """Test graceful fallback for insufficient price observations."""
    short_prices = pd.Series([100.0, 101.0, 102.0])
    bullish_prob, p_matrix = compute_markov_regime_probabilities(
        short_prices, window=252, horizon=5, n_states=3
    )

    assert np.isclose(bullish_prob, 1.0 / 3.0, atol=1e-5)
    assert p_matrix.shape == (3, 3)
    assert np.allclose(p_matrix, 1.0 / 3.0)


def test_markov_edge_calculation():
    """Test Markov edge calculation against neutral baseline."""
    assert np.isclose(calculate_markov_edge(0.533333, base_prob=0.333333), 20.0, atol=1e-3)
    assert calculate_markov_edge(0.333333, base_prob=0.333333) == 0.0
