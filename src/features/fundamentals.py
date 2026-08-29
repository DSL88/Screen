"""
Fundamental Analysis & Financial Solvency Module.

Provides vectorized balance sheet, income statement, and valuation metrics
along with the FundamentalScreener class to isolate financially robust assets
and eliminate companies at risk of insolvency or valuation anomalies (Graham Defensive Filter).
"""

from __future__ import annotations

from typing import Union, Optional, Sequence, Tuple
import numpy as np
import pandas as pd


SeriesLike = Union[pd.Series, np.ndarray, Sequence[float]]


def _to_series(data: SeriesLike, index: Optional[pd.Index] = None, name: Optional[str] = None) -> pd.Series:
    """Helper to convert array-like input into a pandas Series with clean dtype."""
    if isinstance(data, pd.Series):
        s = data.copy()
        if name is not None:
            s.name = name
        return s.astype(float)
    return pd.Series(data, index=index, name=name, dtype=float)


def calculate_current_ratio(current_assets: SeriesLike, current_liabilities: SeriesLike) -> pd.Series:
    """Calcula o Current Ratio (Ativo Corrente / Passivo Corrente) evitando divisão por zero."""
    ca = _to_series(current_assets, name="current_ratio")
    cl = _to_series(current_liabilities, index=ca.index)
    res = np.where(cl > 0, ca / cl, np.nan)
    return pd.Series(res, index=ca.index, name="current_ratio", dtype=float)


def calculate_debt_to_equity(total_liabilities: SeriesLike, total_equity: SeriesLike) -> pd.Series:
    """Calcula a relação Dívida/Capital Próprio (Passivo Total / Capital Próprio)."""
    tl = _to_series(total_liabilities, name="debt_to_equity")
    te = _to_series(total_equity, index=tl.index)
    res = np.where(te > 0, tl / te, np.nan)
    return pd.Series(res, index=tl.index, name="debt_to_equity", dtype=float)


def calculate_earnings_yield(eps: SeriesLike, price: SeriesLike) -> pd.Series:
    """Calcula o Earnings Yield (LPA / Preço de Fecho)."""
    e = _to_series(eps, name="earnings_yield")
    p = _to_series(price, index=e.index)
    res = np.where(p > 0, e / p, np.nan)
    return pd.Series(res, index=e.index, name="earnings_yield", dtype=float)


def calculate_price_to_book(market_cap: SeriesLike, book_value: SeriesLike) -> pd.Series:
    """Calcula o rácio Price-to-Book (P/B) (Capitalização de Mercado / Valor Contabilístico)."""
    mc = _to_series(market_cap, name="price_to_book")
    bv = _to_series(book_value, index=mc.index)
    res = np.where(bv > 0, mc / bv, np.nan)
    return pd.Series(res, index=mc.index, name="price_to_book", dtype=float)


def calculate_roa(net_income: SeriesLike, total_assets: SeriesLike) -> pd.Series:
    """Calcula o Return on Assets (ROA) (Resultado Líquido / Ativo Total)."""
    ni = _to_series(net_income, name="roa")
    ta = _to_series(total_assets, index=ni.index)
    res = np.where(ta > 0, ni / ta, np.nan)
    return pd.Series(res, index=ni.index, name="roa", dtype=float)


def calculate_fcf_yield(free_cash_flow: SeriesLike, enterprise_value: SeriesLike) -> pd.Series:
    """Calcula o Free Cash Flow Yield (Fluxo de Caixa Livre / Enterprise Value)."""
    fcf = _to_series(free_cash_flow, name="fcf_yield")
    ev = _to_series(enterprise_value, index=fcf.index)
    res = np.where(ev > 0, fcf / ev, np.nan)
    return pd.Series(res, index=fcf.index, name="fcf_yield", dtype=float)


