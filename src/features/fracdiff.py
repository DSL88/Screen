"""
Fixed-Width Window Fractional Differentiation (FFD) Module.

Based on Marcos López de Prado (Advances in Financial Machine Learning, Chapter 5).
Transforms financial time series to achieve statistical stationarity while
maximizing preservation of long-term memory (support/resistance, mean reversion).
"""

from __future__ import annotations

import warnings
warnings.filterwarnings("ignore", category=FutureWarning)

from typing import Union, Optional, Tuple, Dict, Any, List
import numpy as np
import pandas as pd
from statsmodels.tsa.stattools import adfuller

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt


def get_ffd_weights(d: float, thres: float = 1e-4, max_lags: int = 2000) -> np.ndarray:
    """
    Generate memory weights for Fixed-Width Window Fractional Differentiation (1 - B)^d.

    Formulation:
        w_0 = 1.0
        w_k = -w_{k-1} * (d - k + 1) / k

    Parameters
    ----------
    d : float
        Fractional differentiation order (typically 0.0 <= d <= 1.0).
    thres : float, default 1e-4
        Cut-off threshold for memory weight decay. Stops expanding window when |w_k| < thres.
    max_lags : int, default 2000
        Maximum lag length for practical computation.

    Returns
    -------
    np.ndarray
        Array of weights [w_K, w_{K-1}, ..., w_1, w_0] reversed and ready for convolution.
    """
    if d == 0.0:
        return np.array([1.0], dtype=np.float64)

    w: List[float] = [1.0]
    k = 1
    while k < max_lags:
        w_k = -w[-1] / k * (d - k + 1)
        if abs(w_k) < thres:
            break
        w.append(w_k)
        k += 1

    # Return in reversed order [w_K, ..., w_0] for standard valid convolution
    return np.array(w[::-1], dtype=np.float64)


