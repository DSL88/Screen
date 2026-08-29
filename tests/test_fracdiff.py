import pytest
import numpy as np
import pandas as pd
import tempfile
import os

from src.features.fracdiff import (
    get_ffd_weights,
    frac_diff_ffd,
    find_optimal_d,
    plot_min_ffd,
)


def test_get_ffd_weights():
    # d = 1.0 corresponds to standard difference: (1 - B)^1 -> weights [-1, 1]
    w1 = get_ffd_weights(d=1.0, thres=1e-4)
    assert len(w1) == 2
    assert w1[-1] == 1.0
    assert w1[0] == -1.0

    # d = 0.0 corresponds to no difference: weights [1.0]
    w0 = get_ffd_weights(d=0.0)
    assert len(w0) == 1
    assert w0[0] == 1.0

    # Fractional d: 0.5
    w_frac = get_ffd_weights(d=0.5, thres=1e-3)
    assert len(w_frac) > 2
    assert w_frac[-1] == 1.0


def test_frac_diff_ffd():
    np.random.seed(42)
    # Random walk price series
    steps = np.random.normal(0, 1, size=200)
    prices = pd.Series(100.0 + np.cumsum(steps), name="price")

    # d = 0 should return the series
    fd_0 = frac_diff_ffd(prices, d=0.0)
    pd.testing.assert_series_equal(fd_0, prices)

    # d = 0.4
    fd_04 = frac_diff_ffd(prices, d=0.4, thres=1e-3)
    assert len(fd_04) == len(prices)
    # First few observations must be NaN due to fixed window width
    valid_fd = fd_04.dropna()
    assert len(valid_fd) > 0
    assert not valid_fd.isna().any()


def test_find_optimal_d_and_plot():
    np.random.seed(42)
    # Generate non-stationary random walk
    rets = np.random.normal(0.0005, 0.01, size=400)
    prices = pd.Series(np.exp(np.cumsum(rets)) * 100.0, name="price")

    opt = find_optimal_d(prices, d_range=(0.0, 1.0), step=0.1, p_val_threshold=0.05, thres=1e-3)

    assert "optimal_d" in opt
    assert "optimal_p_value" in opt
    assert "results_df" in opt
    assert isinstance(opt["results_df"], pd.DataFrame)

    results_df = opt["results_df"]
    assert not results_df.empty
    assert "d" in results_df.columns
    assert "p_val" in results_df.columns
    assert "correlation" in results_df.columns

    # Check that as d increases, p_value decreases toward stationarity
    assert opt["optimal_d"] is not None
    assert 0.0 <= opt["optimal_d"] <= 1.0

    # Test plot utility
    with tempfile.TemporaryDirectory() as tmpdir:
        chart_path = os.path.join(tmpdir, "ffd_test.png")
        plot_min_ffd(results_df, save_path=chart_path)
        assert os.path.exists(chart_path)
