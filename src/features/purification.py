"""
Feature Purification & Factor Neutralization Module.

Provides:
1. Clustered Feature Importance (CFI) to mitigate substitution effects among collinear variables.
2. Two-Stage Factor Neutralization (Sector OLS Residualization + Log-Quadratic Size Neutralization).
3. Multicollinearity Diagnostics via Variance Inflation Factor (VIF).
"""

from __future__ import annotations

from typing import List, Dict, Any, Optional, Union, Tuple
import numpy as np
import pandas as pd
from scipy.cluster.hierarchy import linkage, fcluster
from scipy.spatial.distance import squareform
from sklearn.ensemble import RandomForestRegressor, RandomForestClassifier
from sklearn.linear_model import LinearRegression
try:
    from statsmodels.stats.outliers_influence import variance_inflation_factor
except ImportError:
    variance_inflation_factor = None


def neutralize_feature_two_stage(
    df: pd.DataFrame,
    feature_col: str,
    sector_col: str,
    market_cap_col: str
) -> pd.Series:
    """
    Executa a neutralização fatorial em duas etapas:
    Etapa 1: Regressão Linear contra Dummies Setoriais -> Resíduo 1
    Etapa 2: Regressão Log-Linear e Quadrática contra Market Cap -> Resíduo Final (Purificado)
    """
    clean_df = df[[feature_col, sector_col, market_cap_col]].dropna().copy()
    if clean_df.empty:
        return pd.Series(index=df.index, dtype=float)

    # Prepara Dummies de Setor
    sector_dummies = pd.get_dummies(clean_df[sector_col], drop_first=True, dtype=float)
    if sector_dummies.empty:
        sector_dummies = pd.DataFrame(np.ones((len(clean_df), 1)), index=clean_df.index)

    # Etapa 1: Neutralização Setorial
    model_sec = LinearRegression(fit_intercept=True)
    model_sec.fit(sector_dummies, clean_df[feature_col])
    res_sectoral = clean_df[feature_col] - model_sec.predict(sector_dummies)

    # Prepara variáveis de Market Cap (Log e Log Quadrado)
    log_mc = np.log(clean_df[market_cap_col].astype(float) + 1e-8)
    log_mc_sq = log_mc ** 2
    X_mc = np.column_stack((log_mc, log_mc_sq))

    # Etapa 2: Neutralização de Tamanho (Size Bias)
    model_mc = LinearRegression(fit_intercept=True)
    model_mc.fit(X_mc, res_sectoral)
    purified_signal = res_sectoral - model_mc.predict(X_mc)

    purified_series = pd.Series(purified_signal, index=clean_df.index, name=f"{feature_col}_purified")
    return purified_series.reindex(df.index)


def compute_vif_dataframe(df_features: pd.DataFrame) -> pd.DataFrame:
    """
    Calcula o Variance Inflation Factor (VIF) para cada coluna do DataFrame de features.
    """
    clean_df = df_features.select_dtypes(include=[np.number]).dropna().copy()
    if clean_df.empty or clean_df.shape[1] < 2:
        return pd.DataFrame(columns=["feature", "VIF"])

    vif_data = pd.DataFrame()
    vif_data["feature"] = clean_df.columns

    vif_values = []
    values = clean_df.values
    for i in range(clean_df.shape[1]):
        val = np.nan
        if variance_inflation_factor is not None:
            try:
                val = variance_inflation_factor(values, i)
            except Exception:
                val = np.nan
        if np.isnan(val):
            # Fallback robust calculation using linear regression R^2
            try:
                y = values[:, i]
                X = np.delete(values, i, axis=1)
                lr = LinearRegression(fit_intercept=True)
                lr.fit(X, y)
                r_sq = lr.score(X, y)
                if r_sq >= 0.999999:
                    val = 1000.0
                else:
                    val = float(1.0 / (1.0 - r_sq))
            except Exception:
                val = np.nan
        vif_values.append(val)

    vif_data["VIF"] = vif_values
    return vif_data.sort_values(by="VIF", ascending=False).reset_index(drop=True)


class FeaturePurifier:
    """
    Classe para purificar um conjunto de indicadores e selecionar variáveis não redundantes.
    """

    def __init__(self, df: pd.DataFrame, sector_col: str = "sector", market_cap_col: str = "market_cap"):
        self.df = df.copy()
        self.sector_col = sector_col
        self.market_cap_col = market_cap_col

    def neutralize_all_features(self, feature_cols: List[str]) -> pd.DataFrame:
        """Aplica a neutralização em duas etapas para todas as features especificadas."""
        purified_df = pd.DataFrame(index=self.df.index)

        for col in feature_cols:
            if col in self.df.columns:
                purified_df[f"{col}_purified"] = neutralize_feature_two_stage(
                    self.df, col, self.sector_col, self.market_cap_col
                )

        return purified_df



