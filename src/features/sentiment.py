"""
Alternative Data & News Sentiment Module (FinBERT & Price-Sentiment Divergence).

Provides:
1. FinBERTSentimentAnalyzer for batch NLP inference using HuggingFace ProsusAI/finbert.
2. Price-Sentiment Divergence metric calculation with rolling statistical Z-scores.
"""

from __future__ import annotations

import logging
from typing import Dict, List, Optional, Sequence, Union
import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)


class FinBERTSentimentAnalyzer:
    """
    Classe para extração de sentimento financeiro utilizando o modelo FinBERT (ProsusAI/finbert).
    Score de sentimento contínuo: S_news = P(positivo) - P(negativo) no intervalo [-1.0, +1.0].
    """

    def __init__(
        self,
        model_name: str = "ProsusAI/finbert",
        device: Optional[str] = None,
        use_fallback: bool = True
    ) -> None:
        self.model_name = model_name
        self.use_fallback = use_fallback
        self.tokenizer = None
        self.model = None
        self._is_hf_ready = False

        if device is None:
            try:
                import torch
                self.device = "cuda" if torch.cuda.is_available() else ("mps" if hasattr(torch.backends, "mps") and torch.backends.mps.is_available() else "cpu")
            except Exception:
                self.device = "cpu"
        else:
            self.device = device

        self._initialize_model()

    def _initialize_model(self) -> None:
        """Carrega o modelo e tokenizador da HuggingFace."""
        try:
            from transformers import AutoTokenizer, AutoModelForSequenceClassification
            import torch

            logger.info("A carregar modelo FinBERT %s no dispositivo %s...", self.model_name, self.device)
            self.tokenizer = AutoTokenizer.from_pretrained(self.model_name)
            self.model = AutoModelForSequenceClassification.from_pretrained(self.model_name).to(self.device)
            self.model.eval()
            self._is_hf_ready = True
            logger.info("Modelo FinBERT inicializado com sucesso.")
        except Exception as e:
            logger.warning("Não foi possível carregar o modelo HuggingFace FinBERT (%s). Fallback ativo: %s", e, self.use_fallback)
            self._is_hf_ready = False

    def _fallback_score(self, text: str) -> float:
        """Heurística léxica financeira para ambientes sem download de pesos."""
        if not text or not isinstance(text, str):
            return 0.0
        text_lower = text.lower()
        pos_words = {
            "surge", "surged", "gain", "gains", "profit", "profits", "bullish", "growth",
            "beat", "beats", "record", "rally", "upgrade", "upgraded", "dividend", "revenue up", "strong buy"
        }
        neg_words = {
            "plunge", "plunged", "loss", "losses", "bearish", "miss", "misses", "drop",
            "drops", "slump", "fraud", "downgrade", "downgraded", "debt", "lawsuit", "default", "warning", "antitrust"
        }
        pos_count = sum(1 for w in pos_words if w in text_lower)
        neg_count = sum(1 for w in neg_words if w in text_lower)
        total = pos_count + neg_count
        if total == 0:
            return 0.0
        p_pos = (pos_count + 0.1) / (total + 1.0)
        p_neg = (neg_count + 0.1) / (total + 1.0)
        return float(p_pos - p_neg)

    def predict_headlines(self, headlines: List[str], batch_size: int = 16) -> np.ndarray:
        """
        Processa uma lista de manchetes em lotes e retorna o score contínuo [-1, 1].
        Score = Prob(Positivo) - Prob(Negativo)
        """
        if not headlines:
            return np.array([], dtype=np.float64)

        cleaned_headlines = [str(h) if pd.notna(h) else "" for h in headlines]

        if self._is_hf_ready and self.model is not None and self.tokenizer is not None:
            try:
                import torch
                scores = []
                for i in range(0, len(cleaned_headlines), batch_size):
                    batch = cleaned_headlines[i:i + batch_size]
                    inputs = self.tokenizer(
                        batch, padding=True, truncation=True, max_length=128, return_tensors="pt"
                    ).to(self.device)

                    with torch.no_grad():
                        outputs = self.model(**inputs)
                        probs = torch.nn.functional.softmax(outputs.logits, dim=-1).cpu().numpy()

                    # Estrutura do FinBERT: [positivo, negativo, neutro]
                    # Score = Prob(Positivo) - Prob(Negativo)
                    batch_scores = probs[:, 0] - probs[:, 1]
                    scores.extend(batch_scores)

                return np.array(scores, dtype=np.float64)
            except Exception as e:
                logger.error("Erro durante inferência FinBERT: %s. A usar fallback.", e)

        # Fallback
        return np.array([self._fallback_score(h) for h in cleaned_headlines], dtype=np.float64)

    def predict_sentiment_batch(self, texts: Sequence[str]) -> pd.DataFrame:
        """
        Processa manchetes e retorna DataFrame com probabilidades e score contínuo.
        """
        if not texts:
            return pd.DataFrame(columns=["text", "prob_positive", "prob_negative", "prob_neutral", "sentiment_score"])

        cleaned = [str(t) if pd.notna(t) else "" for t in texts]
        scores = self.predict_headlines(cleaned)

        results = []
        for text_item, score in zip(cleaned, scores):
            p_pos = max(0.0, score)
            p_neg = max(0.0, -score)
            p_neu = max(0.0, 1.0 - p_pos - p_neg)
            results.append({
                "text": text_item,
                "prob_positive": p_pos,
                "prob_negative": p_neg,
                "prob_neutral": p_neu,
                "sentiment_score": score,
            })
        return pd.DataFrame(results)


