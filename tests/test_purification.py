import pytest
import numpy as np
import pandas as pd

from src.features.purification import (
    compute_vif,
    compute_vif_dataframe,
    select_informative_features,
    neutralize_factors,
    neutralize_feature_two_stage,
    FeaturePurifier,
)



def test_compute_vif_basic():
    np.random.seed(42)
    x1 = np.random.normal(0, 1, 100)
    x2 = np.random.normal(0, 1, 100)
    # x3 is highly collinear with x1
    x3 = 2.0 * x1 + np.random.normal(0, 0.05, 100)

    df = pd.DataFrame({"feat1": x1, "feat2": x2, "feat3": x3})
    vif_df = compute_vif(df)

    assert len(vif_df) == 3
    assert "vif" in vif_df.columns
    assert "multicollinearity_level" in vif_df.columns

    # x1 and x3 should have high VIF (> 10)
    vif_map = dict(zip(vif_df["feature"], vif_df["vif"]))
    assert vif_map["feat1"] > 10.0
    assert vif_map["feat3"] > 10.0
    assert vif_map["feat2"] < 5.0


def test_select_informative_features_cfi():
    np.random.seed(42)
    n = 200

    # Informative base features
    true_f1 = np.random.normal(0, 1, n)
    true_f2 = np.random.normal(0, 1, n)

    # Redundant clones (correlated)
    clone_f1 = true_f1 + np.random.normal(0, 0.1, n)
    
    # Pure noise feature
    noise_f = np.random.normal(0, 1, n)

    X = pd.DataFrame({
        "signal_1": true_f1,
        "clone_1": clone_f1,
        "signal_2": true_f2,
        "random_noise": noise_f,
    })

    # Target depends on signal_1 and signal_2
    y = 3.0 * true_f1 - 2.0 * true_f2 + np.random.normal(0, 0.5, n)

    res = select_informative_features(X, y, is_classification=False, corr_threshold=0.8)

    assert "informative_features" in res
    assert "redundant_features" in res
    assert "noise_features" in res
    assert "feature_importance_df" in res

    # Informative set should capture the key signals while mitigating duplicate clones
    assert len(res["informative_features"]) >= 2
    assert "signal_1" in res["informative_features"] or "clone_1" in res["informative_features"]


def test_neutralize_factors_two_stage():
    np.random.seed(42)
    n = 150
    tickers = [f"ASSET_{i}" for i in range(n)]

    sectors = np.random.choice(["Tech", "Health", "Energy"], size=n)
    mcap = np.random.uniform(1e8, 1e11, size=n)

    # Feature strongly loaded on Tech sector and Market Cap size
    tech_dummy = (sectors == "Tech").astype(float)
    log_mcap = np.log(mcap)
    
    raw_feature = 5.0 * tech_dummy + 0.8 * log_mcap + np.random.normal(0, 1, n)
    features_df = pd.DataFrame({"momentum_raw": raw_feature}, index=tickers)
    sector_s = pd.Series(sectors, index=tickers)
    mcap_s = pd.Series(mcap, index=tickers)

    purified = neutralize_factors(features_df, sector_s, mcap_s)

    assert purified.shape == features_df.shape
    assert "momentum_raw" in purified.columns

    # Residuals should now have ~0 correlation with sector dummy and log mcap
    purified_val = purified["momentum_raw"].to_numpy()
    
    corr_size = np.corrcoef(purified_val, log_mcap)[0, 1]
    assert abs(corr_size) < 0.05  # Size bias neutralized!


def test_neutralize_feature_two_stage_and_purifier():
    np.random.seed(42)
    n_assets = 100
    sectors = np.random.choice(["Technology", "Financials", "Healthcare", "Energy"], size=n_assets)
    market_caps = np.random.uniform(1e8, 5e11, size=n_assets)

    tech_bias = np.where(sectors == "Technology", 2.5, 0.0)
    size_bias = np.log(market_caps) * 0.4
    raw_indicator = np.random.normal(0, 1, size=n_assets) + tech_bias + size_bias
    correlated_indicator = raw_indicator * 0.85 + np.random.normal(0, 0.2, size=n_assets)

    df_portfolio = pd.DataFrame({
        "ticker": [f"STOCK_{i}" for i in range(n_assets)],
        "sector": sectors,
        "market_cap": market_caps,
        "momentum_raw": raw_indicator,
        "mcginley_raw": correlated_indicator,
    })

    # Test single feature two stage
    s_purified = neutralize_feature_two_stage(df_portfolio, "momentum_raw", "sector", "market_cap")
    assert len(s_purified) == n_assets
    assert s_purified.name == "momentum_raw_purified"

    # Test FeaturePurifier class
    purifier = FeaturePurifier(df_portfolio, sector_col="sector", market_cap_col="market_cap")
    purified_df = purifier.neutralize_all_features(["momentum_raw", "mcginley_raw"])
    assert "momentum_raw_purified" in purified_df.columns
    assert "mcginley_raw_purified" in purified_df.columns

    # Test compute_vif_dataframe before & after
    vif_before = compute_vif_dataframe(df_portfolio[["momentum_raw", "mcginley_raw"]])
    assert not vif_before.empty
    assert "VIF" in vif_before.columns

    vif_after = compute_vif_dataframe(purified_df)
    assert not vif_after.empty
    assert vif_after["VIF"].iloc[0] < vif_before["VIF"].iloc[0]