def compute_vif(df: pd.DataFrame, fillna: bool = True) -> pd.DataFrame:
    """
    Compute Variance Inflation Factor (VIF) for all numerical features in DataFrame.

    VIF_j = 1 / (1 - R_j^2)
    where R_j^2 is the R-squared from regressing feature j against all other features.

    Parameters
    ----------
    df : pd.DataFrame
        Matrix of continuous features.
    fillna : bool, default True
        Whether to fill NaN values with column means prior to calculation.

    Returns
    -------
    pd.DataFrame
        DataFrame with columns ['feature', 'vif', 'multicollinearity_level'].
    """
    clean_df = df.select_dtypes(include=[np.number]).copy()
    if fillna:
        clean_df = clean_df.fillna(clean_df.mean())

    clean_df = clean_df.dropna(axis=1, how="all")
    feature_names = list(clean_df.columns)
    k_vars = len(feature_names)

    if k_vars < 2:
        return pd.DataFrame({
            "feature": feature_names,
            "vif": [1.0] * k_vars,
            "multicollinearity_level": ["Low (< 5)"] * k_vars,
        })

    vif_records = []
    for i, col in enumerate(feature_names):
        y = clean_df[col].to_numpy()
        X = clean_df.drop(columns=[col]).to_numpy()

        if np.all(y == y[0]) or np.isnan(y).any() or np.isnan(X).any():
            vif_val = 1.0
        else:
            try:
                lr = LinearRegression(fit_intercept=True)
                lr.fit(X, y)
                r_sq = lr.score(X, y)
                if r_sq >= 0.999999:
                    vif_val = 1000.0
                else:
                    vif_val = float(1.0 / (1.0 - r_sq))
            except Exception:
                vif_val = np.nan

        # Categorize level
        if np.isnan(vif_val) or vif_val < 5.0:
            level = "Low (< 5)"
        elif vif_val < 10.0:
            level = "Moderate (5 - 10)"
        else:
            level = "Severe (> 10)"

        vif_records.append({
            "feature": col,
            "vif": round(vif_val, 3),
            "multicollinearity_level": level,
        })

    return pd.DataFrame(vif_records).sort_values("vif", ascending=False).reset_index(drop=True)


def select_informative_features(
    X: pd.DataFrame,
    y: Union[pd.Series, np.ndarray],
    is_classification: bool = False,
    corr_threshold: float = 0.7,
    n_estimators: int = 50,
    random_state: int = 42,
) -> Dict[str, Any]:
    """
    Feature Selection via Clustered Feature Importance (CFI).

    Addresses the substitution effect by:
    1. Clustering features via correlation distance matrix.
    2. Computing importance across feature clusters with a baseline ensemble.
    3. Categorizing features into 'Informative', 'Redundant', and 'Noise'.

    Parameters
    ----------
    X : pd.DataFrame
        Feature matrix.
    y : pd.Series or np.ndarray
        Target variable (returns or binary signals).
    is_classification : bool, default False
        Whether task is classification or regression.
    corr_threshold : float, default 0.7
        Correlation threshold for forming clusters (distance = sqrt(0.5 * (1 - rho))).
    n_estimators : int, default 50
        Number of trees in Random Forest.
    random_state : int, default 42
        Random seed for reproducibility.

    Returns
    -------
    Dict[str, Any]
        Dictionary containing:
        - 'informative_features': List[str]
        - 'redundant_features': List[str]
        - 'noise_features': List[str]
        - 'cluster_map': Dict[int, List[str]]
        - 'feature_importance_df': pd.DataFrame
    """
    clean_X = X.select_dtypes(include=[np.number]).fillna(0.0)
    feat_names = list(clean_X.columns)

    if len(feat_names) == 0:
        return {
            "informative_features": [],
            "redundant_features": [],
            "noise_features": [],
            "cluster_map": {},
            "feature_importance_df": pd.DataFrame(),
        }

    # 1. Cluster features based on correlation distance
    corr = clean_X.corr().fillna(0.0).to_numpy()
    # Distance: d = sqrt(0.5 * (1 - rho))
    dist = np.sqrt(np.clip(0.5 * (1.0 - corr), 0.0, 1.0))
    np.fill_diagonal(dist, 0.0)

    condensed_dist = squareform(dist, checks=False)
    z_link = linkage(condensed_dist, method="ward")
    # Form clusters
    cluster_labels = fcluster(z_link, t=1.0 - corr_threshold, criterion="distance")

    cluster_map: Dict[int, List[str]] = {}
    for feat, clus_id in zip(feat_names, cluster_labels):
        cluster_map.setdefault(int(clus_id), []).append(feat)

    # 2. Train baseline Random Forest model
    if is_classification:
        model = RandomForestClassifier(n_estimators=n_estimators, max_depth=5, random_state=random_state)
    else:
        model = RandomForestRegressor(n_estimators=n_estimators, max_depth=5, random_state=random_state)

    y_arr = np.asarray(y)
    valid_idx = ~np.isnan(y_arr)
    model.fit(clean_X.iloc[valid_idx], y_arr[valid_idx])

    importances = model.feature_importances_
    imp_series = pd.Series(importances, index=feat_names)

    # 3. Classify features per cluster
    # In each cluster, the top feature is 'Informative', others are 'Redundant' if cluster importance is above noise floor
    noise_threshold = 1.0 / (len(feat_names) * 2.0)

    informative: List[str] = []
    redundant: List[str] = []
    noise: List[str] = []

    for clus_id, feats in cluster_map.items():
        clus_importances = imp_series[feats]
        total_clus_imp = clus_importances.sum()

        if total_clus_imp < noise_threshold:
            noise.extend(feats)
        else:
            # Most important feature in cluster is Informative
            best_feat = clus_importances.idxmax()
            informative.append(best_feat)
            for f in feats:
                if f != best_feat:
                    redundant.append(f)

    # Construct output summary DataFrame
    status_map = {}
    for f in informative:
        status_map[f] = "Informative"
    for f in redundant:
        status_map[f] = "Redundant"
    for f in noise:
        status_map[f] = "Noise"

    summary_df = pd.DataFrame({
        "feature": feat_names,
        "cluster_id": [int(cluster_labels[i]) for i in range(len(feat_names))],
        "importance": [float(importances[i]) for i in range(len(feat_names))],
        "status": [status_map.get(f, "Noise") for f in feat_names],
    }).sort_values("importance", ascending=False).reset_index(drop=True)

    return {
        "informative_features": informative,
        "redundant_features": redundant,
        "noise_features": noise,
        "cluster_map": cluster_map,
        "feature_importance_df": summary_df,
    }