def frac_diff_ffd(
    series: Union[pd.Series, pd.DataFrame],
    d: float,
    thres: float = 1e-4,
    use_log: bool = False
) -> Union[pd.Series, pd.DataFrame]:
    """
    Apply Fixed-Width Window Fractional Differentiation (FFD) to a price series via vectorized convolution.

    Parameters
    ----------
    series : pd.Series or pd.DataFrame
        Input price series or dataframe.
    d : float
        Differentiation degree. d=0 returns original, d=1 returns standard first difference.
    thres : float, default 1e-4
        Cut-off threshold for weights.
    use_log : bool, default False
        If True, takes np.log(series) prior to differentiation.

    Returns
    -------
    pd.Series or pd.DataFrame
        Fractionally differentiated stationary series aligned with input index.
    """
    if isinstance(series, pd.DataFrame):
        return series.apply(lambda col: frac_diff_ffd(col, d=d, thres=thres, use_log=use_log))

    if not isinstance(series, pd.Series):
        series = pd.Series(series)

    s = np.log(series) if use_log else series.copy()
    s = s.astype(np.float64)

    if d == 0.0:
        return s

    weights = get_ffd_weights(d=d, thres=thres)
    width = len(weights)
    n_obs = len(s)

    if width > n_obs:
        weights = get_ffd_weights(d=d, thres=thres, max_lags=max(2, n_obs // 2))
        width = len(weights)

    values = s.to_numpy(dtype=np.float64)
    res = np.full(n_obs, np.nan, dtype=np.float64)

    conv_valid = np.convolve(values, weights, mode="valid")
    res[width - 1 : width - 1 + len(conv_valid)] = conv_valid

    return pd.Series(res, index=s.index, name=s.name)


def find_optimal_d(
    series: pd.Series,
    d_range: Tuple[float, float] = (0.0, 1.0),
    step: float = 0.05,
    p_val_threshold: float = 0.05,
    thres: float = 1e-4,
    use_log: bool = True
) -> Dict[str, Any]:
    """
    Find minimum fractional differentiation order 'd' that rejects the Augmented
    Dickey-Fuller (ADF) null hypothesis of non-stationarity (p-value < p_val_threshold),
    maximizing long-term memory and correlation retention.

    Parameters
    ----------
    series : pd.Series
        Time series of asset prices.
    d_range : tuple of (float, float), default (0.0, 1.0)
        Search range [min_d, max_d].
    step : float, default 0.05
        Increment step for testing d.
    p_val_threshold : float, default 0.05
        Target p-value for ADF test.
    thres : float, default 1e-4
        FFD cut-off threshold.
    use_log : bool, default True
        Whether to log-transform prices.

    Returns
    -------
    Dict[str, Any]
        Dictionary containing optimal_d, optimal_p_value, optimal_correlation, results_df.
    """
    s = np.log(series.dropna()) if use_log else series.dropna()
    d_values = np.arange(d_range[0], d_range[1] + 1e-6, step)

    records = []
    optimal_d = None

    for d in d_values:
        d_round = round(float(d), 4)
        fd = frac_diff_ffd(s, d=d_round, thres=thres, use_log=False).dropna()

        if len(fd) < 20:
            continue

        try:
            adf_res = adfuller(fd, maxlag=1, autolag=None)
            adf_stat = float(adf_res[0])
            p_val = float(adf_res[1])
            lags = int(adf_res[2])
            n_obs = int(adf_res[3])
        except Exception:
            continue

        aligned_orig = s.loc[fd.index]
        corr = float(np.corrcoef(aligned_orig, fd)[0, 1]) if len(aligned_orig) > 1 else np.nan

        records.append({
            "d": d_round,
            "adf_stat": adf_stat,
            "p_val": p_val,
            "lags": lags,
            "n_obs": n_obs,
            "correlation": corr,
        })

        if optimal_d is None and p_val < p_val_threshold:
            optimal_d = d_round

    results_df = pd.DataFrame(records)
    if optimal_d is None and not results_df.empty:
        optimal_d = float(results_df.loc[results_df["p_val"].idxmin(), "d"])

    opt_row = results_df[results_df["d"] == optimal_d].iloc[0] if (not results_df.empty and optimal_d is not None) else None

    return {
        "optimal_d": optimal_d,
        "optimal_p_value": opt_row["p_val"] if opt_row is not None else np.nan,
        "optimal_correlation": opt_row["correlation"] if opt_row is not None else np.nan,
        "results_df": results_df,
    }


def plot_min_ffd(results_df: pd.DataFrame, save_path: Optional[str] = None) -> None:
    """
    Plot relationship between fractional order d, ADF p-value, and correlation preservation.

    Parameters
    ----------
    results_df : pd.DataFrame
        DataFrame returned from find_optimal_d['results_df'].
    save_path : str, optional
        File path to save the generated figure.
    """
    if results_df.empty:
        return

    fig, ax1 = plt.subplots(figsize=(10, 6))

    color = "tab:blue"
    ax1.set_xlabel("Differentiation Degree (d)", fontsize=12)
    ax1.set_ylabel("ADF p-value", color=color, fontsize=12)
    line1 = ax1.plot(results_df["d"], results_df["p_val"], color=color, marker="o", label="ADF p-value")
    ax1.axhline(0.05, color="red", linestyle="--", alpha=0.7, label="Stationarity Threshold (0.05)")
    ax1.tick_params(axis="y", labelcolor=color)
    ax1.grid(True, alpha=0.3)

    ax2 = ax1.twinx()
    color = "tab:green"
    ax2.set_ylabel("Correlation with Original Series", color=color, fontsize=12)
    line2 = ax2.plot(results_df["d"], results_df["correlation"], color=color, marker="s", label="Correlation")
    ax2.tick_params(axis="y", labelcolor=color)

    lines = line1 + line2 + [plt.Line2D([0], [0], color="red", linestyle="--", label="Threshold (0.05)")]
    labels = [l.get_label() for l in lines]
    ax1.legend(lines, labels, loc="center right")

    plt.title("Fractional Differentiation: Memory Preservation vs Stationarity (FFD)", fontsize=14, pad=15)
    fig.tight_layout()

    if save_path:
        plt.savefig(save_path, dpi=300, bbox_inches="tight")
    plt.close(fig)
