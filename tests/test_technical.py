import pytest
import numpy as np
import pandas as pd

from src.features.technical import (
    compute_mcginley_dynamic,
    mcginley_dynamic,
    compute_volatility_adjusted_momentum,
    compute_cross_sectional_momentum,
    compute_cross_sectional_ranks,
    build_dollar_bars,
    _mcginley_dynamic_numba,
)


def test_mcginley_dynamic_numba_direct():
    prices = np.array([100.0, 102.0, 105.0, 103.0, 108.0], dtype=np.float64)
    mg = _mcginley_dynamic_numba(prices, period=14, k=0.6)
    assert len(mg) == len(prices)
    assert mg[0] == 100.0
    assert 99.0 < mg[-1] < 108.0


def test_mcginley_dynamic_basic():
    prices = pd.Series([100.0, 102.0, 105.0, 103.0, 108.0, 110.0, 107.0, 112.0, 115.0, 120.0])
    mgd = mcginley_dynamic(prices, n=10, k=0.6)
    
    assert len(mgd) == len(prices)
    assert mgd.iloc[0] == 100.0
    assert 95.0 < mgd.iloc[-1] < 125.0
    assert not mgd.isna().any()

    # Also test compute_mcginley_dynamic
    mgd_comp = compute_mcginley_dynamic(prices, period=10, k=0.6)
    assert np.allclose(mgd.values, mgd_comp.values)


def test_mcginley_dynamic_empty_and_nan():
    empty_s = pd.Series([], dtype=float)
    mgd_empty = compute_mcginley_dynamic(empty_s)
    assert len(mgd_empty) == 0

    nan_s = pd.Series([np.nan, np.nan, 100.0, 105.0])
    mgd_nan = compute_mcginley_dynamic(nan_s, period=5)
    assert np.isnan(mgd_nan.iloc[0])
    assert np.isnan(mgd_nan.iloc[1])
    assert mgd_nan.iloc[2] == 100.0
    assert mgd_nan.iloc[3] > 100.0


def test_compute_cross_sectional_momentum():
    dates = pd.date_range("2024-01-01", periods=300, freq="B")
    np.random.seed(42)
    
    ret_a = np.random.normal(0.002, 0.01, size=len(dates))
    ret_b = np.random.normal(0.000, 0.01, size=len(dates))
    ret_c = np.random.normal(-0.002, 0.01, size=len(dates))
    
    price_a = 100 * np.exp(np.cumsum(ret_a))
    price_b = 100 * np.exp(np.cumsum(ret_b))
    price_c = 100 * np.exp(np.cumsum(ret_c))
    
    df_prices = pd.DataFrame({"AAPL": price_a, "MSFT": price_b, "GOOGL": price_c}, index=dates)
    mom_df = compute_cross_sectional_momentum(df_prices)
    
    assert "mom_rank_1M_AAPL" in mom_df.columns
    assert "mom_rank_3M_AAPL" in mom_df.columns
    assert "mom_rank_12M_AAPL" in mom_df.columns
    assert len(mom_df) == len(df_prices)


def test_volatility_adjusted_momentum_and_ranks():
    dates = pd.date_range("2024-01-01", periods=300, freq="B")
    np.random.seed(42)
    
    ret_a = np.random.normal(0.002, 0.01, size=len(dates))
    ret_b = np.random.normal(0.000, 0.01, size=len(dates))
    ret_c = np.random.normal(-0.002, 0.01, size=len(dates))
    
    price_a = 100 * np.exp(np.cumsum(ret_a))
    price_b = 100 * np.exp(np.cumsum(ret_b))
    price_c = 100 * np.exp(np.cumsum(ret_c))
    
    prices = pd.DataFrame({"A": price_a, "B": price_b, "C": price_c}, index=dates)
    
    ranks = compute_cross_sectional_ranks(prices, windows=(21, 63, 252))
    
    assert "rank_21d" in ranks
    assert "rank_63d" in ranks
    assert "rank_252d" in ranks
    assert "composite_rank" in ranks
    
    comp = ranks["composite_rank"]
    assert comp.shape == prices.shape
    
    # Toward the end, A should have higher composite rank than C
    last_ranks = comp.iloc[-1]
    assert last_ranks["A"] > last_ranks["C"]
    assert 0.0 <= last_ranks.min() <= 1.0
    assert 0.0 <= last_ranks.max() <= 1.0


def test_build_dollar_bars():
    # 10 ticks, each price=100, volume=50 -> dollar value = 5000 per tick
    ticks = []
    base_time = pd.Timestamp("2026-01-01 09:30:00")
    for i in range(10):
        ticks.append({
            "timestamp": base_time + pd.Timedelta(seconds=i * 10),
            "price": 100.0 + (i % 3),
            "volume": 50.0
        })
    df_ticks = pd.DataFrame(ticks)
    
    # Threshold = $10,000 -> grouped by (cum_dollar // threshold)
    bars = build_dollar_bars(df_ticks, threshold=10000.0)
    
    assert len(bars) in (5, 6)
    assert set(bars.columns) >= {
        "timestamp", "timestamp_start", "timestamp_end", "open", "high", "low", "close",
        "volume", "dollar_volume", "vwap", "tick_count"
    }
    assert bars["dollar_volume"].iloc[1] >= 10000.0
    assert bars["volume"].iloc[1] == 100.0


def test_build_dollar_bars_empty():
    df_empty = pd.DataFrame(columns=["timestamp", "price", "volume"])
    bars = build_dollar_bars(df_empty, threshold=5000.0)
    assert len(bars) == 0
    assert "open" in bars.columns
