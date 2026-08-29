import pytest
import numpy as np
import pandas as pd
from sklearn.linear_model import RidgeClassifier
from sklearn.ensemble import RandomForestClassifier

from src.validation.cpcv_evaluator import (
    CombinatorialPurgedKFold,
    probabilistic_sharpe_ratio,
    deflated_sharpe_ratio,
    compute_pbo,
    CPCVEvaluator,
    compute_sharpe_ratio,
    compute_deflated_sharpe_ratio,
    CPCVSplitter,
    compute_pbo_from_cpcv,
)



def test_combinatorial_purged_kfold_split_counts():
    n_samples = 300
    X = pd.DataFrame(np.random.randn(n_samples, 5))
    
    # N=5, k=2 -> C(5, 2) = 10 combinations
    cv = CombinatorialPurgedKFold(n_splits=5, n_test_splits=2, pct_embargo=0.02, horizon_samples=2)
    assert cv.n_combinations == 10

    splits = list(cv.split(X))
    assert len(splits) == 10

    for train_idx, test_idx in splits:
        assert len(test_idx) > 0
        assert len(train_idx) > 0
        # Check no overlap between train and test
        assert len(set(train_idx).intersection(set(test_idx))) == 0


def test_probabilistic_and_deflated_sharpe_ratio():
    # Higher observed Sharpe ratio yields higher PSR
    psr_high = probabilistic_sharpe_ratio(sr_observed=2.0, sr_benchmark=0.0, sample_length=252)
    psr_low = probabilistic_sharpe_ratio(sr_observed=0.2, sr_benchmark=0.0, sample_length=252)
    
    assert psr_high > psr_low
    assert 0.0 <= psr_high <= 1.0

    # Deflated Sharpe Ratio penalizes multiple trials
    dsr_1_trial = deflated_sharpe_ratio(sr_observed=1.5, n_trials=1, var_sr_trials=0.2, sample_length=252)
    dsr_100_trials = deflated_sharpe_ratio(sr_observed=1.5, n_trials=100, var_sr_trials=0.2, sample_length=252)
    
    assert dsr_1_trial > dsr_100_trials  # Multiple testing selection bias penalty


def test_compute_pbo():
    np.random.seed(42)
    n_splits = 20
    n_models = 10

    # Perfect correlation between IS and OOS (No Overfitting)
    is_scores = np.random.normal(1.0, 0.5, size=(n_splits, n_models))
    oos_scores = is_scores + np.random.normal(0, 0.01, size=(n_splits, n_models))

    pbo_clean = compute_pbo(oos_scores, is_scores)
    assert pbo_clean["pbo"] < 0.2

    # Severe Overfitting: IS is purely negative of OOS
    oos_overfit = -is_scores
    pbo_severe = compute_pbo(oos_overfit, is_scores)
    assert pbo_severe["pbo"] > 0.8


def test_cpcv_evaluator_end_to_end():
    np.random.seed(42)
    n_obs = 180
    dates = pd.date_range("2025-01-01", periods=n_obs, freq="B")

    # Features and returns
    f1 = np.random.normal(0, 1, n_obs)
    f2 = np.random.normal(0, 1, n_obs)
    X = pd.DataFrame({"f1": f1, "f2": f2}, index=dates)

    returns = pd.Series(0.01 * f1 + np.random.normal(0, 0.02, n_obs), index=dates)
    y = pd.Series(np.where(returns > 0, 1, 0), index=dates)

    models = {
        "ridge_model": RidgeClassifier(),
        "rf_model": RandomForestClassifier(n_estimators=10, max_depth=3, random_state=42),
    }

    evaluator = CPCVEvaluator(n_splits=4, n_test_splits=1, pct_embargo=0.01)
    res = evaluator.evaluate_model_family(models, X, y, returns)

    assert "summary_df" in res
    assert "pbo" in res
    assert "report_markdown" in res
    assert 0.0 <= res["pbo"] <= 1.0
    assert len(res["summary_df"]) == 2


def test_cpcv_splitter_and_dsr_pbo():
    np.random.seed(42)
    n_samples = 500
    n_strategies = 8

    # Returns simulation
    returns_matrix = np.random.normal(0.0004, 0.012, size=(n_samples, n_strategies))
    returns_matrix[:, 2] += 0.0005  # Strategy 2 has higher mean return

    # Test compute_sharpe_ratio
    sr_val = compute_sharpe_ratio(returns_matrix[:, 2])
    assert sr_val > 0.0

    # Test compute_deflated_sharpe_ratio
    dsr_val = compute_deflated_sharpe_ratio(returns_matrix[:, 2], n_trials=n_strategies)
    assert 0.0 <= dsr_val <= 1.0

    # Test CPCVSplitter
    cpcv = CPCVSplitter(n_groups=5, k_test_groups=2, purge_window=5, embargo_window=5)
    splits = list(cpcv.split(n_samples))
    assert len(splits) == 10  # C(5, 2) = 10

    is_sharpes = []
    oos_sharpes = []
    for train_idx, test_idx in splits:
        assert len(train_idx) > 0
        assert len(test_idx) > 0
        assert len(set(train_idx).intersection(set(test_idx))) == 0

        fold_is = [compute_sharpe_ratio(returns_matrix[train_idx, s]) for s in range(n_strategies)]
        fold_oos = [compute_sharpe_ratio(returns_matrix[test_idx, s]) for s in range(n_strategies)]
        is_sharpes.append(fold_is)
        oos_sharpes.append(fold_oos)

    # Test compute_pbo_from_cpcv
    pbo_val = compute_pbo_from_cpcv(np.array(is_sharpes), np.array(oos_sharpes))
    assert 0.0 <= pbo_val <= 1.0

