import pytest
import numpy as np
import pandas as pd

from src.features.fundamentals import (
    calculate_current_ratio,
    calculate_debt_to_equity,
    calculate_earnings_yield,
    calculate_price_to_book,
    calculate_roa,
    calculate_fcf_yield,
    calculate_net_income_growth_5y,
    FundamentalScreener,
)


@pytest.fixture
def sample_fundamental_df():
    data = {
        "ticker": ["AAPL", "MSFT", "GOOGL", "WEAK_CO", "RISKY_CO"],
        "current_assets": [130000.0, 180000.0, 150000.0, 40000.0, 10000.0],
        "current_liabilities": [60000.0, 70000.0, 60000.0, 50000.0, 15000.0],
        "total_liabilities": [100000.0, 120000.0, 80000.0, 90000.0, 80000.0],
        "total_equity": [80000.0, 100000.0, 120000.0, 20000.0, 10000.0],
        "eps": [6.0, 9.5, 5.8, -0.5, 0.2],
        "price": [175.0, 330.0, 135.0, 12.0, 5.0],
        "market_cap": [2800000.0, 2400000.0, 1700000.0, 100000.0, 20000.0],
        "book_value": [80000.0, 100000.0, 120000.0, 20000.0, 10000.0],
        "net_income": [100000.0, 72000.0, 60000.0, -2000.0, 500.0],
        "total_assets": [350000.0, 380000.0, 300000.0, 80000.0, 30000.0],
        "free_cash_flow": [90000.0, 65000.0, 55000.0, -1000.0, 200.0],
        "enterprise_value": [2850000.0, 2450000.0, 1650000.0, 120000.0, 30000.0],
        "net_income_5y_ago": [60000.0, 40000.0, 35000.0, 5000.0, -1000.0],
    }
    return pd.DataFrame(data)


def test_calculate_current_ratio():
    ca = pd.Series([100.0, 200.0, 50.0])
    cl = pd.Series([50.0, 0.0, 25.0])
    cr = calculate_current_ratio(ca, cl)
    
    assert cr.iloc[0] == 2.0
    assert np.isnan(cr.iloc[1])
    assert cr.iloc[2] == 2.0


def test_calculate_debt_to_equity():
    tl = pd.Series([150.0, 100.0, 50.0])
    te = pd.Series([100.0, 0.0, -20.0])
    de = calculate_debt_to_equity(tl, te)
    
    assert de.iloc[0] == 1.5
    assert np.isnan(de.iloc[1])
    assert np.isnan(de.iloc[2])


def test_calculate_earnings_yield():
    eps = pd.Series([5.0, 10.0, -1.0])
    price = pd.Series([100.0, 0.0, 50.0])
    ey = calculate_earnings_yield(eps, price)
    
    assert ey.iloc[0] == 0.05
    assert np.isnan(ey.iloc[1])
    assert ey.iloc[2] == -0.02


def test_calculate_price_to_book():
    mcap = pd.Series([300.0, 100.0])
    bv = pd.Series([150.0, 0.0])
    pb = calculate_price_to_book(mcap, bv)
    
    assert pb.iloc[0] == 2.0
    assert np.isnan(pb.iloc[1])


def test_calculate_roa():
    ni = pd.Series([50.0, 0.0])
    ta = pd.Series([500.0, 0.0])
    roa = calculate_roa(ni, ta)
    
    assert roa.iloc[0] == 0.10
    assert np.isnan(roa.iloc[1])


def test_calculate_fcf_yield():
    fcf = pd.Series([100.0, -20.0])
    ev = pd.Series([1000.0, 500.0])
    fcf_y = calculate_fcf_yield(fcf, ev)
    
    assert fcf_y.iloc[0] == 0.10
    assert fcf_y.iloc[1] == -0.04


def test_calculate_net_income_growth_5y():
    ni_curr = pd.Series([161.051, 100.0])
    ni_5y = pd.Series([100.0, -50.0])
    cagr = calculate_net_income_growth_5y(ni_curr, ni_5y)
    
    assert pytest.approx(cagr.iloc[0], rel=1e-3) == 0.10
    assert np.isnan(cagr.iloc[1])


def test_fundamental_screener_solvency_and_graham(sample_fundamental_df):
    screener = FundamentalScreener(sample_fundamental_df)
    df_computed = screener.compute_all_metrics()

    assert "current_ratio" in df_computed.columns
    assert "debt_to_equity" in df_computed.columns
    assert "roa" in df_computed.columns
    assert "earnings_yield" in df_computed.columns

    # Test apply_solvency_filter returning tuple (filtered_df, mask)
    filtered_df, mask = screener.apply_solvency_filter(min_current_ratio=1.5, max_debt_equity=2.0, min_roa=0.0)

    # AAPL (CR=2.17, DE=1.25, ROA=28.57%), MSFT (CR=2.57, DE=1.20, ROA=18.95%), GOOGL (CR=2.50, DE=0.67, ROA=20.0%) -> Pass
    # WEAK_CO (CR=0.80, DE=4.50, ROA=-2.50%) -> Fail
    # RISKY_CO (CR=0.67, DE=8.00, ROA=1.67%) -> Fail
    passed_tickers = set(filtered_df["ticker"].tolist())
    assert passed_tickers == {"AAPL", "MSFT", "GOOGL"}
    assert len(filtered_df) == 3

    # Test Graham quality score
    scores = screener.calculate_graham_quality_score()
    assert len(scores) == 5
    assert scores.iloc[0] > scores.iloc[3]  # AAPL > WEAK_CO
    assert scores.iloc[1] > scores.iloc[4]  # MSFT > RISKY_CO
    assert 0.0 <= scores.min() and scores.max() <= 100.0
