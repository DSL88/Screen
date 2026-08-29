"""
Alternative Data & News Sentiment Module (FinBERT & Price-Sentiment Divergence).

Provides:
1. FinBertSentimentExtractor for batch NLP inference (ProsusAI/finbert).
2. Price-Sentiment Divergence metric calculation with statistical Z-scores and regime signals.
"""

from __future__ import annotations

import logging
from typing import List, Union, Optional, Dict, Any, Sequence
import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)


class FinBertSentimentExtractor:
    """
    Financial sentiment extraction engine using HuggingFace ProsusAI/finbert.
    Extracts continuous sentiment score: S_news = Prob(Positive) - Prob(Negative) in [-1.0, +1.0].
    """

    def __init__(
        self,
        model_name: str = "ProsusAI/finbert",
        device: Optional[str] = None,
        batch_size: int = 32,
        use_fallback: bool = True
    ) -> None:
        """
        Initialize the FinBERT Sentiment Extractor.

        Parameters
        ----------
        model_name : str, default 'ProsusAI/finbert'
            HuggingFace model identifier.
        device : str, optional
            Computation device ('cuda', 'mps', or 'cpu'). If None, automatically selects best available.
        batch_size : int, default 32
            Batch size for model inference.
        use_fallback : bool, default True
            If True, uses a robust rule-based financial lexicon fallback if transformers is not installed
            or weights cannot be downloaded.
        """
        self.model_name = model_name
        self.batch_size = batch_size
        self.use_fallback = use_fallback
        self.pipeline = None
        self.device = device
        self._is_hf_ready = False

        self._initialize_pipeline()

    def _select_device(self) -> str:
        if self.device:
            return self.device
        try:
            import torch
            if torch.cuda.is_available():
                return "cuda"
            if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
                return "mps"
        except ImportError:
            pass
        return "cpu"

    def _initialize_pipeline(self) -> None:
        """Attempt to load HuggingFace Transformers pipeline."""
        try:
            from transformers import AutoTokenizer, AutoModelForSequenceClassification, pipeline
            import torch

            dev = self._select_device()
            device_id = 0 if dev == "cuda" else (-1 if dev == "cpu" else "mps")
            
            logger.info("Loading FinBERT model %s on %s...", self.model_name, dev)
            tokenizer = AutoTokenizer.from_pretrained(self.model_name)
            model = AutoModelForSequenceClassification.from_pretrained(self.model_name)
            
            self.pipeline = pipeline(
                "sentiment-analysis",
                model=model,
                tokenizer=tokenizer,
                device=device_id if isinstance(device_id, int) else None,
                top_k=None,  # Return probabilities for all 3 classes (positive, negative, neutral)
            )
            self._is_hf_ready = True
            logger.info("FinBERT pipeline successfully initialized.")
        except Exception as e:
            logger.warning("Could not initialize HuggingFace FinBERT pipeline (%s). Fallback enabled: %s", e, self.use_fallback)
            self._is_hf_ready = False

    def _fallback_sentiment(self, text: str) -> Dict[str, float]:
        """Lexical financial heuristic for offline/lightweight environments."""
        if not text or not isinstance(text, str):
            return {"positive": 0.0, "negative": 0.0, "neutral": 1.0, "score": 0.0}

        text_lower = text.lower()
        pos_words = {
            "surge", "surged", "gain", "gains", "profit", "profits", "bullish", "growth",
            "beat", "beats", "record", "rally", "upgrade", "upgraded", "dividend", "revenue up"
        }
        neg_words = {
            "plunge", "plunged", "loss", "losses", "bearish", "miss", "misses", "drop",
            "drops", "slump", "fraud", "downgrade", "downgraded", "debt", "lawsuit", "default", "warning"
        }

        pos_count = sum(1 for w in pos_words if w in text_lower)
        neg_count = sum(1 for w in neg_words if w in text_lower)
        total = pos_count + neg_count

        if total == 0:
            return {"positive": 0.1, "negative": 0.1, "neutral": 0.8, "score": 0.0}

        p_pos = (pos_count + 0.1) / (total + 1.0)
        p_neg = (neg_count + 0.1) / (total + 1.0)
        p_neu = max(0.0, 1.0 - p_pos - p_neg)
        score = float(p_pos - p_neg)

        return {"positive": p_pos, "negative": p_neg, "neutral": p_neu, "score": score}

    def predict_sentiment_batch(self, texts: Sequence[str]) -> pd.DataFrame:
        """
        Process a list/sequence of news headlines and return probabilities and continuous score.

        Parameters
        ----------
        texts : Sequence[str]
            List of headline/article texts.

        Returns
        -------
        pd.DataFrame
            DataFrame with columns ['text', 'prob_positive', 'prob_negative', 'prob_neutral', 'sentiment_score'].
        """
        if not texts:
            return pd.DataFrame(columns=["text", "prob_positive", "prob_negative", "prob_neutral", "sentiment_score"])

        cleaned_texts = [str(t) if pd.notna(t) else "" for t in texts]
        results = []

        if self._is_hf_ready and self.pipeline is not None:
            try:
                for i in range(0, len(cleaned_texts), self.batch_size):
                    batch = cleaned_texts[i : i + self.batch_size]
                    raw_outputs = self.pipeline(batch)

                    for text_item, out in zip(batch, raw_outputs):
                        # out is a list of dicts: [{'label': 'positive', 'score': 0.9}, ...]
                        prob_map = {item["label"].lower(): float(item["score"]) for item in out}
                        p_pos = prob_map.get("positive", 0.0)
                        p_neg = prob_map.get("negative", 0.0)
                        p_neu = prob_map.get("neutral", 0.0)
                        score = p_pos - p_neg
                        results.append({
                            "text": text_item,
                            "prob_positive": p_pos,
                            "prob_negative": p_neg,
                            "prob_neutral": p_neu,
                            "sentiment_score": score,
                        })
                return pd.DataFrame(results)
            except Exception as e:
                logger.error("Error during HuggingFace FinBERT batch inference: %s. Reverting to fallback.", e)

        # Fallback branch
        for text_item in cleaned_texts:
            fb = self._fallback_sentiment(text_item)
            results.append({
                "text": text_item,
                "prob_positive": fb["positive"],
                "prob_negative": fb["negative"],
                "prob_neutral": fb["neutral"],
                "sentiment_score": fb["score"],
            })

        return pd.DataFrame(results)


