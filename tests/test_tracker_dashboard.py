#!/usr/bin/env python3
"""
Testes unitários para a aba AlphaQuant Tracker & Performance (get_tracker_dashboard_data e agregação analítica).
"""

import os
import tempfile
import sqlite3
import pytest
import pandas as pd
from unittest.mock import patch, MagicMock

from python_engine.tracker_db import (
    init_tracker_db,
    save_recommendation,
    evaluate_tracked_assets,
    get_tracker_dashboard_data,
    get_model_accuracy_metrics
)


@pytest.fixture
def temp_db():
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as tmp:
        db_path = tmp.name
    init_tracker_db(db_path)
    yield db_path
    if os.path.exists(db_path):
        os.remove(db_path)


def test_get_tracker_dashboard_empty(temp_db):
    data = get_tracker_dashboard_data(db_path=temp_db)
    assert data["success"] is True
    assert data["kpis"]["total_recommendations"] == 0
    assert data["kpis"]["hit_rate"] == 0.0
    assert data["kpis"]["profit_factor"] == 1.0
    assert len(data["tier_matrix"]) == 5
    assert len(data["cohort_dates"]) == 0
    assert len(data["items"]) == 0


def test_get_tracker_dashboard_populated(temp_db):
    conn = sqlite3.connect(temp_db)
    cursor = conn.cursor()
    cursor.execute('''
        INSERT INTO tracked_recommendations (
            ticker, sector, entry_date, recommendation_date, entry_price, target_price, stop_loss, stop_loss_price,
            horizon_days, predicted_win_rate, mc_win_rate, mc_tier_label, alpha_score, status, current_price,
            exit_price, exit_date, realized_pnl_pct, realized_return_pct, max_favorable_excursion, max_adverse_excursion, days_to_exit
        ) VALUES 
        ('NVDA', 'Technology', '2026-08-28', '2026-08-28', 120.0, 128.0, 115.0, 115.0, 21, 72.5, 72.5, 'Extrema (70%+)', 91.0, 'TARGET_ATINGIDO', 128.0, 128.0, '2026-08-30', 6.67, 6.67, 7.5, -1.2, 2),
        ('MSFT', 'Technology', '2026-08-28', '2026-08-28', 400.0, 425.0, 385.0, 385.0, 21, 66.0, 66.0, 'Muito Forte (65-69%)', 84.0, 'PENDENTE', 410.0, NULL, NULL, 2.5, 2.5, 3.2, -0.5, NULL),
        ('AAPL', 'Technology', '2026-08-25', '2026-08-25', 200.0, 215.0, 190.0, 190.0, 21, 62.0, 62.0, 'Forte (60-64%)', 80.0, 'STOP_LOSS_ATINGIDO', 190.0, 190.0, '2026-08-27', -5.0, -5.0, 1.0, -5.5, 2),
        ('SAN.MC', 'Financials', '2026-08-20', '2026-08-20', 4.0, 4.4, 3.8, 3.8, 21, 56.0, 56.0, 'Favorável (55-59%)', 72.0, 'TARGET_ATINGIDO', 4.4, 4.4, '2026-08-26', 10.0, 10.0, 11.2, -2.0, 6)
    ''')
    conn.commit()
    conn.close()

    dash = get_tracker_dashboard_data(db_path=temp_db)
    assert dash["success"] is True
    kpis = dash["kpis"]
    assert kpis["total_recommendations"] == 4
    assert kpis["active_pending"] == 1
    assert kpis["target_hits"] == 2
    assert kpis["stop_hits"] == 1
    assert kpis["resolved_trades"] == 3
    # Hit rate: 2 targets out of 3 resolved = 66.7%
    assert kpis["hit_rate"] == 66.7
    # Profit factor: (6.67 + 10.0) / 5.0 = 16.67 / 5.0 = 3.33
    assert kpis["profit_factor"] == 3.33
    # Average return across all: (6.67 + 2.5 - 5.0 + 10.0) / 4 = 3.54
    assert kpis["avg_return_pct"] == 3.54
    # Days to target: (2 + 6) / 2 = 4.0
    assert kpis["avg_days_to_target"] == 4.0

    # Test Cohorts
    cohorts = dash["cohort_dates"]
    assert "2026-08-28" in cohorts
    assert "2026-08-25" in cohorts
    assert "2026-08-20" in cohorts

    # Test Tier Matrix
    tier_matrix = dash["tier_matrix"]
    t5 = next(t for t in tier_matrix if t["tier_id"] == 5)
    assert t5["suggestions_count"] == 1
    assert t5["targets_hit"] == 1
    assert t5["hit_rate_real"] == 100.0

    t4 = next(t for t in tier_matrix if t["tier_id"] == 4)
    assert t4["suggestions_count"] == 1
    assert t4["targets_hit"] == 0

    t3 = next(t for t in tier_matrix if t["tier_id"] == 3)
    assert t3["suggestions_count"] == 1
    assert t3["stops_hit"] == 1
    assert t3["hit_rate_real"] == 0.0

    t2 = next(t for t in tier_matrix if t["tier_id"] == 2)
    assert t2["suggestions_count"] == 1
    assert t2["targets_hit"] == 1
    assert t2["hit_rate_real"] == 100.0


def test_save_recommendation_with_tier_and_dates(temp_db):
    res = save_recommendation({
        "ticker": "NVDA",
        "sector": "Technology",
        "current_price": 120.5,
        "target_price": 135.0,
        "stop_loss": 112.0,
        "horizon_days": 21,
        "win_rate_numeric": 74.2,
        "tier": {"level": "Extrema (70%+)", "color": "#0d6efd", "badge": "bg-primary", "tier_id": 5},
        "alpha_score": 92.5,
        "entry_date": "2026-08-30"
    }, db_path=temp_db)

    assert res["success"] is True
    dash = get_tracker_dashboard_data(db_path=temp_db)
    assert len(dash["items"]) == 1
    item = dash["items"][0]
    assert item["ticker"] == "NVDA"
    assert item["mc_tier_label"] == "Extrema (70%+)"
    assert item["entry_price"] == 120.5
    assert item["status"] == "PENDENTE"
