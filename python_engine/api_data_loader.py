"""
Alpha Quant Engine - Concurrent API Data Loader with Local SQLite Cache.
Centralizes data extraction for Fundamentals (Phase 1), Technical & Markov/Monte Carlo (Phases 2-3),
FinBERT Sentiment (Phase 4), and Purification metadata (Phase 5).
"""

from __future__ import annotations

import os
import sys
import json
import time
import sqlite3
import warnings
from typing import Dict, Any, List, Optional
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np
import pandas as pd
import yfinance as yf

# Database file location (defaults to workspace root / quant_cache.db)
DEFAULT_DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "quant_cache.db")
DB_FILE = os.environ.get("QUANT_CACHE_DB", DEFAULT_DB_PATH)

# TTLs
TTL_QUOTE_NEWS = 86400       # 24 Horas para Cotações e Notícias
TTL_FUNDAMENTALS = 2592000   # 30 Dias para Balanços e Demonstrações Financeiras


def init_db(db_path: str = DB_FILE) -> None:
    """Inicializa a base de dados SQLite local para cache estruturado em dois níveis."""
    db_dir = os.path.dirname(os.path.abspath(db_path))
    if db_dir and not os.path.exists(db_dir):
        os.makedirs(db_dir, exist_ok=True)

    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS asset_cache (
            ticker TEXT PRIMARY KEY,
            data JSON,
            timestamp REAL,
            fundamentals_timestamp REAL
        )
    ''')
    
    # Migração segura para tabela existente
    cursor.execute("PRAGMA table_info(asset_cache)")
    cols = {row[1] for row in cursor.fetchall()}
    if "fundamentals_timestamp" not in cols:
        try:
            cursor.execute("ALTER TABLE asset_cache ADD COLUMN fundamentals_timestamp REAL")
        except Exception:
            pass

    conn.commit()
    conn.close()


def get_cached_data(
    ticker: str,
    max_age_quotes: int = TTL_QUOTE_NEWS,
    max_age_fundamentals: int = TTL_FUNDAMENTALS,
    db_path: str = DB_FILE,
    max_age_seconds: Optional[int] = None,
    allow_partial: bool = False
) -> Optional[dict]:
    """
    Procura dados no cache local SQLite com validação de TTL independente 
    para cotações/notícias (24h) e balanço/demonstrações financeiras (30 dias).
    """
    if max_age_seconds is not None:
        max_age_quotes = max_age_seconds

    try:
        if not os.path.exists(db_path):
            return None

        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        cursor.execute(
            "SELECT data, timestamp, fundamentals_timestamp FROM asset_cache WHERE ticker = ?",
            (ticker.upper().strip(),)
        )
        row = cursor.fetchone()
        conn.close()

        if row:
            cached_data_str, ts_quotes, ts_fund = row
            if cached_data_str:
                data = json.loads(cached_data_str)
                now = time.time()
                ts_q = ts_quotes or 0.0
                ts_f = ts_fund or ts_q

                quotes_valid = (now - ts_q) < max_age_quotes
                fundamentals_valid = (now - ts_f) < max_age_fundamentals

                data["_quotes_valid"] = quotes_valid
                data["_fundamentals_valid"] = fundamentals_valid

                # Se ambas as secções forem válidas, podemos devolver diretamente
                if quotes_valid and fundamentals_valid:
                    return data
                
                # Se partial for permitido, devolver
                if allow_partial and (quotes_valid or fundamentals_valid):
                    return data
                
                # Se apenas quotes forem válidas e permitirmos
                if quotes_valid:
                    return data
    except Exception:
        pass
    return None


def save_to_cache(ticker: str, data: dict, db_path: str = DB_FILE) -> None:
    """Guarda os dados obtidos da API no cache local com timestamps individuais."""
    try:
        init_db(db_path)
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        now = time.time()

        cursor.execute('''
            INSERT OR REPLACE INTO asset_cache (ticker, data, timestamp, fundamentals_timestamp)
            VALUES (?, ?, ?, ?)
        ''', (ticker.upper().strip(), json.dumps(data), now, now))
        conn.commit()
        conn.close()
    except Exception as e:
        warnings.warn(f"Erro ao salvar no cache SQLite ({ticker}): {e}")


def _build_synthetic_asset(ticker_symbol: str) -> dict:
    """Gera dados sintéticos realistas como fallback de segurança."""
    ticker_clean = str(ticker_symbol).strip().upper()
    seed_val = abs(hash(ticker_clean)) % 10000
    np.random.seed(seed_val)

    mu, sigma = 0.0006, 0.016
    rets = np.random.normal(mu, sigma, 252)
    prices = [round(float(p), 4) for p in 100.0 * np.exp(np.cumsum(rets))]
    volumes = [int(v) for v in np.random.uniform(500000, 5000000, 252)]

    pseudo_mcap = 1e9 + (seed_val * 5e7)

    return {
        "ticker": ticker_clean,
        "sector": "Outros",
        "market_cap": pseudo_mcap,
        "current_ratio": 1.65,
        "debt_to_equity": 0.45,
        "roa": 0.085,
        "eps": 4.50,
        "price": prices[-1],
        "free_cash_flow": pseudo_mcap * 0.05,
        "enterprise_value": pseudo_mcap * 1.1,
        "headlines": [
            f"{ticker_clean} demonstrates consistent operational results and capital discipline.",
            f"Analysts review sector performance metrics and forward growth for {ticker_clean}."
        ],
        "price_history": prices,
        "volume_history": volumes,
        "valid": True,
        "is_synthetic": True
    }


def fetch_single_asset_api(
    ticker_symbol: str,
    max_age_quotes: int = TTL_QUOTE_NEWS,
    max_age_fundamentals: int = TTL_FUNDAMENTALS,
    db_path: str = DB_FILE,
    max_age_seconds: Optional[int] = None
) -> dict:
    """
    Busca todas as métricas necessárias para um ativo via yfinance com cache SQLite local de dois níveis:
    - 24h para cotações e notícias
    - 30 dias para balanços e fundamentais
    """
    if max_age_seconds is not None:
        max_age_quotes = max_age_seconds

    ticker_clean = str(ticker_symbol).strip().upper()

    # 1. Tentar ler do Cache Local SQLite
    cached = get_cached_data(
        ticker_clean,
        max_age_quotes=max_age_quotes,
        max_age_fundamentals=max_age_fundamentals,
        db_path=db_path,
        allow_partial=True
    )
    if cached and isinstance(cached, dict) and cached.get("valid"):
        if cached.get("_quotes_valid", True) and cached.get("_fundamentals_valid", True):
            return cached

    try:
        ticker = yf.Ticker(ticker_clean)
        info = getattr(ticker, 'info', {}) or {}

        # 2. Extração de Histórico de Preços (Fases 2, 3, Markov e Monte Carlo)
        # Se cotações no cache ainda forem válidas, reaproveitá-las
        if cached and cached.get("_quotes_valid", False) and cached.get("price_history"):
            prices = cached["price_history"]
            volumes = cached.get("volume_history", [1000000] * len(prices))
            current_price = cached.get("price", prices[-1] if prices else 100.0)
            headlines = cached.get("headlines", [])
        else:
            hist = ticker.history(period="1y")
            if hist is None or hist.empty or len(hist) < 20 or 'Close' not in hist.columns:
                fallback = _build_synthetic_asset(ticker_clean)
                save_to_cache(ticker_clean, fallback, db_path=db_path)
                return fallback

            prices = [round(float(p), 4) for p in hist['Close'].dropna().tolist()]
            volumes = [int(v) for v in hist['Volume'].fillna(0).tolist()] if 'Volume' in hist.columns else [1000000] * len(prices)

            if len(prices) < 20:
                fallback = _build_synthetic_asset(ticker_clean)
                save_to_cache(ticker_clean, fallback, db_path=db_path)
                return fallback

            current_price = info.get('currentPrice') or info.get('previousClose') or info.get('regularMarketPrice') or prices[-1]

            # 3. Extração de Notícias para o FinBERT (Fase 4)
            headlines = []
            try:
                news_items = getattr(ticker, 'news', []) or []
                for item in news_items:
                    if isinstance(item, dict):
                        title = item.get('title')
                        if not title and 'content' in item and isinstance(item['content'], dict):
                            title = item['content'].get('title')
                        if title and isinstance(title, str) and len(title.strip()) > 5:
                            headlines.append(title.strip())
            except Exception:
                pass

            if not headlines:
                headlines = [f"{ticker_clean} updates market on strategic guidance and institutional portfolio operations."]

        # 4. Extração e Normalização de Métricas Fundamentais & Balanço (30 dias TTL)
        if cached and cached.get("_fundamentals_valid", False) and cached.get("market_cap") is not None:
            market_cap = cached.get("market_cap")
            current_ratio = cached.get("current_ratio")
            debt_to_equity = cached.get("debt_to_equity")
            roa = cached.get("roa")
            eps = cached.get("eps")
            fcf = cached.get("free_cash_flow")
            ev = cached.get("enterprise_value")
            sector = cached.get("sector") or "Outros"
        else:
            market_cap = info.get('marketCap')
            if market_cap is None or (isinstance(market_cap, float) and np.isnan(market_cap)):
                market_cap = np.nan

            current_ratio = info.get('currentRatio')
            if current_ratio is None or (isinstance(current_ratio, float) and np.isnan(current_ratio)):
                current_ratio = np.nan

            debt_to_equity = info.get('debtToEquity')
            if debt_to_equity is None or (isinstance(debt_to_equity, float) and np.isnan(debt_to_equity)):
                debt_to_equity = np.nan
            else:
                try:
                    de_f = float(debt_to_equity)
                    if de_f > 10.0:  # Converter percentagem
                        debt_to_equity = de_f / 100.0
                    else:
                        debt_to_equity = de_f
                except Exception:
                    debt_to_equity = np.nan

            roa = info.get('returnOnAssets')
            if roa is None or (isinstance(roa, float) and np.isnan(roa)):
                roa = np.nan

            eps = info.get('trailingEps')
            if eps is None or (isinstance(eps, float) and np.isnan(eps)):
                eps = np.nan

            fcf = info.get('freeCashflow')
            ev = info.get('enterpriseValue')
            sector = info.get('sector') or 'Outros'

        # Montagem do objeto completo de dados do ativo
        asset_data = {
            "ticker": ticker_clean,
            "sector": sector,
            "market_cap": float(market_cap) if (market_cap is not None and not np.isnan(market_cap)) else None,
            "current_ratio": float(current_ratio) if (current_ratio is not None and not np.isnan(current_ratio)) else None,
            "debt_to_equity": float(debt_to_equity) if (debt_to_equity is not None and not np.isnan(debt_to_equity)) else None,
            "roa": float(roa) if (roa is not None and not np.isnan(roa)) else None,
            "eps": float(eps) if (eps is not None and not np.isnan(eps)) else None,
            "price": float(current_price) if (current_price is not None and not np.isnan(current_price)) else prices[-1],
            "free_cash_flow": float(fcf) if (fcf is not None and not np.isnan(fcf)) else None,
            "enterprise_value": float(ev) if (ev is not None and not np.isnan(ev)) else None,
            "headlines": headlines[:5],
            "price_history": prices,
            "volume_history": volumes,
            "valid": True,
            "is_synthetic": False
        }

        # Guardar no Cache SQLite
        save_to_cache(ticker_clean, asset_data, db_path=db_path)
        return asset_data

    except Exception:
        fallback = _build_synthetic_asset(ticker_clean)
        save_to_cache(ticker_clean, fallback, db_path=db_path)
        return fallback


def fetch_all_assets_parallel(
    tickers: List[str],
    max_workers: int = 15,
    max_age_quotes: int = TTL_QUOTE_NEWS,
    max_age_fundamentals: int = TTL_FUNDAMENTALS,
    db_path: str = DB_FILE,
    max_age_seconds: Optional[int] = None
) -> Dict[str, dict]:
    """
    Procura dados para múltiplos ativos em paralelo usando ThreadPoolExecutor (10-15 workers) 
    e Cache SQLite local de dois níveis (24h cotações / 30 dias balanços).
    """
    if max_age_seconds is not None:
        max_age_quotes = max_age_seconds

    init_db(db_path)
    results = {}

    clean_tickers = []
    seen = set()
    for t in tickers:
        c = str(t).strip().upper()
        if c and c not in seen:
            seen.add(c)
            clean_tickers.append(c)

    if not clean_tickers:
        return results

    # Clamp workers entre 10 e 15 para universos médios/grandes
    effective_workers = min(max(10, min(max_workers, 15)), len(clean_tickers))

    with ThreadPoolExecutor(max_workers=effective_workers) as executor:
        future_to_ticker = {
            executor.submit(
                fetch_single_asset_api,
                sym,
                max_age_quotes,
                max_age_fundamentals,
                db_path
            ): sym
            for sym in clean_tickers
        }
        for future in as_completed(future_to_ticker):
            sym = future_to_ticker[future]
            try:
                data = future.result()
                if data and data.get("valid"):
                    results[sym] = data
            except Exception:
                results[sym] = _build_synthetic_asset(sym)

    return results

