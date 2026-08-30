#!/usr/bin/env python3
"""
Módulo de Rastreio, Auditoria Histórica e Aprendizagem Contínua (Feedback Loop / Auto-Otimização).
Regista recomendações, audita a calibração de Monte Carlo por patamares e calcula métricas de desempenho real (Walk-Forward).
"""

import os
import sqlite3
import pandas as pd
import numpy as np
import yfinance as yf
from typing import Dict, Any, List, Optional

DEFAULT_DB_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "quant_tracker.db"))
DB_TRACKER = os.environ.get("QUANT_TRACKER_DB_PATH", DEFAULT_DB_PATH)


def get_db_path() -> str:
    """Retorna o caminho ativo para a base de dados SQLite."""
    return os.environ.get("QUANT_TRACKER_DB_PATH", DEFAULT_DB_PATH)


def init_tracker_db(db_path: Optional[str] = None):
    """Inicializa e migra a tabela de recomendações rastreadas se necessário."""
    path = db_path or get_db_path()
    conn = sqlite3.connect(path)
    cursor = conn.cursor()
    
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS tracked_recommendations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticker TEXT NOT NULL,
            sector TEXT,
            entry_date TEXT NOT NULL,
            entry_price REAL NOT NULL,
            target_price REAL NOT NULL,
            stop_loss REAL NOT NULL,
            horizon_days INTEGER NOT NULL,
            predicted_win_rate REAL NOT NULL,
            alpha_score REAL NOT NULL,
            status TEXT DEFAULT 'PENDENTE', -- 'PENDENTE', 'TARGET_ATINGIDO', 'STOP_LOSS_ATINGIDO', 'EXPIRADO'
            exit_price REAL,
            exit_date TEXT,
            realized_return_pct REAL
        )
    ''')
    
    # Migrações seguras de colunas adicionais para esquemas existentes
    cursor.execute("PRAGMA table_info(tracked_recommendations)")
    existing_cols = {row[1] for row in cursor.fetchall()}
    
    additional_cols = [
        ("recommendation_date", "TEXT"),
        ("stop_loss_price", "REAL"),
        ("mc_win_rate", "REAL"),
        ("mc_tier_label", "TEXT"),
        ("current_price", "REAL"),
        ("realized_pnl_pct", "REAL"),
        ("max_favorable_excursion", "REAL"),
        ("max_adverse_excursion", "REAL"),
        ("days_to_exit", "INTEGER")
    ]
    
    for col_name, col_type in additional_cols:
        if col_name not in existing_cols:
            try:
                cursor.execute(f"ALTER TABLE tracked_recommendations ADD COLUMN {col_name} {col_type}")
            except Exception:
                pass
                
    conn.commit()
    conn.close()


def save_recommendation(data: dict, db_path: Optional[str] = None) -> Dict[str, Any]:
    """Guarda uma nova sugestão para acompanhamento e auditoria futura."""
    path = db_path or get_db_path()
    init_tracker_db(path)
    conn = sqlite3.connect(path)
    cursor = conn.cursor()
    
    ticker = str(data.get('ticker', '')).upper().strip()
    sector = data.get('sector', 'Outros')
    
    entry_price = float(data.get('current_price', data.get('entry_price', 0.0)))
    target_price = float(data.get('target_price', 0.0))
    stop_loss = float(data.get('stop_loss', data.get('stop_loss_price', 0.0)))
    horizon_days = int(data.get('horizon_days', 21))
    
    win_rate = data.get('win_rate_numeric')
    if win_rate is None:
        raw_wr = str(data.get('win_rate_mc', data.get('mc_win_rate', '50.0'))).replace('%', '').strip()
        try:
            win_rate = float(raw_wr)
        except Exception:
            win_rate = 50.0
    else:
        win_rate = float(win_rate)
        
    tier_info = data.get('tier', {})
    tier_label = tier_info.get('level') if isinstance(tier_info, dict) else str(data.get('mc_tier_label', ''))
    if not tier_label:
        if win_rate >= 70.0:
            tier_label = "Extrema (70%+)"
        elif win_rate >= 65.0:
            tier_label = "Muito Forte (65-69%)"
        elif win_rate >= 60.0:
            tier_label = "Forte (60-64%)"
        elif win_rate >= 55.0:
            tier_label = "Favorável (55-59%)"
        elif win_rate >= 50.0:
            tier_label = "Moderada (50-54%)"
        else:
            tier_label = "Fraca (<50%)"
            
    alpha_score = float(data.get('alpha_score', 0.0))
    rec_date = data.get('recommendation_date') or data.get('entry_date') or pd.Timestamp.now().strftime('%Y-%m-%d')

    cursor.execute('''
        INSERT INTO tracked_recommendations (
            ticker, sector, entry_date, recommendation_date, entry_price, target_price,
            stop_loss, stop_loss_price, horizon_days, predicted_win_rate, mc_win_rate,
            mc_tier_label, alpha_score, current_price, max_favorable_excursion, max_adverse_excursion, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0.0, 0.0, 'PENDENTE')
    ''', (
        ticker, sector, rec_date, rec_date, entry_price, target_price,
        stop_loss, stop_loss, horizon_days, win_rate, win_rate,
        tier_label, alpha_score, entry_price
    ))
        
    rec_id = cursor.lastrowid
    conn.commit()
    conn.close()
    
    return {
        "success": True,
        "id": rec_id,
        "ticker": ticker,
        "status": "PENDENTE",
        "entry_date": rec_date
    }


def evaluate_tracked_assets(db_path: Optional[str] = None) -> Dict[str, Any]:
    """
    Função executada para verificar se os ativos guardados 
    atingiram o Target, Stop Loss ou o limite de tempo (horizonte),
    calculando MFE (Max Favorable Excursion) e MAE (Max Adverse Excursion).
    """
    path = db_path or get_db_path()
    init_tracker_db(path)
    conn = sqlite3.connect(path)
    cursor = conn.cursor()
    cursor.execute("""
        SELECT id, ticker, entry_price, target_price, 
               COALESCE(stop_loss_price, stop_loss), 
               COALESCE(recommendation_date, entry_date), 
               horizon_days 
        FROM tracked_recommendations 
        WHERE status = 'PENDENTE'
    """)
    pending = cursor.fetchall()

    evaluated_count = 0
    updated_records = []

    for row in pending:
        rec_id, ticker_symbol, entry_p, target_p, stop_p, entry_d, horizon = row
        
        try:
            ticker_data = yf.Ticker(ticker_symbol)
            hist = ticker_data.history(period="1mo")
        except Exception:
            continue

        if hist.empty:
            continue

        latest_price = float(hist['Close'].iloc[-1])
        max_price_since = float(hist['High'].max())
        min_price_since = float(hist['Low'].min())

        mfe = ((max_price_since - entry_p) / entry_p) * 100.0 if entry_p > 0 else 0.0
        mae = ((min_price_since - entry_p) / entry_p) * 100.0 if entry_p > 0 else 0.0

        exit_date = None
        days_to_exit = None

        # Avaliar condições de saída
        if max_price_since >= target_p:
            status = 'TARGET_ATINGIDO'
            exit_p = target_p
            try:
                hit_dates = hist[hist['High'] >= target_p].index
                exit_date = hit_dates[0].strftime('%Y-%m-%d') if len(hit_dates) > 0 else pd.Timestamp.now().strftime('%Y-%m-%d')
                days_to_exit = max(1, (pd.Timestamp(exit_date) - pd.Timestamp(entry_d)).days)
            except Exception:
                exit_date = pd.Timestamp.now().strftime('%Y-%m-%d')
                days_to_exit = 5
        elif min_price_since <= stop_p:
            status = 'STOP_LOSS_ATINGIDO'
            exit_p = stop_p
            try:
                stop_dates = hist[hist['Low'] <= stop_p].index
                exit_date = stop_dates[0].strftime('%Y-%m-%d') if len(stop_dates) > 0 else pd.Timestamp.now().strftime('%Y-%m-%d')
                days_to_exit = max(1, (pd.Timestamp(exit_date) - pd.Timestamp(entry_d)).days)
            except Exception:
                exit_date = pd.Timestamp.now().strftime('%Y-%m-%d')
                days_to_exit = 5
        else:
            # Verificar se expirou o número de dias do horizonte
            try:
                days_passed = (pd.Timestamp.now().normalize() - pd.Timestamp(entry_d).normalize()).days
            except Exception:
                days_passed = 0
                
            if days_passed >= horizon:
                status = 'EXPIRADO'
                exit_p = latest_price
                exit_date = pd.Timestamp.now().strftime('%Y-%m-%d')
                days_to_exit = horizon
            else:
                # Continua pendente mas atualizamos o preço atual e MFE/MAE
                pnl_current = ((latest_price - entry_p) / entry_p) * 100.0 if entry_p > 0 else 0.0
                cursor.execute('''
                    UPDATE tracked_recommendations
                    SET current_price = ?, realized_pnl_pct = ?, realized_return_pct = ?,
                        max_favorable_excursion = ?, max_adverse_excursion = ?
                    WHERE id = ?
                ''', (round(latest_price, 2), round(pnl_current, 2), round(pnl_current, 2), round(mfe, 2), round(mae, 2), rec_id))
                continue

        ret_pct = ((exit_p - entry_p) / entry_p) * 100.0 if entry_p > 0 else 0.0
        
        cursor.execute('''
            UPDATE tracked_recommendations
            SET status = ?, current_price = ?, exit_price = ?, exit_date = ?,
                realized_return_pct = ?, realized_pnl_pct = ?,
                max_favorable_excursion = ?, max_adverse_excursion = ?, days_to_exit = ?
            WHERE id = ?
        ''', (status, round(exit_p, 2), round(exit_p, 2), exit_date, round(ret_pct, 2), round(ret_pct, 2), round(mfe, 2), round(mae, 2), days_to_exit, rec_id))
        
        evaluated_count += 1
        updated_records.append({
            "id": rec_id,
            "ticker": ticker_symbol,
            "status": status,
            "realized_return_pct": round(ret_pct, 2)
        })

    conn.commit()
    conn.close()

    return {
        "success": True,
        "evaluated_count": evaluated_count,
        "updated": updated_records
    }


def get_model_accuracy_metrics(db_path: Optional[str] = None) -> Dict[str, Any]:
    """Calcula a taxa de acerto real do modelo comparada com as previsões de Monte Carlo."""
    path = db_path or get_db_path()
    init_tracker_db(path)
    conn = sqlite3.connect(path)
    df = pd.read_sql_query("SELECT * FROM tracked_recommendations WHERE status != 'PENDENTE'", conn)
    conn.close()

    if df.empty:
        return {
            "total_trades": 0,
            "hit_rate": 0.0,
            "avg_return": 0.0,
            "target_hits": 0,
            "stop_hits": 0,
            "expired_count": 0
        }

    successful_trades = df[df['status'] == 'TARGET_ATINGIDO']
    stop_trades = df[df['status'] == 'STOP_LOSS_ATINGIDO']
    expired_trades = df[df['status'] == 'EXPIRADO']
    
    hit_rate = (len(successful_trades) / len(df)) * 100.0 if len(df) > 0 else 0.0
    pnl_col = 'realized_pnl_pct' if 'realized_pnl_pct' in df.columns and not df['realized_pnl_pct'].isna().all() else 'realized_return_pct'
    avg_return = df[pnl_col].mean() if not df[pnl_col].isna().all() else 0.0

    return {
        "total_trades": int(len(df)),
        "hit_rate": round(float(hit_rate), 1),
        "avg_return": round(float(avg_return), 2),
        "target_hits": int(len(successful_trades)),
        "stop_hits": int(len(stop_trades)),
        "expired_count": int(len(expired_trades))
    }


def get_tracker_dashboard_data(params: Optional[Dict[str, Any]] = None, db_path: Optional[str] = None) -> Dict[str, Any]:
    """
    Retorna o conjunto completo de dados e agregações para a aba
    'AlphaQuant Tracker & Performance' (Audit Trail / Walk-Forward Tracking Log).
    """
    path = db_path or get_db_path()
    init_tracker_db(path)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    cursor.execute("SELECT * FROM tracked_recommendations ORDER BY id DESC")
    raw_rows = cursor.fetchall()
    conn.close()

    items = []
    for r in raw_rows:
        row_dict = dict(r)
        
        # Harmonização de colunas legadas e novas
        rec_date = row_dict.get('recommendation_date') or row_dict.get('entry_date') or ''
        win_rate = row_dict.get('mc_win_rate') or row_dict.get('predicted_win_rate') or 50.0
        stop_p = row_dict.get('stop_loss_price') or row_dict.get('stop_loss') or 0.0
        pnl = row_dict.get('realized_pnl_pct')
        if pnl is None:
            pnl = row_dict.get('realized_return_pct')
        if pnl is None and row_dict.get('current_price') and row_dict.get('entry_price'):
            pnl = ((row_dict['current_price'] - row_dict['entry_price']) / row_dict['entry_price']) * 100.0
        pnl = float(pnl) if pnl is not None else 0.0
        
        cur_price = row_dict.get('current_price') or row_dict.get('exit_price') or row_dict.get('entry_price')
        
        tier_label = row_dict.get('mc_tier_label')
        if not tier_label:
            if win_rate >= 70.0:
                tier_label = "Extrema (70%+)"
            elif win_rate >= 65.0:
                tier_label = "Muito Forte (65-69%)"
            elif win_rate >= 60.0:
                tier_label = "Forte (60-64%)"
            elif win_rate >= 55.0:
                tier_label = "Favorável (55-59%)"
            elif win_rate >= 50.0:
                tier_label = "Moderada (50-54%)"
            else:
                tier_label = "Fraca (<50%)"
                
        items.append({
            "id": row_dict.get("id"),
            "ticker": row_dict.get("ticker"),
            "sector": row_dict.get("sector") or "Outros",
            "recommendation_date": rec_date,
            "entry_date": rec_date,
            "entry_price": round(float(row_dict.get("entry_price", 0.0)), 2),
            "current_price": round(float(cur_price or 0.0), 2),
            "target_price": round(float(row_dict.get("target_price", 0.0)), 2),
            "stop_loss_price": round(float(stop_p), 2),
            "stop_loss": round(float(stop_p), 2),
            "mc_win_rate": round(float(win_rate), 1),
            "predicted_win_rate": round(float(win_rate), 1),
            "mc_tier_label": tier_label,
            "alpha_score": round(float(row_dict.get("alpha_score", 0.0)), 1),
            "horizon_days": int(row_dict.get("horizon_days", 21)),
            "status": row_dict.get("status") or "PENDENTE",
            "exit_price": round(float(row_dict["exit_price"]), 2) if row_dict.get("exit_price") is not None else None,
            "exit_date": row_dict.get("exit_date"),
            "realized_pnl_pct": round(float(pnl), 2),
            "max_favorable_excursion": round(float(row_dict.get("max_favorable_excursion") or 0.0), 2),
            "max_adverse_excursion": round(float(row_dict.get("max_adverse_excursion") or 0.0), 2),
            "days_to_exit": row_dict.get("days_to_exit")
        })

    # 1. Agregação de KPIs Globais
    total_recs = len(items)
    pending_items = [it for it in items if it["status"] == "PENDENTE"]
    target_hits = [it for it in items if it["status"] == "TARGET_ATINGIDO"]
    stop_hits = [it for it in items if it["status"] == "STOP_LOSS_ATINGIDO"]
    expired_items = [it for it in items if it["status"] == "EXPIRADO"]
    resolved_trades = target_hits + stop_hits + expired_items

    # Hit Rate Real (%)
    if resolved_trades:
        hit_rate = (len(target_hits) / len(resolved_trades)) * 100.0
    else:
        hit_rate = 0.0

    # Profit Factor
    gains = [it["realized_pnl_pct"] for it in resolved_trades if it["realized_pnl_pct"] > 0]
    losses = [abs(it["realized_pnl_pct"]) for it in resolved_trades if it["realized_pnl_pct"] < 0]
    sum_gains = sum(gains)
    sum_losses = sum(losses)
    
    if sum_losses > 0:
        profit_factor = round(sum_gains / sum_losses, 2)
    elif sum_gains > 0:
        profit_factor = round(sum_gains, 2)
    else:
        profit_factor = 1.0

    # Retorno Médio por Trade (%)
    all_pnls = [it["realized_pnl_pct"] for it in items]
    avg_return = round(float(np.mean(all_pnls)), 2) if all_pnls else 0.0

    # Tempo Médio até ao Alvo (dias)
    target_days = [it["days_to_exit"] for it in target_hits if it.get("days_to_exit") is not None and it["days_to_exit"] > 0]
    avg_days_to_target = round(float(np.mean(target_days)), 1) if target_days else 0.0

    kpis = {
        "total_recommendations": total_recs,
        "active_pending": len(pending_items),
        "target_hits": len(target_hits),
        "stop_hits": len(stop_hits),
        "expired_count": len(expired_items),
        "resolved_trades": len(resolved_trades),
        "hit_rate": round(hit_rate, 1),
        "profit_factor": profit_factor,
        "avg_return_pct": avg_return,
        "avg_days_to_target": avg_days_to_target
    }

    # 2. Matriz de Validação de Patamares (Monte Carlo Calibration Matrix)
    tier_definitions = [
        {"tier_id": 5, "label": "Tier 5 (70%+ Win Rate)", "badge": "bg-primary", "min_wr": 70.0, "max_wr": 100.0},
        {"tier_id": 4, "label": "Tier 4 (65% - 69%)", "badge": "bg-info text-dark", "min_wr": 65.0, "max_wr": 69.99},
        {"tier_id": 3, "label": "Tier 3 (60% - 64%)", "badge": "bg-success", "min_wr": 60.0, "max_wr": 64.99},
        {"tier_id": 2, "label": "Tier 2 (55% - 59%)", "badge": "bg-teal", "min_wr": 55.0, "max_wr": 59.99},
        {"tier_id": 1, "label": "Tier 1 (50% - 54%)", "badge": "bg-warning text-dark", "min_wr": 50.0, "max_wr": 54.99},
    ]

    tier_matrix = []
    for t in tier_definitions:
        tier_items = [it for it in items if t["min_wr"] <= it["mc_win_rate"] <= t["max_wr"]]
        count_emitted = len(tier_items)
        t_targets = [it for it in tier_items if it["status"] == "TARGET_ATINGIDO"]
        t_stops = [it for it in tier_items if it["status"] == "STOP_LOSS_ATINGIDO"]
        t_resolved = [it for it in tier_items if it["status"] != "PENDENTE"]
        
        t_hit_rate = round((len(t_targets) / len(t_resolved)) * 100.0, 1) if t_resolved else 0.0
        t_returns = [it["realized_pnl_pct"] for it in tier_items]
        t_avg_ret = round(float(np.mean(t_returns)), 2) if t_returns else 0.0
        
        if count_emitted == 0:
            status_calibration = "Sem Amostras"
        elif len(t_resolved) >= 3 and t_hit_rate >= t["min_wr"] - 5.0:
            status_calibration = "Calibrado com Sucesso"
        elif len(t_resolved) >= 3 and t_hit_rate < t["min_wr"] - 10.0:
            status_calibration = "Alerta de Subdesempenho"
        else:
            status_calibration = "Amostragem em Curso"

        tier_matrix.append({
            "tier_id": t["tier_id"],
            "tier_label": t["label"],
            "badge": t["badge"],
            "suggestions_count": count_emitted,
            "targets_hit": len(t_targets),
            "stops_hit": len(t_stops),
            "hit_rate_real": t_hit_rate,
            "avg_return": t_avg_ret,
            "status_calibration": status_calibration
        })

    # 3. Lista de Coortes Disponíveis (Datas Únicas)
    cohort_dates = sorted(list({it["recommendation_date"] for it in items if it.get("recommendation_date")}), reverse=True)

    return {
        "success": True,
        "kpis": kpis,
        "tier_matrix": tier_matrix,
        "cohort_dates": cohort_dates,
        "items": items
    }


def get_all_tracked_recommendations(status: Optional[str] = None, db_path: Optional[str] = None) -> List[Dict[str, Any]]:
    """Retorna todas as recomendações registadas com filtro opcional de status."""
    path = db_path or get_db_path()
    init_tracker_db(path)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    if status:
        cursor.execute("SELECT * FROM tracked_recommendations WHERE status = ? ORDER BY id DESC", (status,))
    else:
        cursor.execute("SELECT * FROM tracked_recommendations ORDER BY id DESC")
        
    rows = cursor.fetchall()
    result = [dict(row) for row in rows]
    conn.close()
    return result
