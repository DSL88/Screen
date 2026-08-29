"""
Quantitative Validation and Overfitting Diagnostics Package.

Provides:
- Combinatorial Purged Cross-Validation (CPCV)
- Deflated Sharpe Ratio (DSR) & Probabilistic Sharpe Ratio (PSR)
- Probability of Backtest Overfitting (PBO)
"""

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

__all__ = [
    "CombinatorialPurgedKFold",
    "probabilistic_sharpe_ratio",
    "deflated_sharpe_ratio",
    "compute_pbo",
    "CPCVEvaluator",
    "compute_sharpe_ratio",
    "compute_deflated_sharpe_ratio",
    "CPCVSplitter",
    "compute_pbo_from_cpcv",
]

