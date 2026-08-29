"""
Adaptive Technical Indicators and Market Microstructure (Dollar Bars) Module.

Provides:
1. McGinley Dynamic Indicator (compiled via Numba for high-speed tracking).
2. Volatility-Adjusted Cross-Sectional Momentum Ranking (Percentile Rank across 1M, 3M, 12M).
3. Information-Driven Dollar Bars Sampling for high-frequency tick data.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Sequence, Tuple, Union
import numpy as np
import pandas as pd

try:
    from numba import jit
except ImportError:
    # Fallback decorator if numba is not installed
    def jit(*args, **kwargs):
        def decorator(func):
            return func
        return decorator


@jit(nopython=True)
def _mcginley_dynamic_numba(prices: np.ndarray, period: int = 14, k: float = 0.6) -> np.ndarray:
    """Implementação compilada via Numba para cálculo acelerado do McGinley Dynamic."""
    n = len(prices)
    mg = np.zeros(n, dtype=np.float64)
    if n == 0:
        return mg
    
    # Find first valid finite non-zero price
    start_idx = 0
    while start_idx < n and (np.isnan(prices[start_idx]) or prices[start_idx] <= 0):
        mg[start_idx] = np.nan
        start_idx += 1

    if start_idx >= n:
        return mg

    mg[start_idx] = prices[start_idx]
    k_adj = float(k * period)

    for t in range(start_idx + 1, n):
        prev = mg[t - 1]
        p_t = prices[t]
        if np.isnan(p_t) or p_t <= 0 or prev <= 0 or np.isnan(prev):
            mg[t] = prev if not np.isnan(prev) else (p_t if not np.isnan(p_t) else 0.0)
        else:
            ratio = p_t / prev
            denom = k_adj * (ratio ** 4)
            if denom == 0.0 or np.isnan(denom):
                mg[t] = prev
            else:
                mg[t] = prev + (p_t - prev) / denom
    return mg


def compute_mcginley_dynamic(
    series: Union[pd.Series, np.ndarray, Sequence[float]],
    period: int = 14,
    k: float = 0.6,
    initial_value: Optional[float] = None
) -> pd.Series:
    """
    Interface Pandas para a função McGinley Dynamic.
    
    Formulação:
        M_t = M_{t-1} + (P_t - M_{t-1}) / (k * N * (P_t / M_{t-1})^4)
    """
    if isinstance(series, pd.Series):
        s_index = series.index
        s_name = series.name or f"mcginley_{period}"
        prices = series.to_numpy(dtype=np.float64)
    else:
        prices = np.asarray(series, dtype=np.float64)
        s_index = pd.RangeIndex(len(prices))
        s_name = f"mcginley_{period}"

    if len(prices) == 0:
        return pd.Series(dtype=np.float64, index=s_index, name=s_name)

    mg_values = _mcginley_dynamic_numba(prices, period, k)

    if initial_value is not None and initial_value > 0 and len(mg_values) > 0:
        for idx in range(len(mg_values)):
            if not np.isnan(mg_values[idx]):
                mg_values[idx] = float(initial_value)
                break
        mg_values = _mcginley_dynamic_numba(prices, period, k)

    return pd.Series(mg_values, index=s_index, name=s_name)


# Alias for backward compatibility
def mcginley_dynamic(
    prices: Union[pd.Series, np.ndarray, Sequence[float]],
    n: int = 14,
    k: float = 0.6,
    initial_value: Optional[float] = None
) -> pd.Series:
    """Alias para compute_mcginley_dynamic com suporte a parâmetro n."""
    return compute_mcginley_dynamic(prices, period=n, k=k, initial_value=initial_value)


def compute_volatility_adjusted_momentum(
    prices: pd.DataFrame,
    window: int = 21,
    vol_window: Optional[int] = None
) -> pd.DataFrame:
    r"""
    Calcula o Momentum ajustado à volatilidade:
        R_{i,t}^{(\tau)} / \sigma_{i,t}^{(\tau)}
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


