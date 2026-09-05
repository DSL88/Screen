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


def _make_assets(n):
    """Gera n ativos aprovados e elegíveis (win rate > 50%, retorno positivo)."""
    assets = []
    for i in range(n):
        assets.append({
            "ticker": f"TKR{i:02d}",
            "sector": "Tech",
            "current_price": 100.0 + i,
            "status": "Aprovado",
            "approved": True,
            "mc_win_rate": 60.0 + (i % 20),
            "mc_expected_return": 3.0 + (i % 5),
            "mc_cvar_95": 3.0,
            "quality_score": 70.0 + (i % 10),
        })
    return assets


def test_recommendations_top_n_none_caps_at_20():
    assets = _make_assets(25)
    recs = generate_top_investment_recommendations(assets, top_n=None, horizon_days=35)
    assert len(recs) == 20


def test_recommendations_default_returns_top_20():
    assets = _make_assets(30)
    recs = generate_top_investment_recommendations(assets)
    assert len(recs) == 20


def test_recommendations_top_n_zero_floors_at_15():
    assets = _make_assets(20)
    recs = generate_top_investment_recommendations(assets, top_n=0)
    # top_n=0 -> falsy no max/min? garantir piso 15 quando há >=15 elegíveis
    assert len(recs) >= 15


def test_recommendations_floor_15_when_few_requested():
    assets = _make_assets(25)
    recs = generate_top_investment_recommendations(assets, top_n=5)
    # Piso de 15: mesmo pedindo 5, devolve os 15 melhores
    assert len(recs) == 15


def test_recommendations_cap_20_when_many_requested():
    assets = _make_assets(30)
    recs = generate_top_investment_recommendations(assets, top_n=50)
    # Teto de 20: nunca devolve mais de 20
    assert len(recs) == 20


def test_recommendations_returns_all_when_fewer_than_floor():
    assets = _make_assets(7)
    recs = generate_top_investment_recommendations(assets, top_n=20)
    assert len(recs) == 7


def test_recommendations_include_metadata():
    assets = _make_assets(3)
    for a in assets:
        a["name"] = "Empresa Teste SGPS"
        a["country"] = "Portugal"
        a["index_name"] = "PSI"
    recs = generate_top_investment_recommendations(assets, top_n=20)
    assert len(recs) == 3
    for r in recs:
        assert r["name"] == "Empresa Teste SGPS"
        assert r["country"] == "Portugal"
        assert r["index_name"] == "PSI"


def test_recommendations_metadata_defaults():
    assets = _make_assets(1)  # sem name/country/index_name
    recs = generate_top_investment_recommendations(assets, top_n=20)
    r = recs[0]
    assert r["name"] == r["ticker"]
    assert r["country"] == "Global"
    assert r["index_name"] == "Geral"


def test_recommendations_sorted_by_alpha_score_descending():
    assets = _make_assets(10)
    recs = generate_top_investment_recommendations(assets, top_n=None)
    alphas = [r["alpha_score"] for r in recs]
    assert alphas == sorted(alphas, reverse=True)


def test_recommendations_have_ranking_1_to_n():
    assets = _make_assets(18)
    recs = generate_top_investment_recommendations(assets, top_n=20)
    assert [r["rank"] for r in recs] == list(range(1, 19))
    assert recs[0]["alpha_score"] >= recs[-1]["alpha_score"]