def neutralize_factors(
    features_df: pd.DataFrame,
    sector_series: pd.Series,
    market_cap_series: pd.Series,
) -> pd.DataFrame:
    """
    Two-Stage Factor Neutralization Pipeline.

    Stage 1 (Sector Neutralization):
        Feature_i = beta_0 + sum(beta_s * Sector_s) + e_1
        Extract Residual 1 (e_1).

    Stage 2 (Size Bias Neutralization):
        Residual_1 = alpha + gamma_1 * ln(Market_Cap) + gamma_2 * [ln(Market_Cap)]^2 + e_final
        Extract e_final (Purified Residual Features).

    Parameters
    ----------
    features_df : pd.DataFrame
        Original features to purify (rows are assets).
    sector_series : pd.Series
        Categorical sector assignments per asset aligned with features_df index.
    market_cap_series : pd.Series
        Market capitalization per asset aligned with features_df index.

    Returns
    -------
    pd.DataFrame
        Factor-neutralized purified residuals with identical shape and index.
    """
    idx = features_df.index
    aligned_sector = sector_series.reindex(idx)
    aligned_mcap = market_cap_series.reindex(idx).astype(float)

    # Prepare Stage 1: Sector Dummies (One-Hot Encoded)
    sector_dummies = pd.get_dummies(aligned_sector, drop_first=True, dtype=float)
    if sector_dummies.empty:
        # Fallback if no sector variance
        X_sector = np.ones((len(idx), 1))
    else:
        X_sector = sector_dummies.to_numpy()

    # Prepare Stage 2: Log Size and Quadratic Log Size
    log_mcap = np.log(np.maximum(aligned_mcap.to_numpy(), 1.0))
    # Replace any nan/inf with median log mcap
    valid_log = log_mcap[np.isfinite(log_mcap)]
    med_log = np.median(valid_log) if len(valid_log) > 0 else 10.0
    log_mcap = np.nan_to_num(log_mcap, nan=med_log, posinf=med_log, neginf=med_log)

    log_mcap_sq = log_mcap ** 2
    X_size = np.column_stack([log_mcap, log_mcap_sq])

    purified_data: Dict[str, np.ndarray] = {}

    for col in features_df.columns:
        y_feat = features_df[col].to_numpy(dtype=float)
        # Handle nan in feature
        valid_mask = np.isfinite(y_feat)
        if not np.any(valid_mask):
            purified_data[col] = np.zeros(len(idx))
            continue

        fill_val = np.nanmean(y_feat) if np.isnan(y_feat).any() else 0.0
        y_clean = np.nan_to_num(y_feat, nan=fill_val)

        # Stage 1: Sector Regression
        lr_sec = LinearRegression(fit_intercept=True)
        lr_sec.fit(X_sector, y_clean)
        pred_sector = lr_sec.predict(X_sector)
        res_stage1 = y_clean - pred_sector

        # Stage 2: Size Bias (Log-Linear + Quadratic) Regression
        lr_size = LinearRegression(fit_intercept=True)
        lr_size.fit(X_size, res_stage1)
        pred_size = lr_size.predict(X_size)
        res_final = res_stage1 - pred_size

        purified_data[col] = res_final

    return pd.DataFrame(purified_data, index=idx)
