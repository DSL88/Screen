#!/usr/bin/env python3
"""
Testes unitários para a escala gradual de convicção estocástica (classify_win_rate_tier).
"""

import pytest
from python_engine.run_pipeline import classify_win_rate_tier, generate_top_investment_recommendations


def test_classify_win_rate_tier_extreme():
    res = classify_win_rate_tier(75.5)
    assert res["tier_id"] == 5
    assert "Extrema" in res["level"]
    assert res["badge"] == "bg-primary"
    assert res["color"] == "#0d6efd"

    res_edge = classify_win_rate_tier(70.0)
    assert res_edge["tier_id"] == 5
    assert "70%+" in res_edge["level"]


def test_classify_win_rate_tier_very_strong():
    res = classify_win_rate_tier(68.2)
    assert res["tier_id"] == 4
    assert "Muito Forte" in res["level"]
    assert "bg-info" in res["badge"]
    assert res["color"] == "#0dcaf0"

    res_edge = classify_win_rate_tier(65.0)
    assert res_edge["tier_id"] == 4


def test_classify_win_rate_tier_strong():
    res = classify_win_rate_tier(62.4)
    assert res["tier_id"] == 3
    assert "Forte" in res["level"]
    assert res["badge"] == "bg-success"
    assert res["color"] == "#198754"

    res_edge = classify_win_rate_tier(60.0)
    assert res_edge["tier_id"] == 3


def test_classify_win_rate_tier_favorable():
    res = classify_win_rate_tier(57.8)
    assert res["tier_id"] == 2
    assert "Favorável" in res["level"]
    assert "bg-teal" in res["badge"]
    assert res["color"] == "#20c997"

    res_edge = classify_win_rate_tier(55.0)
    assert res_edge["tier_id"] == 2


def test_classify_win_rate_tier_moderate():
    res = classify_win_rate_tier(52.1)
    assert res["tier_id"] == 1
    assert "Moderada" in res["level"]
    assert "bg-warning" in res["badge"]
    assert res["color"] == "#ffc107"

    res_edge = classify_win_rate_tier(50.0)
    assert res_edge["tier_id"] == 1


def test_classify_win_rate_tier_weak():
    res = classify_win_rate_tier(48.5)
    assert res["tier_id"] == 0
    assert "Fraca" in res["level"]
    assert res["badge"] == "bg-danger"
    assert res["color"] == "#dc3545"


def test_generate_top_investment_recommendations_with_tiers():
    assets = [
        {
            "ticker": "NVDA",
            "sector": "Technology",
            "current_price": 120.0,
            "status": "Aprovado",
            "approved": True,
            "mc_win_rate": 72.5,
            "mc_expected_return": 8.5,
            "mc_cvar_95": 3.2,
            "quality_score": 85.0
        },
        {
            "ticker": "MSFT",
            "sector": "Technology",
            "current_price": 400.0,
            "status": "Aprovado",
            "approved": True,
            "mc_win_rate": 56.0,
            "mc_expected_return": 3.2,
            "mc_cvar_95": 2.5,
            "quality_score": 80.0
        },
        {
            "ticker": "WEAK",
            "sector": "Other",
            "current_price": 50.0,
            "status": "Aprovado",
            "approved": True,
            "mc_win_rate": 45.0,  # Abaixo de 50%, não deve ser incluído
            "mc_expected_return": 2.0,
            "mc_cvar_95": 4.0,
            "quality_score": 70.0
        }
    ]

    recs = generate_top_investment_recommendations(assets, top_n=5, horizon_days=21)
    assert len(recs) == 2
    tickers = [r["ticker"] for r in recs]
    assert "NVDA" in tickers
    assert "MSFT" in tickers
    assert "WEAK" not in tickers

    nvda_rec = next(r for r in recs if r["ticker"] == "NVDA")
    assert nvda_rec["tier"]["tier_id"] == 5
    assert nvda_rec["win_rate_numeric"] == 72.5
    assert nvda_rec["target_price"] > nvda_rec["current_price"]
    assert nvda_rec["stop_loss"] < nvda_rec["current_price"]

    msft_rec = next(r for r in recs if r["ticker"] == "MSFT")
    assert msft_rec["tier"]["tier_id"] == 2
    assert "Favorável" in msft_rec["tier"]["level"]