def calculate_net_income_growth_5y(
    net_income_current: SeriesLike,
    net_income_5y_ago: SeriesLike
) -> pd.Series:
    """
    Calcula o CAGR de 5 anos do Lucro Líquido.
    CAGR = (Net_Income_Current / Net_Income_5Y)^(1/5) - 1.
    """
    nic = _to_series(net_income_current, name="net_income_growth_5y")
    ni5 = _to_series(net_income_5y_ago, index=nic.index)
    
    has_positive_base = (ni5 > 0) & (nic > 0)
    growth = np.where(
        has_positive_base,
        np.power(nic / ni5, 1.0 / 5.0) - 1.0,
        np.nan
    )
    return pd.Series(growth, index=nic.index, name="net_income_growth_5y", dtype=float)


class FundamentalScreener:
    """
    Classe responsável por calcular indicadores e filtrar ativos com base em critérios fundamentais
    e solvência financeira (Filtro Passa-Baixo Fundamental / Graham Defensive Screen).
    """

    def __init__(self, df: pd.DataFrame) -> None:
        """
        Inicializa o screener com a base de dados fundamental.

        Espera um DataFrame com colunas chave:
        ['ticker', 'current_assets', 'current_liabilities', 'total_liabilities',
         'total_equity', 'eps', 'price'/'close_price', 'market_cap', 'book_value',
         'net_income', 'total_assets', 'free_cash_flow', 'enterprise_value',
         'net_income_5y_ago']
        """
        if not isinstance(df, pd.DataFrame):
            raise TypeError("Input data must be a pandas DataFrame.")
        self.df = df.copy()

    def compute_all_metrics(
        self,
        current_assets_col: str = "current_assets",
        current_liabilities_col: str = "current_liabilities",
        total_liabilities_col: str = "total_liabilities",
        total_equity_col: str = "total_equity",
        eps_col: str = "eps",
        price_col: Optional[str] = None,
        market_cap_col: str = "market_cap",
        book_value_col: str = "book_value",
        net_income_col: str = "net_income",
        total_assets_col: str = "total_assets",
        fcf_col: str = "free_cash_flow",
        ev_col: str = "enterprise_value",
        net_income_5y_col: str = "net_income_5y_ago",
    ) -> pd.DataFrame:
        """Calcula todas as métricas fundamentais e adiciona ao DataFrame."""
        df = self.df

        # Resolve price column name
        if price_col is None:
            if "price" in df.columns:
                p_col = "price"
            elif "close_price" in df.columns:
                p_col = "close_price"
            else:
                p_col = "price"
        else:
            p_col = price_col

        if current_assets_col in df and current_liabilities_col in df:
            df["current_ratio"] = calculate_current_ratio(df[current_assets_col], df[current_liabilities_col])

        if total_liabilities_col in df and total_equity_col in df:
            df["debt_to_equity"] = calculate_debt_to_equity(df[total_liabilities_col], df[total_equity_col])

        if eps_col in df and p_col in df:
            df["earnings_yield"] = calculate_earnings_yield(df[eps_col], df[p_col])

        if market_cap_col in df and book_value_col in df:
            df["price_to_book"] = calculate_price_to_book(df[market_cap_col], df[book_value_col])

        if net_income_col in df and total_assets_col in df:
            df["roa"] = calculate_roa(df[net_income_col], df[total_assets_col])

        if fcf_col in df and ev_col in df:
            df["fcf_yield"] = calculate_fcf_yield(df[fcf_col], df[ev_col])

        if net_income_5y_col in df and net_income_col in df:
            df["net_income_growth_5y"] = calculate_net_income_growth_5y(df[net_income_col], df[net_income_5y_col])

        self.df = df
        return self.df

    def apply_solvency_filter(
        self,
        min_current_ratio: float = 2.0,
        max_debt_equity: float = 1.5,
        min_roa: float = 0.0,
        return_tuple: bool = True
    ) -> Union[Tuple[pd.DataFrame, pd.Series], pd.Series]:
        """
        Aplica filtros estritos de liquidez e alavancagem (Filtro Defensive Graham).

        Parameters
        ----------
        min_current_ratio : float, default 2.0
            Mínimo Current Ratio exigido (Liquidez imediata).
        max_debt_equity : float, default 1.5
            Máximo rácio Dívida/Capital Próprio tolerado.
        min_roa : float, default 0.0
            Mínimo Return on Assets exigido (Rentabilidade estritamente positiva).
        return_tuple : bool, default True
            Se True, retorna (filtered_df, mask). Se False, retorna apenas mask.

        Returns
        -------
        Tuple[pd.DataFrame, pd.Series] or pd.Series
            DataFrame com os ativos aprovados e a máscara booleana correspondente.
        """
        if "current_ratio" not in self.df.columns or "debt_to_equity" not in self.df.columns or "roa" not in self.df.columns:
            self.compute_all_metrics()

        cr = self.df.get("current_ratio", pd.Series(np.nan, index=self.df.index))
        de = self.df.get("debt_to_equity", pd.Series(np.nan, index=self.df.index))
        roa = self.df.get("roa", pd.Series(np.nan, index=self.df.index))
        ey = self.df.get("earnings_yield", pd.Series(np.nan, index=self.df.index))

        mask = (
            (cr.notna()) & (cr >= min_current_ratio) &
            (de.notna()) & (de <= max_debt_equity) & (de >= 0) &
            (roa.notna()) & (roa > min_roa) &
            (ey.notna())
        )
        mask.name = "is_solvent"

        if return_tuple:
            filtered_df = self.df[mask].copy()
            return filtered_df, mask
        return mask

    def calculate_graham_quality_score(self) -> pd.Series:
        """
        Gera uma pontuação padronizada (0 a 100) combinando a liquidez,
        rentabilidade e moderação de alavancagem por ranking percentil.
        """
        if "current_ratio" not in self.df.columns:
            self.compute_all_metrics()

        cr_score = self.df["current_ratio"].rank(pct=True, ascending=True)
        de_score = self.df["debt_to_equity"].rank(pct=True, ascending=False)
        ey_score = self.df["earnings_yield"].rank(pct=True, ascending=True)
        roa_score = self.df["roa"].rank(pct=True, ascending=True)

        composite_score = (cr_score * 0.25 + de_score * 0.25 + ey_score * 0.25 + roa_score * 0.25) * 100.0
        self.df["fundamental_quality_score"] = composite_score.fillna(0.0).round(2)
        return self.df["fundamental_quality_score"]

    def calculate_graham_score(
        self,
        min_current_ratio: float = 2.0,
        max_debt_equity: float = 1.5,
        min_earnings_yield: float = 0.05,
        max_pb: float = 1.5,
        min_roa: float = 0.05,
        min_growth_5y: float = 0.03,
    ) -> pd.Series:
        """Calcula o score de Graham ponderado por regras absolutas de solvência e avaliação."""
        if "current_ratio" not in self.df.columns:
            self.compute_all_metrics()

        cr = self.df.get("current_ratio", pd.Series(0.0, index=self.df.index)).fillna(0.0)
        de = self.df.get("debt_to_equity", pd.Series(999.0, index=self.df.index)).fillna(999.0)
        ey = self.df.get("earnings_yield", pd.Series(0.0, index=self.df.index)).fillna(0.0)
        pb = self.df.get("price_to_book", pd.Series(999.0, index=self.df.index)).fillna(999.0)
        roa = self.df.get("roa", pd.Series(0.0, index=self.df.index)).fillna(0.0)
        g5y = self.df.get("net_income_growth_5y", pd.Series(0.0, index=self.df.index)).fillna(0.0)

        score = pd.Series(0.0, index=self.df.index, name="graham_score", dtype=float)

        score += np.clip(cr / min_current_ratio, 0.0, 1.0) * 20.0
        de_score = np.where(de <= max_debt_equity, np.maximum(0.0, 1.0 - (de / (max_debt_equity * 1.2))), 0.0)
        score += np.clip(de_score, 0.0, 1.0) * 20.0
        score += np.clip(ey / min_earnings_yield, 0.0, 1.0) * 15.0
        pb_score = np.where((pb > 0) & (pb <= max_pb), np.maximum(0.0, 1.0 - (pb / (max_pb * 1.5))), 0.0)
        score += np.clip(pb_score, 0.0, 1.0) * 15.0
        score += np.clip(roa / min_roa, 0.0, 1.0) * 15.0
        score += np.clip(g5y / min_growth_5y, 0.0, 1.0) * 15.0

        return score.round(2)
