"""
Quantitative Feature Engineering Package.
Institutional modules for fundamentals, adaptive technical indicators, fractional differentiation,
FinBERT sentiment, and feature purification.
"""

from src.features.fundamentals import (
    FundamentalScreener,
    calculate_current_ratio,
    calculate_debt_to_equity,
    calculate_earnings_yield,
    calculate_price_to_book,
    calculate_roa,
    calculate_fcf_yield,
    calculate_net_income_growth_5y,
)
from src.features.technical import (
    compute_mcginley_dynamic,
    mcginley_dynamic,
    compute_volatility_adjusted_momentum,
    compute_cross_sectional_momentum,
    compute_cross_sectional_ranks,
    build_dollar_bars,
)
from src.features.sentiment import (
    FinBERTSentimentAnalyzer,
    FinBertSentimentExtractor,
    compute_sentiment_divergence,
)
from src.features.purification import (
    neutralize_feature_two_stage,
    compute_vif_dataframe,
    FeaturePurifier,
    compute_vif,
    select_informative_features,
    neutralize_factors,
)

__all__ = [
    "FundamentalScreener",
    "calculate_current_ratio",
    "calculate_debt_to_equity",
    "calculate_earnings_yield",
    "calculate_price_to_book",
    "calculate_roa",
    "calculate_fcf_yield",
    "calculate_net_income_growth_5y",
    "compute_mcginley_dynamic",
    "mcginley_dynamic",
    "compute_volatility_adjusted_momentum",
    "compute_cross_sectional_momentum",
    "compute_cross_sectional_ranks",
    "build_dollar_bars",
    "FinBERTSentimentAnalyzer",
    "FinBertSentimentExtractor",
    "compute_sentiment_divergence",
    "neutralize_feature_two_stage",
    "compute_vif_dataframe",
    "FeaturePurifier",
    "compute_vif",
    "select_informative_features",
    "neutralize_factors",
]

