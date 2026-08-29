"""
Adaptive Technical Indicators and Market Microstructure (Dollar Bars) Module.

Provides:
1. McGinley Dynamic Indicator (vectorized NumPy engine).
2. Volatility-Adjusted Cross-Sectional Momentum Ranking.
3. Information-Driven Dollar Bars Sampling for high-frequency tick data.
"""

from __future__ import annotations

from typing import Union, Optional, Tuple, Sequence, Dict
import numpy as np
import pandas as pd


SeriesLike = Union[pd.Series, np.ndarray, Sequence[float]]


def mcginley_dynamic(
    prices: SeriesLike,
    n: int = 14,
    k: float = 0.6,
    initial_value: Optional[float] = None
) -> pd.Series:
    """
    Calculate McGinley Dynamic Indicator.

    Formulation:
        M_t = M_{t-1} + (P_t - M_{t-1}) / (k_adj * (P_t / M_{t-1})^4)
    where k_adj = k * n.

    Parameters
    ----------
    prices : SeriesLike
        Closing price series.
    n : int, default 14
        Smoothing window length.
    k : float, default 0.6
        Constant multiplier for speed adjustment.
    initial_value : float, optional
        Starting seed for M_0. If None, uses first valid price.

    Returns
    -------
    pd.Series
        McGinley Dynamic indicator series.
    """
    if isinstance(prices, pd.Series):
        s_index = prices.index
        s_name = prices.name or "mcginley_dynamic"
        p_arr = prices.to_numpy(dtype=np.float64)
    else:
        p_arr = np.asarray(prices, dtype=np.float64)
        s_index = pd.RangeIndex(len(p_arr))
        s_name = "mcginley_dynamic"

    length = len(p_arr)
    if length == 0:
        return pd.Series(dtype=np.float64, index=s_index, name=s_name)

    m = np.empty(length, dtype=np.float64)
    m.fill(np.nan)

    # Find first valid finite non-zero price
    start_idx = 0
    while start_idx < length and (np.isnan(p_arr[start_idx]) or p_arr[start_idx] <= 0):
        start_idx += 1

    if start_idx >= length:
        return pd.Series(m, index=s_index, name=s_name)

    if initial_value is not None and initial_value > 0:
        m[start_idx] = float(initial_value)
    else:
        m[start_idx] = p_arr[start_idx]

    k_adj = float(k * n)
    prev_m = m[start_idx]

    # High-speed continuous loop
    for t in range(start_idx + 1, length):
        p_t = p_arr[t]
        if np.isnan(p_t) or p_t <= 0 or prev_m <= 0:
            m[t] = prev_m
            continue

        ratio = p_t / prev_m
        ratio_4 = ratio * ratio * ratio * ratio
        denom = k_adj * ratio_4

        if denom == 0.0 or np.isnan(denom):
            curr_m = prev_m
        else:
            curr_m = prev_m + (p_t - prev_m) / denom

        m[t] = curr_m
        prev_m = curr_m

    return pd.Series(m, index=s_index, name=s_name)


