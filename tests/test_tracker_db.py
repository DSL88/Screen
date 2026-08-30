#!/usr/bin/env python3
"""
Testes unitários para o módulo de rastreio e feedback loop (tracker_db).
"""

import os
import tempfile
import sqlite3
import pytest
from unittest.mock import patch, MagicMock
import pandas as pd

from python_engine.tracker_db import (
    init_tracker_db,
    save_recommendation,
    evaluate_tracked_assets,
    get_model_accuracy_metrics,
    get_all_tracked_recommendations
)


@pytest.fixture
def temp_db():
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as tmp:
        db_path = tmp.name
    init_tracker_db(db_path)
    yield db_path
    if os.path.exists(db_path):
        os.remove(db_path)


def test_init_and_save_recommendation(temp_db):
    asset_data = {
        "ticker": "NVDA",
        "sector": "Technology",
        "current_price": 120.0,
        "target_price": 130.0,
        "stop_loss": 115.0,
        "horizon_days": 21,
        "win_rate_numeric": 72.5,
        "alpha_score": 88.4
    }
    
    res = save_recommendation(asset_data, db_path=temp_db)
    assert res["success"] is True
    assert res["ticker"] == "NVDA"
    assert res["id"] is not None

    tracked = get_all_tracked_recommendations(db_path=temp_db)
    assert len(tracked) == 1
    assert tracked[0]["ticker"] == "NVDA"
    assert tracked[0]["status"] == "PENDENTE"
    assert tracked[0]["predicted_win_rate"] == 72.5
    assert tracked[0]["alpha_score"] == 88.4


def test_get_model_accuracy_metrics_empty(temp_db):
    metrics = get_model_accuracy_metrics(db_path=temp_db)
    assert metrics["total_trades"] == 0
    assert metrics["hit_rate"] == 0.0
    assert metrics["avg_return"] == 0.0


def test_get_model_accuracy_metrics_with_completed_trades(temp_db):
    conn = sqlite3.connect(temp_db)
    cursor = conn.cursor()
    cursor.execute('''
        INSERT INTO tracked_recommendations (
            ticker, sector, entry_date, entry_price, target_price, stop_loss,
            horizon_days, predicted_win_rate, alpha_score, status, exit_price, exit_date, realized_return_pct
        ) VALUES 
        ('NVDA', 'Tech', '2026-08-01', 100.0, 110.0, 95.0, 21, 70.0, 85.0, 'TARGET_ATINGIDO', 110.0, '2026-08-10', 10.0),
        ('MSFT', 'Tech', '2026-08-01', 400.0, 420.0, 390.0, 21, 65.0, 80.0, 'STOP_LOSS_ATINGIDO', 390.0, '2026-08-15', -2.5),
        ('AAPL', 'Tech', '2026-08-01', 200.0, 215.0, 190.0, 21, 68.0, 82.0, 'TARGET_ATINGIDO', 215.0, '2026-08-18', 7.5),
        ('PENDING', 'Tech', '2026-08-20', 50.0, 55.0, 47.0, 21, 55.0, 60.0, 'PENDENTE', NULL, NULL, NULL)
    ''')
    conn.commit()
    conn.close()

    metrics = get_model_accuracy_metrics(db_path=temp_db)
    assert metrics["total_trades"] == 3
    assert metrics["target_hits"] == 2
    assert metrics["stop_hits"] == 1
    assert metrics["hit_rate"] == round((2 / 3) * 100.0, 1)  # 66.7%
    assert metrics["avg_return"] == round((10.0 - 2.5 + 7.5) / 3, 2)  # 5.0%


def test_evaluate_tracked_assets_target_hit(temp_db):
    save_recommendation({
        "ticker": "NVDA",
        "sector": "Technology",
        "current_price": 100.0,
        "target_price": 110.0,
        "stop_loss": 95.0,
        "horizon_days": 21,
        "win_rate_numeric": 70.0,
        "alpha_score": 85.0
    }, db_path=temp_db)

    # Mock Yahoo Finance historical price where High hits target
    mock_df = pd.DataFrame({
        "Close": [108.0],
        "High": [112.0],
        "Low": [98.0]
    })
    
    with patch("yfinance.Ticker") as mock_ticker:
        mock_instance = MagicMock()
        mock_instance.history.return_value = mock_df
        mock_ticker.return_value = mock_instance

        eval_res = evaluate_tracked_assets(db_path=temp_db)
        assert eval_res["success"] is True
        assert eval_res["evaluated_count"] == 1
        assert eval_res["updated"][0]["status"] == "TARGET_ATINGIDO"
        assert eval_res["updated"][0]["realized_return_pct"] == 10.0


def test_evaluate_tracked_assets_stop_loss_hit(temp_db):
    save_recommendation({
        "ticker": "MSFT",
        "sector": "Technology",
        "current_price": 100.0,
        "target_price": 110.0,
        "stop_loss": 95.0,
        "horizon_days": 21,
        "win_rate_numeric": 65.0,
        "alpha_score": 80.0
    }, db_path=temp_db)

    # Mock Yahoo Finance where Low hits stop loss
    mock_df = pd.DataFrame({
        "Close": [96.0],
        "High": [102.0],
        "Low": [94.0]
    })
    
    with patch("yfinance.Ticker") as mock_ticker:
        mock_instance = MagicMock()
        mock_instance.history.return_value = mock_df
        mock_ticker.return_value = mock_instance

        eval_res = evaluate_tracked_assets(db_path=temp_db)
        assert eval_res["success"] is True
        assert eval_res["evaluated_count"] == 1
        assert eval_res["updated"][0]["status"] == "STOP_LOSS_ATINGIDO"
        assert eval_res["updated"][0]["realized_return_pct"] == -5.0