# Alias for backward compatibility
FinBertSentimentExtractor = FinBERTSentimentAnalyzer


def compute_sentiment_divergence(
    df_prices: Union[pd.DataFrame, pd.Series] = None,
    df_sentiment: Union[pd.DataFrame, pd.Series] = None,
    window: int = 5,
    threshold: float = 2.0,
    price_series: Optional[pd.Series] = None,
    sentiment_series: Optional[pd.Series] = None
) -> pd.DataFrame:
    r"""
    Calcula os Z-scores de retorno de preço e sentimento diário, gerando a métrica de divergência:
        Z(S_t) = (S_t - \mu_{S,5d}) / \sigma_{S,5d}
        Z(R_t) = (R_t - \mu_{R,5d}) / \sigma_{R,5d}
        D_t = Z(S_t) - Z(R_t)

    Suporta entrada de Painel (DataFrames com colunas de tickers) ou Séries Temporais individuais.
    """
    # Suporte para parâmetros nomeados legados
    if price_series is not None:
        df_prices = price_series
    if sentiment_series is not None:
        df_sentiment = sentiment_series

    if df_prices is None or df_sentiment is None:
        raise ValueError("df_prices e df_sentiment são obrigatórios.")

    # Caso 1: Entrada como pd.Series (análise detalhada de ativo único)
    if isinstance(df_prices, pd.Series) and isinstance(df_sentiment, pd.Series):
        df = pd.DataFrame({
            "price": df_prices.astype(float),
            "sentiment": df_sentiment.astype(float),
        }).dropna()

        if df.empty or len(df) < window:
            empty_cols = ["price", "sentiment", "price_return", "price_zscore", "sentiment_zscore", "divergence", "signal"]
            return pd.DataFrame(columns=empty_cols, index=df.index)

        df["price_return"] = df["price"].pct_change()
        ret_mean = df["price_return"].rolling(window=window, min_periods=max(2, window // 2)).mean()
        ret_std = df["price_return"].rolling(window=window, min_periods=max(2, window // 2)).std()

        sent_mean = df["sentiment"].rolling(window=window, min_periods=max(2, window // 2)).mean()
        sent_std = df["sentiment"].rolling(window=window, min_periods=max(2, window // 2)).std()

        with np.errstate(divide="ignore", invalid="ignore"):
            df["price_zscore"] = (df["price_return"] - ret_mean) / ret_std.replace(0.0, np.nan)
            df["sentiment_zscore"] = (df["sentiment"] - sent_mean) / sent_std.replace(0.0, np.nan)

        df["price_zscore"] = df["price_zscore"].fillna(0.0)
        df["sentiment_zscore"] = df["sentiment_zscore"].fillna(0.0)
        df["divergence"] = df["sentiment_zscore"] - df["price_zscore"]

        df["signal"] = 0
        df.loc[df["divergence"] >= threshold, "signal"] = 1
        df.loc[df["divergence"] <= -threshold, "signal"] = -1

        return df

    # Caso 2: Entrada como pd.DataFrame (painel multi-ativo de preços e sentimentos)
    returns_5d = df_prices.pct_change(window)
    z_returns = (returns_5d - returns_5d.rolling(window).mean()) / (returns_5d.rolling(window).std() + 1e-8)
    z_sentiment = (df_sentiment - df_sentiment.rolling(window).mean()) / (df_sentiment.rolling(window).std() + 1e-8)

    divergence = z_sentiment - z_returns
    return divergence