def compute_volatility_adjusted_momentum(
    prices: pd.DataFrame,
    window: int = 21,
    vol_window: Optional[int] = None
) -> pd.DataFrame:
    """
    Calculate volatility-adjusted momentum for a panel of asset prices.
    Momentum = Return_window / Realized_Vol_vol_window

    Parameters
    ----------
    prices : pd.DataFrame
        DataFrame where columns are asset tickers and index is chronological timestamps.
    window : int, default 21
        Lookback horizon in trading days for returns.
    vol_window : int, optional
        Lookback horizon for realized daily volatility (default equal to window).

    Returns
    -------
    pd.DataFrame
        Volatility-adjusted momentum scores per asset.
    """
    if vol_window is None:
        vol_window = window

    returns = prices.pct_change(window)
    daily_returns = prices.pct_change(1)
    rolling_vol = daily_returns.rolling(window=vol_window, min_periods=max(5, vol_window // 2)).std() * np.sqrt(252)

    with np.errstate(divide="ignore", invalid="ignore"):
        vol_adj_mom = returns / rolling_vol
        vol_adj_mom = vol_adj_mom.replace([np.inf, -np.inf], np.nan)

    return vol_adj_mom


def compute_cross_sectional_ranks(
    prices: pd.DataFrame,
    windows: Tuple[int, ...] = (21, 63, 252),
    weights: Tuple[float, ...] = (0.2, 0.3, 0.5)
) -> Dict[str, pd.DataFrame]:
    """
    Compute cross-sectional percentile ranks (0.0 to 1.0) of volatility-adjusted momentum
    across 1M (21d), 3M (63d), and 12M (252d) horizons and composite rank.

    Parameters
    ----------
    prices : pd.DataFrame
        Asset price matrix with timestamps in index and tickers as columns.
    windows : tuple of int, default (21, 63, 252)
        Horizon windows for momentum.
    weights : tuple of float, default (0.2, 0.3, 0.5)
        Linear blending weights for composite percentile rank.

    Returns
    -------
    Dict[str, pd.DataFrame]
        Dictionary containing individual window ranks ('rank_21d', 'rank_63d', 'rank_252d')
        and the final 'composite_rank' DataFrame.
    """
    if len(windows) != len(weights):
        raise ValueError("Length of windows and weights must match.")

    norm_weights = np.array(weights) / np.sum(weights)
    ranks_dict: Dict[str, pd.DataFrame] = {}
    weighted_rank_sum: Optional[pd.DataFrame] = None

    for i, w in enumerate(windows):
        vol_adj_mom = compute_volatility_adjusted_momentum(prices, window=w)
        # Percentile rank across columns (cross-sectional at each timestamp t)
        # percentile=True ranks from 0.0 (lowest) to 1.0 (highest)
        p_rank = vol_adj_mom.rank(axis=1, pct=True, ascending=True)
        ranks_dict[f"rank_{w}d"] = p_rank

        weight = norm_weights[i]
        if weighted_rank_sum is None:
            weighted_rank_sum = p_rank.fillna(0.5) * weight
        else:
            weighted_rank_sum += p_rank.fillna(0.5) * weight

    # Re-normalize composite across universe at each timestamp
    if weighted_rank_sum is not None:
        ranks_dict["composite_rank"] = weighted_rank_sum.rank(axis=1, pct=True, ascending=True)
    
    return ranks_dict


def build_dollar_bars(
    df_ticks: pd.DataFrame,
    threshold: float,
    price_col: str = "price",
    volume_col: str = "volume",
    timestamp_col: str = "timestamp",
) -> pd.DataFrame:
    """
    Sample high-frequency transaction data into information-driven Dollar Bars.
    Aggregates ticks whenever cumulative dollar value (Price * Volume) reaches threshold.

    Parameters
    ----------
    df_ticks : pd.DataFrame
        Tick dataframe containing timestamp, price, and volume.
    threshold : float
        Fixed dollar amount required to generate a new bar (e.g., $1,000,000).
    price_col : str, default 'price'
        Name of price column.
    volume_col : str, default 'volume'
        Name of volume column.
    timestamp_col : str, default 'timestamp'
        Name of timestamp column.

    Returns
    -------
    pd.DataFrame
        OHLCV Dollar Bars DataFrame with columns:
        ['timestamp_start', 'timestamp_end', 'open', 'high', 'low', 'close',
         'volume', 'dollar_volume', 'vwap', 'tick_count'].
    """
    if threshold <= 0:
        raise ValueError("Dollar bar threshold must be strictly positive.")

    if df_ticks.empty:
        cols = [
            "timestamp_start", "timestamp_end", "open", "high", "low", "close",
            "volume", "dollar_volume", "vwap", "tick_count"
        ]
        return pd.DataFrame(columns=cols)

    prices = df_ticks[price_col].to_numpy(dtype=np.float64)
    volumes = df_ticks[volume_col].to_numpy(dtype=np.float64)
    timestamps = df_ticks[timestamp_col].to_numpy()

    n_ticks = len(prices)
    dollar_values = prices * volumes

    bars = []
    
    # State accumulators for current bar
    cum_dollar = 0.0
    cum_volume = 0.0
    cum_ticks = 0
    bar_open = prices[0]
    bar_high = prices[0]
    bar_low = prices[0]
    start_ts = timestamps[0]

    for i in range(n_ticks):
        p = prices[i]
        v = volumes[i]
        dv = dollar_values[i]
        ts = timestamps[i]

        if cum_ticks == 0:
            bar_open = p
            bar_high = p
            bar_low = p
            start_ts = ts

        bar_high = max(bar_high, p)
        bar_low = min(bar_low, p)
        cum_volume += v
        cum_dollar += dv
        cum_ticks += 1

        if cum_dollar >= threshold:
            bar_close = p
            vwap = cum_dollar / cum_volume if cum_volume > 0 else bar_close
            bars.append({
                "timestamp_start": start_ts,
                "timestamp_end": ts,
                "open": bar_open,
                "high": bar_high,
                "low": bar_low,
                "close": bar_close,
                "volume": cum_volume,
                "dollar_volume": cum_dollar,
                "vwap": vwap,
                "tick_count": cum_ticks,
            })
            # Reset bar accumulators
            cum_dollar = 0.0
            cum_volume = 0.0
            cum_ticks = 0

    # If residual ticks remain and no bars created, or user wants remaining ticks recorded
    if cum_ticks > 0 and len(bars) == 0:
        bar_close = prices[-1]
        vwap = cum_dollar / cum_volume if cum_volume > 0 else bar_close
        bars.append({
            "timestamp_start": start_ts,
            "timestamp_end": timestamps[-1],
            "open": bar_open,
            "high": bar_high,
            "low": bar_low,
            "close": bar_close,
            "volume": cum_volume,
            "dollar_volume": cum_dollar,
            "vwap": vwap,
            "tick_count": cum_ticks,
        })

    return pd.DataFrame(bars)