def compute_sentiment_divergence(
    price_series: pd.Series,
    sentiment_series: pd.Series,
    window: int = 5,
    threshold: float = 2.0,
) -> pd.DataFrame:
    """
    Compute Price-Sentiment Divergence metric.

    Standardizes (rolling Z-score over `window` days) both asset price returns and daily sentiment score:
        Divergence_t = Z(Sentiment_t) - Z(Price_Return_t)

    Generates signals:
        +1 (Bullish Divergence): Sentiment significantly positive while price lagged (Divergence >= +threshold)
        -1 (Bearish Divergence): Sentiment significantly negative while price remained high (Divergence <= -threshold)
         0 (Neutral)

    Parameters
    ----------
    price_series : pd.Series
        Asset close prices indexed chronologically.
    sentiment_series : pd.Series
        Daily aggregated sentiment score (in range [-1.0, +1.0]) aligned with price index.
    window : int, default 5
        Lookback window in days for rolling mean and standard deviation.
    threshold : float, default 2.0
        Z-score threshold for divergence anomaly detection.

    Returns
    -------
    pd.DataFrame
        DataFrame with columns:
        ['price', 'sentiment', 'price_return', 'price_zscore', 'sentiment_zscore', 'divergence', 'signal']
    """
    # Align series on common index
    df = pd.DataFrame({
        "price": price_series.astype(float),
        "sentiment": sentiment_series.astype(float),
    }).dropna()

    if df.empty or len(df) < window:
        empty_cols = ["price", "sentiment", "price_return", "price_zscore", "sentiment_zscore", "divergence", "signal"]
        return pd.DataFrame(columns=empty_cols, index=df.index)

    # 1. Price Return
    df["price_return"] = df["price"].pct_change()

    # 2. Rolling Z-scores
    ret_mean = df["price_return"].rolling(window=window, min_periods=max(2, window // 2)).mean()
    ret_std = df["price_return"].rolling(window=window, min_periods=max(2, window // 2)).std()

    sent_mean = df["sentiment"].rolling(window=window, min_periods=max(2, window // 2)).mean()
    sent_std = df["sentiment"].rolling(window=window, min_periods=max(2, window // 2)).std()

    # Safe Z-score calculation
    with np.errstate(divide="ignore", invalid="ignore"):
        df["price_zscore"] = (df["price_return"] - ret_mean) / ret_std.replace(0.0, np.nan)
        df["sentiment_zscore"] = (df["sentiment"] - sent_mean) / sent_std.replace(0.0, np.nan)

    df["price_zscore"] = df["price_zscore"].fillna(0.0)
    df["sentiment_zscore"] = df["sentiment_zscore"].fillna(0.0)

    # 3. Divergence Metric: Z(Sentiment) - Z(Price_Return)
    df["divergence"] = df["sentiment_zscore"] - df["price_zscore"]

    # 4. Signals
    df["signal"] = 0
    df.loc[df["divergence"] >= threshold, "signal"] = 1   # Bullish divergence
    df.loc[df["divergence"] <= -threshold, "signal"] = -1  # Bearish divergence

    return df