def compute_cross_sectional_momentum(
    df_prices: pd.DataFrame,
    windows: Optional[Dict[str, int]] = None
) -> pd.DataFrame:
    """
    Calcula o Momentum ajustado à volatilidade e gera a ordenação cross-sectional (Percentile Rank).
    df_prices: DataFrame indexado por data, com colunas representando Tickers.
    """
    if windows is None:
        windows = {'1M': 21, '3M': 63, '12M': 252}

    ranks_df = pd.DataFrame(index=df_prices.index)

    for name, window in windows.items():
        returns = df_prices.pct_change(window)
        volatility = df_prices.pct_change().rolling(window).std() * np.sqrt(252)

        # Evitar divisão por zero ou volatilidade nula
        risk_adjusted_mom = np.where(volatility > 0, returns / volatility, np.nan)
        risk_adj_df = pd.DataFrame(risk_adjusted_mom, index=df_prices.index, columns=df_prices.columns)

        # Ranking Percentil Cross-Sectional por linha (ponto no tempo t)
        ranked = risk_adj_df.rank(axis=1, pct=True)

        for col in df_prices.columns:
            ranks_df[f'mom_rank_{name}_{col}'] = ranked[col]

    return ranks_df


def compute_cross_sectional_ranks(
    prices: pd.DataFrame,
    windows: Tuple[int, ...] = (21, 63, 252),
    weights: Tuple[float, ...] = (0.2, 0.3, 0.5)
) -> Dict[str, pd.DataFrame]:
    """
    Compute cross-sectional percentile ranks (0.0 to 1.0) across multiple windows and composite rank.
    """
    if len(windows) != len(weights):
        raise ValueError("Length of windows and weights must match.")

    norm_weights = np.array(weights) / np.sum(weights)
    ranks_dict: Dict[str, pd.DataFrame] = {}
    weighted_rank_sum: Optional[pd.DataFrame] = None

    for i, w in enumerate(windows):
        vol_adj_mom = compute_volatility_adjusted_momentum(prices, window=w)
        p_rank = vol_adj_mom.rank(axis=1, pct=True, ascending=True)
        ranks_dict[f"rank_{w}d"] = p_rank

        weight = norm_weights[i]
        if weighted_rank_sum is None:
            weighted_rank_sum = p_rank.fillna(0.5) * weight
        else:
            weighted_rank_sum += p_rank.fillna(0.5) * weight

    if weighted_rank_sum is not None:
        ranks_dict["composite_rank"] = weighted_rank_sum.rank(axis=1, pct=True, ascending=True)

    return ranks_dict


def build_dollar_bars(
    df_ticks: pd.DataFrame,
    threshold: float,
    price_col: str = "price",
    volume_col: str = "volume",
    timestamp_col: str = "timestamp"
) -> pd.DataFrame:
    """
    Agrupa ticks temporais em Dollar Bars (Barras de Valor).
    df_ticks deve possuir as colunas: ['timestamp', 'price', 'volume'] (ou especificadas via parâmetros).
    """
    if threshold <= 0:
        raise ValueError("Dollar bar threshold must be strictly positive.")

    cols = [
        "timestamp", "timestamp_start", "timestamp_end", "open", "high", "low", "close",
        "volume", "dollar_volume", "vwap", "tick_count"
    ]
    if df_ticks.empty:
        return pd.DataFrame(columns=cols)

    df = df_ticks.copy()
    df["dollar_value"] = df[price_col] * df[volume_col]
    df["cum_dollar_value"] = df["dollar_value"].cumsum()

    # Identificador do grupo de barras com base no threshold
    df["bar_id"] = (df["cum_dollar_value"] // threshold).astype(int)

    # Aggregations
    bars = df.groupby("bar_id").agg(
        timestamp=(timestamp_col, "last"),
        timestamp_start=(timestamp_col, "first"),
        timestamp_end=(timestamp_col, "last"),
        open=(price_col, "first"),
        high=(price_col, "max"),
        low=(price_col, "min"),
        close=(price_col, "last"),
        volume=(volume_col, "sum"),
        dollar_volume=("dollar_value", "sum"),
        tick_count=(price_col, "count")
    ).reset_index(drop=True)

    bars["vwap"] = np.where(bars["volume"] > 0, bars["dollar_volume"] / bars["volume"], bars["close"])

    return bars
