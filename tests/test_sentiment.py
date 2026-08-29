import pytest
import numpy as np
import pandas as pd

from src.features.sentiment import (
    FinBERTSentimentAnalyzer,
    FinBertSentimentExtractor,
    compute_sentiment_divergence,
)


def test_finbert_sentiment_analyzer_predict_headlines():
    analyzer = FinBERTSentimentAnalyzer(use_fallback=True)
    headlines = [
        "Company reports record quarterly profit and surges 15%",
        "CEO resigns amid major fraud lawsuit and default warning",
        "Market remains steady ahead of central bank rate announcement",
    ]
    scores = analyzer.predict_headlines(headlines)
    assert len(scores) == len(headlines)
    assert scores[0] > 0  # positive headline
    assert scores[1] < 0  # negative headline


def test_finbert_sentiment_extractor_batch():
    extractor = FinBertSentimentExtractor(use_fallback=True)
    headlines = [
        "Company reports record quarterly profit and surges 15%",
        "CEO resigns amid major fraud lawsuit and default warning",
        "Market remains steady ahead of central bank rate announcement",
        None,
        "",
    ]

    res = extractor.predict_sentiment_batch(headlines)

    assert len(res) == len(headlines)
    assert "prob_positive" in res.columns
    assert "prob_negative" in res.columns
    assert "sentiment_score" in res.columns

    # First headline must be positive
    assert res.iloc[0]["sentiment_score"] > 0
    # Second headline must be negative
    assert res.iloc[1]["sentiment_score"] < 0
    # Empty/neutral
    assert -1.0 <= res.iloc[2]["sentiment_score"] <= 1.0


def test_compute_sentiment_divergence_dataframe():
    dates = pd.date_range(start="2024-01-01", periods=10, freq="B")
    df_sim_prices = pd.DataFrame({
        'AAPL': 150 + np.cumsum([0.5, 0.2, -0.1, 0.4, 0.8, 1.2, 0.1, -0.3, 0.5, 0.9]),
        'MSFT': 300 + np.cumsum([-1.0, -0.5, -2.0, -1.5, -0.8, -1.2, -0.5, -1.0, -0.2, -0.4]),
        'GOOGL': 120 + np.cumsum([1.5, 2.0, 1.8, 2.5, 3.0, 1.2, 0.8, 2.1, 1.5, 1.9])
    }, index=dates)

    df_sim_sentiment = pd.DataFrame({
        'AAPL': [0.2, 0.3, 0.1, 0.4, 0.5, 0.7, 0.8, 0.6, 0.7, 0.85],
        'MSFT': [-0.1, -0.2, -0.5, -0.4, -0.6, -0.7, -0.8, -0.6, -0.7, -0.72],
        'GOOGL': [-0.2, -0.4, -0.5, -0.3, -0.6, -0.7, -0.8, -0.5, -0.6, -0.60]
    }, index=dates)

    df_div = compute_sentiment_divergence(df_sim_prices, df_sim_sentiment, window=5)
    assert df_div.shape == df_sim_prices.shape
    assert 'GOOGL' in df_div.columns
    assert 'AAPL' in df_div.columns
    assert 'MSFT' in df_div.columns
    assert np.isfinite(df_div.iloc[-1]).all()


def test_compute_sentiment_divergence_series():
    dates = pd.date_range("2026-01-01", periods=20, freq="B")
    
    # Flat price then sharp drop on day 10
    prices = [100.0] * 20
    prices[10] = 90.0  # Sharp price drop -> negative return
    price_series = pd.Series(prices, index=dates)

    # Flat sentiment then huge positive surge on day 10
    sentiments = [0.0] * 20
    sentiments[10] = 0.9  # Positive sentiment
    sentiment_series = pd.Series(sentiments, index=dates)

    df_div = compute_sentiment_divergence(
        price_series=price_series,
        sentiment_series=sentiment_series,
        window=5,
        threshold=2.0
    )

    assert not df_div.empty
    assert "divergence" in df_div.columns
    assert "signal" in df_div.columns

    # On day 10, sentiment is high positive Z-score and price return is large negative Z-score
    assert df_div["divergence"].iloc[10] > 1.5
    assert df_div["signal"].iloc[10] == 1
