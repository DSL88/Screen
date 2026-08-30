"""
Unit Tests for Concurrent API Data Loader with SQLite Cache (python_engine/api_data_loader.py).
"""

import os
import time
import json
import sqlite3
import pytest
import numpy as np
import pandas as pd
from unittest.mock import MagicMock, patch

from python_engine.api_data_loader import (
    init_db,
    get_cached_data,
    save_to_cache,
    fetch_single_asset_api,
    fetch_all_assets_parallel,
    _build_synthetic_asset,
)


@pytest.fixture
def temp_db(tmp_path):
    db_file = str(tmp_path / "test_quant_cache.db")
    init_db(db_file)
    return db_file


def test_init_db(temp_db):
    assert os.path.exists(temp_db)
    conn = sqlite3.connect(temp_db)
    cursor = conn.cursor()
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='asset_cache'")
    table = cursor.fetchone()
    conn.close()
    assert table is not None
    assert table[0] == "asset_cache"


def test_save_and_get_cached_data(temp_db):
    ticker = "AAPL"
    data = {
        "ticker": "AAPL",
        "sector": "Technology",
        "market_cap": 3000000000000.0,
        "valid": True,
        "price_history": [150.0, 152.0, 155.0]
    }

    # Should be None initially
    assert get_cached_data(ticker, db_path=temp_db) is None

    # Save to cache
    save_to_cache(ticker, data, db_path=temp_db)

    # Retrieve from cache
    cached = get_cached_data(ticker, max_age_seconds=86400, db_path=temp_db)
    assert cached is not None
    assert cached["ticker"] == "AAPL"
    assert cached["sector"] == "Technology"
    assert cached["price_history"] == [150.0, 152.0, 155.0]


def test_cache_ttl_expiry(temp_db):
    ticker = "MSFT"
    data = {"ticker": "MSFT", "valid": True}

    save_to_cache(ticker, data, db_path=temp_db)

    # Artificially age the timestamp in DB
    conn = sqlite3.connect(temp_db)
    cursor = conn.cursor()
    old_time = time.time() - 100000  # Older than 1 day
    cursor.execute("UPDATE asset_cache SET timestamp = ? WHERE ticker = ?", (old_time, ticker))
    conn.commit()
    conn.close()

    # Query with max_age of 1 day (86400s) -> should return None (expired)
    expired = get_cached_data(ticker, max_age_seconds=86400, db_path=temp_db)
    assert expired is None

    # Query with max_age of 30 days (2592000s) -> should return valid data
    valid_30d = get_cached_data(ticker, max_age_seconds=2592000, db_path=temp_db)
    assert valid_30d is not None
    assert valid_30d["ticker"] == "MSFT"


def test_build_synthetic_asset():
    synth = _build_synthetic_asset("NVDA")
    assert synth["ticker"] == "NVDA"
    assert synth["valid"] is True
    assert len(synth["price_history"]) == 252
    assert len(synth["volume_history"]) == 252
    assert synth["current_ratio"] > 0
    assert synth["market_cap"] > 0
    assert len(synth["headlines"]) > 0


@patch("python_engine.api_data_loader.yf.Ticker")
def test_fetch_single_asset_api_success(mock_ticker_class, temp_db):
    mock_ticker = MagicMock()
    mock_ticker.info = {
        "sector": "Technology",
        "marketCap": 2000000000000,
        "currentRatio": 1.8,
        "debtToEquity": 45.0,  # Should be normalized to 0.45
        "returnOnAssets": 0.15,
        "trailingEps": 5.2,
        "currentPrice": 220.0,
        "freeCashflow": 60000000000,
        "enterpriseValue": 2100000000000
    }
    
    dates = pd.date_range("2025-01-01", periods=100, freq="B")
    mock_ticker.history.return_value = pd.DataFrame({
        "Close": np.linspace(180, 220, 100),
        "Volume": np.random.randint(1000000, 5000000, 100)
    }, index=dates)

    mock_ticker.news = [
        {"title": "Tech giant announces new breakthrough architecture and quarterly expansion."}
    ]

    mock_ticker_class.return_value = mock_ticker

    res = fetch_single_asset_api("MOCK_TECH", max_age_seconds=86400, db_path=temp_db)
    assert res["ticker"] == "MOCK_TECH"
    assert res["valid"] is True
    assert res["sector"] == "Technology"
    assert res["debt_to_equity"] == 0.45  # Correctly converted from 45.0%
    assert res["current_ratio"] == 1.8
    assert res["roa"] == 0.15
    assert len(res["price_history"]) == 100
    assert len(res["headlines"]) == 1

    # Verify it was persisted to SQLite cache
    cached = get_cached_data("MOCK_TECH", db_path=temp_db)
    assert cached is not None
    assert cached["ticker"] == "MOCK_TECH"


def test_fetch_all_assets_parallel(temp_db):
    tickers = ["AAPL", "MSFT", "NVDA", "SAN.MC", "BBVA.MC"]
    
    # Pre-populate cache for some to test hybrid retrieval
    save_to_cache("AAPL", _build_synthetic_asset("AAPL"), db_path=temp_db)
    save_to_cache("MSFT", _build_synthetic_asset("MSFT"), db_path=temp_db)

    results = fetch_all_assets_parallel(tickers, max_workers=5, db_path=temp_db)
    assert len(results) == len(tickers)
    for sym in tickers:
        assert sym in results
        assert results[sym]["valid"] is True
        assert len(results[sym]["price_history"]) >= 20
