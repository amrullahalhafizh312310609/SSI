from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import mysql.connector
from mysql.connector import Error
import os
import math
from datetime import datetime, date, timedelta
import traceback
import secrets
import time
try:
    from sklearn.model_selection import train_test_split
    from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
    try:
        from sklearn.ensemble import RandomForestRegressor, GradientBoostingRegressor
    except Exception:
        RandomForestRegressor = None
        GradientBoostingRegressor = None
except Exception:
    train_test_split = None
    mean_absolute_error = None
    mean_squared_error = None
    r2_score = None
    RandomForestRegressor = None
    GradientBoostingRegressor = None

try:
    from xgboost import XGBRegressor
except Exception:
    XGBRegressor = None

try:
    import numpy as np
except Exception:
    np = None

try:
    import tensorflow as tf
except Exception:
    tf = None

app = Flask(__name__, static_folder='static')
CORS(
    app,
    resources={r"/api/*": {"origins": "*"}},
    allow_headers=["Content-Type", "X-Auth-Token"],
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
)
app.url_map.strict_slashes = False

# Konfigurasi Database MySQL
DB_CONFIG = {
    'host': os.environ.get('DB_HOST', 'localhost'),
    'port': int(os.environ.get('DB_PORT', '3306')),
    'user': os.environ.get('DB_USER', 'root'),
    'password': os.environ.get('DB_PASSWORD', ''),
    'database': os.environ.get('DB_NAME', 'gudang_db')
}

_TOKENS = {}

def _issue_token(username: str) -> str:
    token = secrets.token_urlsafe(24)
    _TOKENS[token] = {"user": username, "exp": time.time() + 8 * 60 * 60}
    return token

def _is_token_valid(token: str) -> bool:
    if not token:
        return False
    data = _TOKENS.get(token)
    if not data:
        return False
    if float(data.get("exp", 0)) < time.time():
        _TOKENS.pop(token, None)
        return False
    return True

def _require_auth():
    token = request.headers.get('X-Auth-Token', '')
    if not _is_token_valid(token):
        return jsonify({"status": "error", "message": "Unauthorized"}), 401
    return None

def get_db_connection():
    try:
        conn = mysql.connector.connect(**DB_CONFIG)
        return conn
    except Error as e:
        print(f"Error connecting to MySQL: {e}")
        return None

def _has_column(cursor, table: str, column: str) -> bool:
    cursor.execute("SHOW COLUMNS FROM {} LIKE %s".format(table), (column,))
    return cursor.fetchone() is not None

def _safe_float(x):
    try:
        return float(x)
    except Exception:
        return None

def _safe_int(x):
    try:
        return int(x)
    except Exception:
        return None

def _norm_text(x):
    try:
        return ' '.join(str(x or '').split()).strip()
    except Exception:
        return ''

def _ensure_transactions_support_qty_in(cursor):
    try:
        if not _has_column(cursor, "transactions", "qty_in"):
            cursor.execute("ALTER TABLE transactions ADD COLUMN qty_in INT NOT NULL DEFAULT 0")
        if not _has_column(cursor, "transactions", "doc_number"):
            cursor.execute("ALTER TABLE transactions ADD COLUMN doc_number VARCHAR(100) NULL")
        cursor.execute("ALTER TABLE transactions MODIFY COLUMN qty_out INT NOT NULL DEFAULT 0")
    except Exception:
        return

def _ensure_prediction_logs_table(cursor):
    try:
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS prediction_logs (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                company_name VARCHAR(255) NOT NULL,
                item_name VARCHAR(255) NOT NULL,
                target_month DATE NULL,
                lead_time INT NOT NULL,
                service_level DOUBLE NOT NULL,
                algorithm VARCHAR(50) NULL,
                prediction INT NOT NULL,
                current_stock INT NOT NULL,
                needed_stock INT NOT NULL,
                safety_stock INT NOT NULL,
                reorder_point INT NOT NULL,
                reorder_needed TINYINT(1) NOT NULL,
                accuracy DOUBLE NULL,
                mae DOUBLE NULL,
                rmse DOUBLE NULL,
                r2 DOUBLE NULL,
                mape DOUBLE NULL
            )
            """.strip()
        )
        if not _has_column(cursor, "prediction_logs", "accuracy"):
            cursor.execute("ALTER TABLE prediction_logs ADD COLUMN accuracy DOUBLE NULL")
        if not _has_column(cursor, "prediction_logs", "algorithm"):
            cursor.execute("ALTER TABLE prediction_logs ADD COLUMN algorithm VARCHAR(50) NULL")
        if not _has_column(cursor, "prediction_logs", "mape"):
            cursor.execute("ALTER TABLE prediction_logs ADD COLUMN mape DOUBLE NULL")
    except Exception:
        return

def _ensure_work_orders_table(cursor):
    try:
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS work_orders (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                company_name VARCHAR(255) NOT NULL,
                item_name VARCHAR(255) NOT NULL,
                target_month DATE NULL,
                planned_qty INT NOT NULL,
                unit VARCHAR(50) NULL,
                lead_time INT NULL,
                service_level DOUBLE NULL,
                prediction_log_id BIGINT NULL,
                status ENUM('Draft', 'Released', 'In Progress', 'Completed', 'Cancelled') DEFAULT 'Draft',
                due_date DATE NULL,
                notes TEXT NULL,
                instructions TEXT NULL
            )
            """.strip()
        )
    except Exception:
        return

def _build_work_order_instructions(company_name: str, item_name: str, planned_qty: int, unit: str, target_month_iso: str, due_date_iso: str):
    company_name = (company_name or "").strip()
    item_name = (item_name or "").strip()
    unit = (unit or "").strip()
    header = f"WORK ORDER PRODUKSI\nPerusahaan: {company_name}\nBarang: {item_name}"
    lines = [
        header,
        f"Target Bulan: {target_month_iso or '-'}",
        f"Qty Produksi: {planned_qty} {unit}".strip(),
        f"Due Date: {due_date_iso or '-'}",
        "",
        "Instruksi Pelaksanaan:",
        "1) Validasi kebutuhan",
        "   - Pastikan forecast & kebutuhan produksi sudah disetujui.",
        "   - Pastikan qty produksi mencukupi kebutuhan.",
        "2) Cek ketersediaan bahan/komponen",
        "   - Verifikasi stok bahan baku dan/atau komponen pendukung.",
        "   - Jika kurang, buat permintaan pengadaan/pemenuhan.",
        "3) Penjadwalan produksi",
        "   - Tentukan tanggal mulai & shift produksi.",
        "   - Pastikan mesin, tooling, dan operator tersedia.",
        "4) Pelaksanaan produksi",
        "   - Produksi sesuai SOP dan target qty.",
        "   - Catat output per batch/shift.",
        "5) QC/Inspeksi",
        "   - Lakukan pemeriksaan kualitas sesuai standar.",
        "   - Pisahkan NG/Reject dan buat laporan bila ada.",
        "6) Serah terima hasil produksi",
        "   - Update stok barang masuk melalui fitur Barang Masuk.",
        "   - Pastikan transaksi tercatat untuk evaluasi forecast berikutnya.",
    ]
    return "\n".join(lines)

def _parse_iso_date(value):
    if value is None:
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, datetime):
        return value.date().isoformat()
    if not isinstance(value, str):
        return None
    s = value.strip()
    if not s:
        return None
    try:
        return datetime.strptime(s[:10], "%Y-%m-%d").date().isoformat()
    except Exception:
        return None

def _normalize_work_order_status(value: str):
    allowed = {'Draft', 'Released', 'In Progress', 'Completed', 'Cancelled'}
    if not value:
        return None
    s = str(value).strip()
    if s in allowed:
        return s
    return None

def _month_start(d: date) -> date:
    return date(d.year, d.month, 1)

def _add_months(d: date, months: int) -> date:
    year = d.year + (d.month - 1 + months) // 12
    month = (d.month - 1 + months) % 12 + 1
    return date(year, month, 1)

def _month_diff(a: date, b: date) -> int:
    return (b.year - a.year) * 12 + (b.month - a.month)

def simple_linear_regression(xs, ys):
    n = len(xs)
    if n == 0:
        return 0.0, 0.0
    if n == 1:
        return 0.0, float(ys[0])

    sum_x = sum(xs)
    sum_y = sum(ys)
    sum_xy = sum(x * y for x, y in zip(xs, ys))
    sum_x2 = sum(x * x for x in xs)

    denom = n * sum_x2 - sum_x * sum_x
    if denom == 0:
        return 0.0, sum_y / n

    m = (n * sum_xy - sum_x * sum_y) / denom
    b = (sum_y - m * sum_x) / n
    return float(m), float(b)

def _normalize_algorithm(value):
    s = str(value or '').strip().lower()
    mapping = {
        'ma': 'moving_average',
        'moving average': 'moving_average',
        'moving_average': 'moving_average',
        'rf': 'random_forest',
        'random forest': 'random_forest',
        'random_forest': 'random_forest',
        'xgb': 'xgboost',
        'xgboost': 'xgboost',
        'lstm': 'lstm'
    }
    return mapping.get(s, 'moving_average')

def _predict_moving_average(ys, window: int = 3) -> float:
    if not ys:
        return 0.0
    w = int(window) if window else 3
    if w <= 0:
        w = 3
    w = min(w, len(ys))
    return float(sum(ys[-w:]) / w)

def _predict_model_1d(xs, ys, target_x: float, algorithm: str):
    algo = _normalize_algorithm(algorithm)
    if algo == 'random_forest':
        if not RandomForestRegressor:
            return None, 'Random Forest belum tersedia (scikit-learn tidak terpasang)'
        model = RandomForestRegressor(
            n_estimators=250,
            random_state=42
        )
        model.fit([[float(x)] for x in xs], [float(y) for y in ys])
        y_hat = float(model.predict([[float(target_x)]])[0])
        return y_hat, None

    if algo == 'xgboost':
        if XGBRegressor and np is not None:
            model = XGBRegressor(
                n_estimators=350,
                learning_rate=0.05,
                max_depth=4,
                subsample=0.9,
                colsample_bytree=0.9,
                objective='reg:squarederror',
                random_state=42
            )
            X = np.array([[float(x)] for x in xs], dtype=float)
            y = np.array([float(v) for v in ys], dtype=float)
            model.fit(X, y)
            y_hat = float(model.predict(np.array([[float(target_x)]], dtype=float))[0])
            return y_hat, None
        return None, 'XGBoost belum tersedia (install xgboost dan numpy)'

    if algo == 'lstm':
        if tf is None or np is None:
            return None, 'LSTM belum tersedia (tensorflow/numpy tidak terpasang)'
        if len(ys) < 4:
            return None, 'LSTM butuh minimal 4 bulan data'

        seq_len = 3
        series = np.array([float(v) for v in ys], dtype=float)
        max_v = float(np.max(series)) if float(np.max(series)) > 0 else 1.0
        series_n = series / max_v

        X = []
        Y = []
        for i in range(len(series_n) - seq_len):
            X.append(series_n[i:i+seq_len])
            Y.append(series_n[i+seq_len])
        X = np.array(X, dtype=float).reshape((-1, seq_len, 1))
        Y = np.array(Y, dtype=float).reshape((-1, 1))

        model = tf.keras.Sequential([
            tf.keras.layers.Input(shape=(seq_len, 1)),
            tf.keras.layers.LSTM(16),
            tf.keras.layers.Dense(1)
        ])
        model.compile(optimizer='adam', loss='mse')
        model.fit(X, Y, epochs=60, batch_size=8, verbose=0)

        last_seq = series_n[-seq_len:].reshape((1, seq_len, 1))
        y_hat = float(model.predict(last_seq, verbose=0)[0][0]) * max_v
        return y_hat, None

    return None, 'Algoritma tidak dikenali'

def _backtest_algorithm(ys, algorithm: str, min_train_points: int = 4):
    algo = _normalize_algorithm(algorithm)
    ys = [float(v) for v in (ys or [])]
    if len(ys) < max(3, min_train_points):
        return {"algorithm": algo, "available": False, "message": "Data historis belum cukup", "metrics": {"mae": 0.0, "rmse": 0.0, "mape": 0.0}, "points": 0}

    y_true = []
    y_pred = []
    notes = ""
    for i in range(1, len(ys)):
        train_ys = ys[:i]
        if algo == 'moving_average':
            pred = _predict_moving_average(train_ys, window=3)
        else:
            xs_train = [float(j + 1) for j in range(len(train_ys))]
            target_x = float(i + 1)
            pred_raw, note = _predict_model_1d(xs_train, train_ys, target_x, algo)
            if pred_raw is None:
                notes = note or notes
                pred = _predict_moving_average(train_ys, window=3)
            else:
                pred = float(pred_raw)

        y_true.append(float(ys[i]))
        y_pred.append(float(max(0.0, pred)))

    metrics = calculate_metrics(y_true, y_pred)
    return {
        "algorithm": algo,
        "available": True,
        "message": notes,
        "metrics": {"mae": float(metrics.get("mae") or 0.0), "rmse": float(metrics.get("rmse") or 0.0), "mape": float(metrics.get("mape") or 0.0)},
        "points": len(y_true)
    }

def _mae(y_true, y_pred):
    if not y_true:
        return 0.0
    return sum(abs(a - b) for a, b in zip(y_true, y_pred)) / len(y_true)

def _rmse(y_true, y_pred):
    if not y_true:
        return 0.0
    return math.sqrt(sum((a - b) ** 2 for a, b in zip(y_true, y_pred)) / len(y_true))

def _mape(y_true, y_pred):
    total = 0
    count = 0
    for a, b in zip(y_true, y_pred):
        try:
            actual = float(a)
            pred = float(b)
        except Exception:
            continue
        if actual == 0:
            continue
        total += abs((actual - pred) / actual)
        count += 1
    if count == 0:
        return 0.0
    return float(total / count * 100.0)

def _r2(y_true, y_pred):
    if len(y_true) < 2:
        return 0.0
    mean_y = sum(y_true) / len(y_true)
    sst = sum((y - mean_y) ** 2 for y in y_true)
    if sst < 1e-10:
        return 0.0
    sse = sum((a - b) ** 2 for a, b in zip(y_true, y_pred))
    r2 = 1.0 - (sse / sst)
    if r2 < -1.0:
        r2 = -1.0
    return float(r2)

def _tolerance_accuracy(y_true, y_pred, tolerance: float = 0.20) -> float:
    total = 0
    correct = 0
    tol = float(tolerance)
    if tol < 0:
        tol = 0.0

    for a, b in zip(y_true, y_pred):
        try:
            actual = float(a)
            pred = float(b)
        except Exception:
            continue

        if actual <= 0.0:
            continue

        total += 1
        if abs(actual - pred) / actual <= tol:
            correct += 1

    if total == 0:
        return 0.0
    return float(correct / total * 100.0)

def calculate_metrics(y_true, y_pred):
    if not y_true:
        return {"mae": 0.0, "rmse": 0.0, "r2": 0.0, "accuracy": 0.0, "mape": 0.0}
    accuracy_val = _tolerance_accuracy(y_true, y_pred, tolerance=0.20)
    if mean_absolute_error and mean_squared_error and r2_score:
        try:
            mae_val = float(mean_absolute_error(y_true, y_pred))
            mse_val = float(mean_squared_error(y_true, y_pred))
            rmse_val = float(math.sqrt(mse_val))
            r2_val = float(r2_score(y_true, y_pred))
            if r2_val < -1.0:
                r2_val = -1.0
            return {"mae": mae_val, "rmse": rmse_val, "r2": r2_val, "accuracy": accuracy_val, "mape": _mape(y_true, y_pred)}
        except Exception:
            pass
    return {
        "mae": _mae(y_true, y_pred),
        "rmse": _rmse(y_true, y_pred),
        "r2": _r2(y_true, y_pred),
        "accuracy": accuracy_val,
        "mape": _mape(y_true, y_pred)
    }

def _sample_std(values):
    n = len(values)
    if n < 2:
        return 0.0
    mean_v = sum(values) / n
    var = sum((v - mean_v) ** 2 for v in values) / (n - 1)
    return math.sqrt(var)

def get_z_score(service_level):
    mapping = {
        0.90: 1.28,
        0.95: 1.65,
        0.99: 2.33
    }
    try:
        sl = float(service_level)
    except Exception:
        sl = 0.95

    if sl >= 1.0:
        sl = sl / 100.0

    if sl in mapping:
        return mapping[sl]
    if sl >= 0.99:
        return mapping[0.99]
    if sl >= 0.95:
        return mapping[0.95]
    if sl >= 0.90:
        return mapping[0.90]
    return mapping[0.90]

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')

@app.route('/static/<path:path>')
def send_static(path):
    return send_from_directory('static', path)

@app.route('/api/inventory', methods=['GET'])
def get_inventory():
    conn = get_db_connection()
    if not conn:
        return jsonify({"status": "error", "message": "Database connection failed"}), 500
    
    try:
        cursor = conn.cursor(dictionary=True)
        cursor.execute("SELECT id, company_name as perusahaan, item_name as barang, unit as satuan, stock as stok, location as lokasi, status FROM inventory")
        data = cursor.fetchall()
        return jsonify(data)
    except Error as e:
        return jsonify({"status": "error", "message": str(e)}), 500
    finally:
        cursor.close()
        conn.close()

@app.route('/api/inventory', methods=['POST'])
def save_inventory():
    auth_err = _require_auth()
    if auth_err:
        return auth_err

    data = request.json
    inventory_data = data.get('inventory', [])
    
    conn = get_db_connection()
    if not conn:
        return jsonify({"status": "error", "message": "Database connection failed"}), 500
    
    try:
        cursor = conn.cursor()
        unique_companies = list(set([item.get('perusahaan') for item in inventory_data if item.get('perusahaan')]))
        for company in unique_companies:
            cursor.execute("INSERT IGNORE INTO companies (name, status) VALUES (%s, %s)", (company, 'Aktif'))

        for item in inventory_data:
            query = """
                INSERT INTO inventory (id, company_name, item_name, unit, stock, location, status)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE 
                unit = VALUES(unit), stock = VALUES(stock), status = VALUES(status), location = VALUES(location)
            """
            cursor.execute(query, (
                item.get('id'), item.get('perusahaan'), item.get('barang'),
                item.get('satuan'), item.get('stok'), item.get('lokasi'), item.get('status')
            ))
        conn.commit()
        return jsonify({"status": "success"})
    except Error as e:
        return jsonify({"status": "error", "message": str(e)}), 500
    finally:
        cursor.close()
        conn.close()

@app.route('/api/inventory/add', methods=['POST'])
def add_inventory_item():
    auth_err = _require_auth()
    if auth_err:
        return auth_err

    payload = request.json or {}
    perusahaan = _norm_text(payload.get('perusahaan'))
    barang = _norm_text(payload.get('barang'))
    satuan = _norm_text(payload.get('satuan') or 'pcs') or 'pcs'
    lokasi = _norm_text(payload.get('lokasi') or 'A-01') or 'A-01'

    try:
        stok = int(payload.get('stok', 0))
    except Exception:
        stok = 0

    if not perusahaan or not barang:
        return jsonify({"status": "error", "message": "perusahaan dan barang wajib diisi"}), 400
    if stok < 0:
        return jsonify({"status": "error", "message": "stok tidak boleh negatif"}), 400

    status = 'Ada' if stok > 0 else 'Tidak Ada'

    conn = get_db_connection()
    if not conn:
        return jsonify({"status": "error", "message": "Database connection failed"}), 500

    cursor = None
    try:
        cursor = conn.cursor()
        cursor.execute("INSERT IGNORE INTO companies (name, status) VALUES (%s, %s)", (perusahaan, 'Aktif'))
        cursor.execute(
            "INSERT INTO inventory (company_name, item_name, unit, stock, location, status) VALUES (%s, %s, %s, %s, %s, %s)",
            (perusahaan, barang, satuan, stok, lokasi, status)
        )
        new_id = cursor.lastrowid
        conn.commit()

        cursor2 = conn.cursor(dictionary=True)
        cursor2.execute(
            "SELECT id, company_name as perusahaan, item_name as barang, unit as satuan, stock as stok, location as lokasi, status FROM inventory WHERE id = %s",
            (new_id,)
        )
        row = cursor2.fetchone()
        cursor2.close()

        return jsonify({"status": "success", "item": row})
    except Error as e:
        return jsonify({"status": "error", "message": str(e)}), 500
    finally:
        if cursor:
            cursor.close()
        conn.close()

@app.route('/api/inventory/<int:item_id>', methods=['DELETE'])
def delete_inventory_item(item_id: int):
    auth_err = _require_auth()
    if auth_err:
        return auth_err

    conn = get_db_connection()
    if not conn:
        return jsonify({"status": "error", "message": "Database connection failed"}), 500

    cursor = None
    try:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM inventory WHERE id = %s", (item_id,))
        conn.commit()
        if cursor.rowcount <= 0:
            return jsonify({"status": "error", "message": "Data tidak ditemukan"}), 404
        return jsonify({"status": "success"})
    except Error as e:
        return jsonify({"status": "error", "message": str(e)}), 500
    finally:
        if cursor:
            cursor.close()
        conn.close()

@app.route('/api/history', methods=['GET'])
def get_history():
    try:
        limit_raw = request.args.get('limit')
        offset_raw = request.args.get('offset')
        limit = int(limit_raw) if limit_raw is not None else None
        offset = int(offset_raw) if offset_raw is not None else 0
    except Exception:
        limit = None
        offset = 0

    if limit is not None and limit <= 0:
        limit = None
    if offset < 0:
        offset = 0

    conn = get_db_connection()
    if not conn:
        return jsonify([])
    
    try:
        cursor = conn.cursor(dictionary=True)
        _ensure_transactions_support_qty_in(cursor)
        has_qty_in = _has_column(cursor, "transactions", "qty_in")

        if has_qty_in:
            base = """
                SELECT
                    date as tanggal,
                    company_name as perusahaan,
                    item_name as nama_barang,
                    COALESCE(doc_number, '') as nomor_dokumen,
                    unit as satuan,
                    qty_out,
                    qty_in,
                    CASE WHEN qty_in > 0 THEN 'Masuk' ELSE 'Keluar' END as jenis,
                    CASE WHEN qty_in > 0 THEN qty_in ELSE qty_out END as jumlah,
                    qty_out as jumlah_terjual
                FROM transactions
                ORDER BY date DESC, id DESC
            """.strip()
        else:
            base = """
                SELECT
                    date as tanggal,
                    company_name as perusahaan,
                    item_name as nama_barang,
                    COALESCE(doc_number, '') as nomor_dokumen,
                    unit as satuan,
                    qty_out,
                    0 as qty_in,
                    'Keluar' as jenis,
                    qty_out as jumlah,
                    qty_out as jumlah_terjual
                FROM transactions
                ORDER BY date DESC, id DESC
            """.strip()

        if limit is None:
            cursor.execute(base)
        else:
            cursor.execute(base + " LIMIT %s OFFSET %s", (limit, offset))
        data = cursor.fetchall()
        for row in data:
            row['tanggal'] = str(row['tanggal'])
        return jsonify(data)
    except Error as e:
        return jsonify([])
    finally:
        cursor.close()
        conn.close()

@app.route('/api/history', methods=['POST'])
def save_history():
    auth_err = _require_auth()
    if auth_err:
        return auth_err

    entry = request.json
    conn = get_db_connection()
    if not conn:
        return jsonify({"status": "error", "message": "Database connection failed"}), 500
    
    try:
        cursor = conn.cursor(dictionary=True)
        _ensure_transactions_support_qty_in(cursor)
        has_qty_in = _has_column(cursor, "transactions", "qty_in")
        
        # 1. Cek stok saat ini terlebih dahulu
        perusahaan = _norm_text(entry.get('perusahaan'))
        barang = _norm_text(entry.get('nama_barang'))
        jumlah_keluar = int(entry.get('jumlah_terjual', 0))
        doc_number = _norm_text(entry.get('doc_number') or entry.get('nomor_dokumen') or entry.get('nomor_transaksi')) or None

        cursor.execute("SELECT stock FROM inventory WHERE company_name = %s AND item_name = %s", (perusahaan, barang))
        row = cursor.fetchone()

        if not row:
            cursor2 = conn.cursor()
            cursor2.execute("INSERT IGNORE INTO companies (name, status) VALUES (%s, %s)", (perusahaan, 'Aktif'))
            cursor2.execute(
                "INSERT INTO inventory (company_name, item_name, unit, stock, location, status) VALUES (%s, %s, %s, %s, %s, %s)",
                (perusahaan, barang, _norm_text(entry.get('satuan') or 'pcs') or 'pcs', 0, 'A-01', 'Tidak Ada')
            )
            cursor2.close()
            cursor.execute("SELECT stock FROM inventory WHERE company_name = %s AND item_name = %s", (perusahaan, barang))
            row = cursor.fetchone()
            if not row:
                return jsonify({"status": "error", "message": "Barang tidak ditemukan di inventori"}), 404
        
        current_stock = row['stock']
        if current_stock < jumlah_keluar:
            return jsonify({"status": "error", "message": f"Stok tidak mencukupi! (Stok saat ini: {current_stock})"}), 400

        # 2. Kurangi stok di tabel inventory
        new_stock = current_stock - jumlah_keluar
        new_status = 'Ada' if new_stock > 0 else 'Tidak Ada'
        
        cursor.execute(
            "UPDATE inventory SET stock = %s, status = %s WHERE company_name = %s AND item_name = %s",
            (new_stock, new_status, perusahaan, barang)
        )

        # 3. Masukkan ke riwayat transaksi
        if has_qty_in:
            query_hist = "INSERT INTO transactions (date, company_name, item_name, unit, doc_number, qty_out, qty_in) VALUES (%s, %s, %s, %s, %s, %s, %s)"
            cursor.execute(query_hist, (
                entry.get('tanggal'), perusahaan, barang,
                entry.get('satuan'), doc_number, jumlah_keluar, 0
            ))
        else:
            query_hist = "INSERT INTO transactions (date, company_name, item_name, unit, doc_number, qty_out) VALUES (%s, %s, %s, %s, %s, %s)"
            cursor.execute(query_hist, (
                entry.get('tanggal'), perusahaan, barang,
                entry.get('satuan'), doc_number, jumlah_keluar
            ))
        
        conn.commit()
        return jsonify({"status": "success", "new_stock": new_stock})
    except Error as e:
        return jsonify({"status": "error", "message": str(e)}), 500
    finally:
        cursor.close()
        conn.close()

@app.route('/api/stock-in', methods=['POST'])
def stock_in():
    auth_err = _require_auth()
    if auth_err:
        return auth_err

    payload = request.json or {}
    perusahaan = _norm_text(payload.get('perusahaan'))
    barang = _norm_text(payload.get('nama_barang'))
    satuan = _norm_text(payload.get('satuan') or 'pcs') or 'pcs'
    tanggal = payload.get('tanggal')
    qty_in = _safe_int(payload.get('qty_in', 0)) or 0
    doc_number = _norm_text(payload.get('doc_number') or payload.get('nomor_dokumen') or payload.get('nomor_transaksi')) or None

    if not perusahaan or not barang or not tanggal:
        return jsonify({"status": "error", "message": "perusahaan, nama_barang, dan tanggal wajib diisi"}), 400
    if qty_in <= 0:
        return jsonify({"status": "error", "message": "qty_in harus lebih dari 0"}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({"status": "error", "message": "Database connection failed"}), 500

    cursor = None
    try:
        cursor = conn.cursor(dictionary=True)
        _ensure_transactions_support_qty_in(cursor)
        has_qty_in = _has_column(cursor, "transactions", "qty_in")

        cursor.execute("SELECT stock FROM inventory WHERE company_name = %s AND item_name = %s", (perusahaan, barang))
        row = cursor.fetchone()
        if not row:
            cursor2 = conn.cursor()
            cursor2.execute("INSERT IGNORE INTO companies (name, status) VALUES (%s, %s)", (perusahaan, 'Aktif'))
            cursor2.execute(
                "INSERT INTO inventory (company_name, item_name, unit, stock, location, status) VALUES (%s, %s, %s, %s, %s, %s)",
                (perusahaan, barang, satuan, 0, 'A-01', 'Tidak Ada')
            )
            cursor2.close()
            cursor.execute("SELECT stock FROM inventory WHERE company_name = %s AND item_name = %s", (perusahaan, barang))
            row = cursor.fetchone()
            if not row:
                return jsonify({"status": "error", "message": "Barang tidak ditemukan di inventori"}), 404

        current_stock = int(row.get('stock') or 0)
        new_stock = current_stock + qty_in
        new_status = 'Ada' if new_stock > 0 else 'Tidak Ada'

        cursor.execute(
            "UPDATE inventory SET stock = %s, status = %s WHERE company_name = %s AND item_name = %s",
            (new_stock, new_status, perusahaan, barang)
        )

        if has_qty_in:
            cursor.execute(
                "INSERT INTO transactions (date, company_name, item_name, unit, doc_number, qty_out, qty_in) VALUES (%s, %s, %s, %s, %s, %s, %s)",
                (tanggal, perusahaan, barang, satuan, doc_number, 0, qty_in)
            )
        else:
            cursor.execute(
                "INSERT INTO transactions (date, company_name, item_name, unit, doc_number, qty_out) VALUES (%s, %s, %s, %s, %s, %s)",
                (tanggal, perusahaan, barang, satuan, doc_number, 0)
            )

        conn.commit()
        return jsonify({"status": "success", "new_stock": new_stock})
    except Error as e:
        return jsonify({"status": "error", "message": str(e)}), 500
    finally:
        if cursor:
            cursor.close()
        conn.close()

@app.route('/api/predict', methods=['POST'])
def predict():
    payload = request.json or {}
    perusahaan = _norm_text(payload.get('perusahaan'))
    nama_barang = _norm_text(payload.get('nama_barang'))
    target_date_raw = payload.get('target_date')
    algorithm_used = 'xgboost'
    algorithm_note = ""
    model_last_trained_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    try:
        lead_time = int(payload.get('lead_time', 3))
    except Exception:
        lead_time = 3

    try:
        service_level = float(payload.get('service_level', 0.95))
    except Exception:
        service_level = 0.95

    if not perusahaan or not nama_barang:
        return jsonify({"status": "error", "message": "perusahaan dan nama_barang wajib diisi"}), 400

    if lead_time <= 0:
        lead_time = 1

    target_month = None
    if isinstance(target_date_raw, str) and target_date_raw.strip():
        try:
            dt = datetime.strptime(target_date_raw[:10], "%Y-%m-%d").date()
            target_month = _month_start(dt)
        except Exception:
            target_month = None

    conn = get_db_connection()
    if not conn:
        return jsonify({"status": "error", "message": "Database connection failed"}), 500

    cursor = None
    try:
        cursor = conn.cursor(dictionary=True)

        cursor.execute(
            "SELECT id, stock, unit, location, status FROM inventory WHERE company_name = %s AND item_name = %s",
            (perusahaan, nama_barang)
        )
        inv = cursor.fetchone()
        if not inv:
            return jsonify({"status": "error", "message": "Barang tidak ditemukan di inventori"}), 404

        inventory_id = inv.get('id')
        current_stock = int(inv.get('stock') or 0)
        unit = inv.get('unit') or ''
        lokasi = inv.get('location') or ''

        cursor.execute(
            "SELECT date, qty_out FROM transactions WHERE company_name = %s AND item_name = %s ORDER BY date ASC",
            (perusahaan, nama_barang)
        )
        rows = cursor.fetchall()

        month_totals = {}
        day_totals = {}
        min_day = None
        max_day = None
        for r in rows:
            d = r.get('date')
            if isinstance(d, datetime):
                d = d.date()
            if not isinstance(d, date):
                continue
            if min_day is None or d < min_day:
                min_day = d
            if max_day is None or d > max_day:
                max_day = d
            m = _month_start(d)
            qty = int(r.get('qty_out') or 0)
            if qty < 0:
                qty = 0
            month_totals[m] = month_totals.get(m, 0) + qty
            day_totals[d] = day_totals.get(d, 0) + qty

        months = sorted(month_totals.keys())
        series = []

        if months:
            start = months[0]
            end = months[-1]
            m = start
            while m <= end:
                series.append((m, float(month_totals.get(m, 0))))
                m = _add_months(m, 1)

        daily_values = []
        if min_day is not None and max_day is not None:
            cur = min_day
            while cur <= max_day:
                daily_values.append(float(day_totals.get(cur, 0)))
                cur = cur + timedelta(days=1)

        cold_start = False
        eval_mode = "none"
        history_series = [{"month": m.isoformat(), "qty": float(y)} for (m, y) in series]

        if not series:
            cold_start = True
            z = get_z_score(service_level)
            avg_demand = 0.0
            std_demand = 0.0
            safety_stock = 0
            reorder_point = 0
            prediction = 0
            needed_stock = 0
            reorder_needed = bool(current_stock <= reorder_point)
            metrics = {"mae": 0.0, "rmse": 0.0, "r2": 0.0, "accuracy": 0.0, "mape": 0.0}
            if target_month is None:
                target_month = _month_start(date.today())
            target_month_iso = target_month.isoformat()
        else:
            first_month = series[0][0]
            last_month = series[-1][0]
            if target_month is None:
                target_month = _add_months(last_month, 1)

            xs_all = [float(i + 1) for i in range(len(series))]
            ys_all = [y for _, y in series]

            n = len(xs_all)
            target_index = _month_diff(first_month, target_month) + 1
            if target_index < 1:
                target_index = 1

            prediction_raw = None
            if not XGBRegressor or np is None:
                return jsonify({"status": "error", "message": "XGBoost wajib untuk prediksi. Install dependency: pip install xgboost numpy"}), 500

            y_hat, note = _predict_model_1d(xs_all, ys_all, float(target_index), algorithm_used)
            if y_hat is None:
                algorithm_note = note or "XGBoost gagal membuat prediksi"
                prediction_raw = 0.0
            else:
                prediction_raw = float(y_hat)
                if note:
                    algorithm_note = str(note)

            prediction = int(max(0, round(float(prediction_raw or 0.0))))

            if n < 3:
                eval_mode = "none"
                metrics = {"mae": 0.0, "rmse": 0.0, "r2": 0.0, "accuracy": 0.0, "mape": 0.0}
            else:
                eval_mode = "in_sample_all"
                y_pred_all = []
                model = XGBRegressor(
                    n_estimators=350,
                    learning_rate=0.05,
                    max_depth=4,
                    subsample=0.9,
                    colsample_bytree=0.9,
                    objective='reg:squarederror',
                    random_state=42
                )
                X = np.array([[float(x)] for x in xs_all], dtype=float)
                y = np.array([float(v) for v in ys_all], dtype=float)
                model.fit(X, y)
                y_pred_all = [float(v) for v in model.predict(X)]

                if not y_pred_all:
                    y_pred_all = [0.0 for _ in ys_all]
                metrics = calculate_metrics(ys_all, y_pred_all)

            avg_demand = float(sum(daily_values) / len(daily_values)) if daily_values else 0.0
            std_demand = float(_sample_std(daily_values))
            z = get_z_score(service_level)

            safety_stock = int(max(0, round(z * std_demand * math.sqrt(float(lead_time)))))
            reorder_point = int(max(0, round(avg_demand * float(lead_time) + float(safety_stock))))

            needed_stock = int(max(0, prediction - current_stock))
            reorder_needed = bool(current_stock <= reorder_point)
            cold_start = len(series) < 3
            target_month_iso = target_month.isoformat()

        min_history_months = 3
        model_training_months = len(series)
        model_ready = bool(model_training_months >= 6)
        cold_start_reason = ""
        if len(series) == 0:
            cold_start_reason = "Belum ada transaksi untuk item ini. Tambahkan minimal 10 transaksi barang keluar agar prediksi lebih akurat."
        elif len(series) < min_history_months:
            cold_start_reason = f"Riwayat transaksi baru {len(series)} bulan. Minimal {min_history_months} bulan data disarankan untuk prediksi akurat. Tambahkan minimal 10 transaksi barang keluar agar prediksi lebih stabil."

        try:
            _ensure_prediction_logs_table(cursor)
            cursor.execute(
                """
                INSERT INTO prediction_logs
                    (company_name, item_name, target_month, lead_time, service_level, algorithm, prediction, current_stock, needed_stock,
                     safety_stock, reorder_point, reorder_needed, accuracy, mae, rmse, r2, mape)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """.strip(),
                (
                    perusahaan, nama_barang, target_month_iso[:10] if target_month_iso else None,
                    int(lead_time), float(service_level), algorithm_used, int(prediction), int(current_stock), int(needed_stock),
                    int(safety_stock), int(reorder_point), 1 if reorder_needed else 0,
                    _safe_float(metrics.get("accuracy")),
                    _safe_float(metrics.get("mae")), _safe_float(metrics.get("rmse")), _safe_float(metrics.get("r2")),
                    _safe_float(metrics.get("mape"))
                )
            )
            conn.commit()
        except Exception:
            pass

        return jsonify({
            "status": "success",
            "perusahaan": perusahaan,
            "nama_barang": nama_barang,
            "inventory_id": inventory_id,
            "unit": unit,
            "lokasi": lokasi,
            "lead_time": lead_time,
            "service_level": service_level,
            "algorithm": algorithm_used,
            "algorithm_note": algorithm_note,
            "model_training_months": model_training_months,
            "model_min_training_months": 6,
            "model_ready": model_ready,
            "model_last_trained_at": model_last_trained_at,
            "z_value": z,
            "prediction": prediction,
            "current_stock": current_stock,
            "needed_stock": needed_stock,
            "avg_demand": avg_demand,
            "std_demand": std_demand,
            "safety_stock": safety_stock,
            "reorder_point": reorder_point,
            "reorder_needed": reorder_needed,
            "accuracy": float(metrics.get("accuracy", 0.0) or 0.0),
            "metrics": {
                "mae": float(metrics.get("mae", 0.0) or 0.0),
                "rmse": float(metrics.get("rmse", 0.0) or 0.0),
                "mape": float(metrics.get("mape", 0.0) or 0.0),
                "accuracy": float(metrics.get("accuracy", 0.0) or 0.0)
            },
            "eval_mode": eval_mode,
            "history_points": len(series),
            "history_series": history_series,
            "target_month": target_month_iso,
            "cold_start": cold_start,
            "min_history_months": min_history_months,
            "cold_start_reason": cold_start_reason
        })
    except Error as e:
        return jsonify({"status": "error", "message": str(e)}), 500
    except Exception as e:
        return jsonify({"status": "error", "message": str(e), "details": traceback.format_exc()}), 500
    finally:
        if cursor:
            cursor.close()
        conn.close()

@app.route('/api/predictions', methods=['GET'])
def get_predictions():
    try:
        limit_raw = request.args.get('limit')
        offset_raw = request.args.get('offset')
        limit = int(limit_raw) if limit_raw is not None else 50
        offset = int(offset_raw) if offset_raw is not None else 0
    except Exception:
        limit = 50
        offset = 0

    if limit <= 0:
        limit = 50
    if limit > 500:
        limit = 500
    if offset < 0:
        offset = 0

    conn = get_db_connection()
    if not conn:
        return jsonify([])

    cursor = None
    try:
        cursor = conn.cursor(dictionary=True)
        _ensure_prediction_logs_table(cursor)

        cursor.execute(
            """
            SELECT
                id,
                created_at,
                company_name as perusahaan,
                item_name as nama_barang,
                DATE_FORMAT(target_month, '%Y-%m-%d') as target_month,
                lead_time,
                service_level,
                algorithm,
                prediction,
                current_stock,
                needed_stock,
                safety_stock,
                reorder_point,
                reorder_needed,
                accuracy,
                mae,
                rmse,
                r2,
                mape
            FROM prediction_logs
            ORDER BY created_at DESC, id DESC
            LIMIT %s OFFSET %s
            """.strip(),
            (limit, offset)
        )
        rows = cursor.fetchall()
        for r in rows:
            if r.get('created_at') is not None:
                r['created_at'] = str(r['created_at'])
        return jsonify(rows)
    except Exception:
        return jsonify([])
    finally:
        if cursor:
            cursor.close()
        conn.close()

@app.route('/api/predictions-vs-actual', methods=['GET'])
def predictions_vs_actual():
    perusahaan = (request.args.get('perusahaan') or '').strip()
    nama_barang = (request.args.get('nama_barang') or '').strip()
    try:
        months = int(request.args.get('months', '12'))
    except Exception:
        months = 12
    if months <= 0:
        months = 12
    if months > 60:
        months = 60

    if not perusahaan or not nama_barang:
        return jsonify({"status": "error", "message": "perusahaan dan nama_barang wajib diisi"}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({"status": "error", "message": "Database connection failed"}), 500

    cursor = None
    try:
        cursor = conn.cursor(dictionary=True)
        _ensure_prediction_logs_table(cursor)
        _ensure_transactions_support_qty_in(cursor)

        cursor.execute(
            """
            SELECT
                DATE_FORMAT(date, '%Y-%m-01') as month,
                SUM(qty_out) as actual
            FROM transactions
            WHERE company_name = %s AND item_name = %s
            GROUP BY DATE_FORMAT(date, '%Y-%m-01')
            ORDER BY month ASC
            """.strip(),
            (perusahaan, nama_barang)
        )
        actual_rows = cursor.fetchall()
        actual_map = {str(r.get('month')): float(r.get('actual') or 0.0) for r in actual_rows if r.get('month')}

        cursor.execute(
            """
            SELECT
                DATE_FORMAT(target_month, '%Y-%m-01') as month,
                prediction,
                algorithm,
                created_at
            FROM prediction_logs
            WHERE company_name = %s AND item_name = %s AND target_month IS NOT NULL
            ORDER BY created_at DESC, id DESC
            """.strip(),
            (perusahaan, nama_barang)
        )
        pred_rows = cursor.fetchall()
        pred_map = {}
        algo_map = {}
        for r in pred_rows:
            m = r.get('month')
            if not m:
                continue
            key = str(m)
            if key in pred_map:
                continue
            pred_map[key] = float(r.get('prediction') or 0.0)
            algo_map[key] = (r.get('algorithm') or '') if r.get('algorithm') is not None else ''

        all_months = sorted(set(list(actual_map.keys()) + list(pred_map.keys())))
        if all_months:
            all_months = all_months[-months:]

        series = []
        for m in all_months:
            series.append({
                "month": m,
                "actual": actual_map.get(m),
                "predicted": pred_map.get(m),
                "algorithm": algo_map.get(m, '')
            })

        return jsonify({"status": "success", "perusahaan": perusahaan, "nama_barang": nama_barang, "series": series})
    except Error as e:
        return jsonify({"status": "error", "message": str(e)}), 500
    finally:
        if cursor:
            cursor.close()
        conn.close()

@app.route('/api/compare-algorithms', methods=['POST'])
def compare_algorithms():
    payload = request.json or {}
    perusahaan = (payload.get('perusahaan') or '').strip()
    nama_barang = (payload.get('nama_barang') or '').strip()
    if not perusahaan or not nama_barang:
        return jsonify({"status": "error", "message": "perusahaan dan nama_barang wajib diisi"}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({"status": "error", "message": "Database connection failed"}), 500

    cursor = None
    try:
        cursor = conn.cursor(dictionary=True)
        cursor.execute(
            "SELECT date, qty_out FROM transactions WHERE company_name = %s AND item_name = %s ORDER BY date ASC",
            (perusahaan, nama_barang)
        )
        rows = cursor.fetchall()
        month_totals = {}
        for r in rows:
            d = r.get('date')
            if isinstance(d, datetime):
                d = d.date()
            if not isinstance(d, date):
                continue
            m = _month_start(d)
            qty = int(r.get('qty_out') or 0)
            if qty < 0:
                qty = 0
            month_totals[m] = month_totals.get(m, 0) + qty

        months_sorted = sorted(month_totals.keys())
        series = []
        if months_sorted:
            start = months_sorted[0]
            end = months_sorted[-1]
            m = start
            while m <= end:
                series.append(float(month_totals.get(m, 0)))
                m = _add_months(m, 1)

        algos = ['moving_average', 'random_forest', 'xgboost', 'lstm']
        results = []
        for a in algos:
            results.append(_backtest_algorithm(series, a))

        return jsonify({"status": "success", "perusahaan": perusahaan, "nama_barang": nama_barang, "results": results, "history_points": len(series)})
    except Error as e:
        return jsonify({"status": "error", "message": str(e)}), 500
    finally:
        if cursor:
            cursor.close()
        conn.close()

@app.route('/api/history/bulk', methods=['POST'])
def bulk_history():
    auth_err = _require_auth()
    if auth_err:
        return auth_err

    payload = request.json or {}
    rows = payload.get('rows') or []
    apply_to_inventory = bool(payload.get('apply_to_inventory', False))

    if not isinstance(rows, list) or len(rows) == 0:
        return jsonify({"status": "error", "message": "rows wajib diisi (array)"}), 400
    if len(rows) > 5000:
        return jsonify({"status": "error", "message": "Maksimal 5000 baris per upload"}), 400

    parsed = []
    seen_upload = set()
    duplicate_in_file = 0

    def build_history_row_key(tanggal, perusahaan, barang, satuan, qty_out, qty_in, doc_number):
        doc = str(doc_number or '').strip()
        if doc:
            return ('doc', str(perusahaan or ''), str(barang or ''), doc)
        return (
            'legacy',
            str(tanggal or ''),
            str(perusahaan or ''),
            str(barang or ''),
            str(satuan or ''),
            int(qty_out or 0),
            int(qty_in or 0)
        )

    for r in rows:
        if not isinstance(r, dict):
            continue
        tanggal = _parse_iso_date(r.get('tanggal') or r.get('date') or r.get('tgl'))
        perusahaan = _norm_text(r.get('perusahaan') or r.get('company_name'))
        barang = _norm_text(r.get('nama_barang') or r.get('barang') or r.get('item_name'))
        satuan = _norm_text(r.get('satuan') or r.get('unit')) or None
        doc_number = _norm_text(r.get('doc_number') or r.get('nomor_dokumen') or r.get('nomor_transaksi') or r.get('document_number') or r.get('transaction_number')) or None
        qty_out = _safe_int(r.get('qty_out') or r.get('jumlah_keluar') or r.get('jumlah') or 0) or 0
        qty_in = _safe_int(r.get('qty_in') or r.get('jumlah_masuk') or 0) or 0

        if not tanggal or not perusahaan or not barang:
            continue
        if qty_out < 0:
            qty_out = 0
        if qty_in < 0:
            qty_in = 0
        if qty_out == 0 and qty_in == 0:
            continue

        row_key = build_history_row_key(tanggal[:10], perusahaan, barang, satuan or '', int(qty_out), int(qty_in), doc_number)
        if row_key in seen_upload:
            duplicate_in_file += 1
            continue
        seen_upload.add(row_key)
        parsed.append((tanggal[:10], perusahaan, barang, satuan, doc_number, int(qty_out), int(qty_in)))

    if not parsed:
        return jsonify({"status": "error", "message": "Tidak ada baris valid untuk diimpor"}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({"status": "error", "message": "Database connection failed"}), 500

    cursor = None
    cursor2 = None
    try:
        cursor = conn.cursor(dictionary=True)
        _ensure_transactions_support_qty_in(cursor)

        company_list = sorted({str(row[1]) for row in parsed if row[1]})
        date_list = sorted({str(row[0]) for row in parsed if row[0]})
        doc_number_list = sorted({str(row[4]).strip() for row in parsed if row[4]})
        existing_keys = set()
        if doc_number_list:
            doc_placeholders = ', '.join(['%s'] * len(doc_number_list))
            cursor.execute(
                f"""
                SELECT
                    DATE_FORMAT(date, '%Y-%m-%d') as tanggal,
                    company_name as perusahaan,
                    item_name as barang,
                    COALESCE(doc_number, '') as doc_number,
                    COALESCE(unit, '') as satuan,
                    qty_out,
                    COALESCE(qty_in, 0) as qty_in
                FROM transactions
                WHERE doc_number IN ({doc_placeholders})
                """.strip(),
                tuple(doc_number_list)
            )
            for row in cursor.fetchall():
                existing_keys.add((
                    build_history_row_key(
                        str(row.get('tanggal') or ''),
                        str(row.get('perusahaan') or ''),
                        str(row.get('barang') or ''),
                        str(row.get('satuan') or ''),
                        int(row.get('qty_out') or 0),
                        int(row.get('qty_in') or 0),
                        str(row.get('doc_number') or '')
                    )
                ))
        if company_list and date_list:
            min_date = min(date_list)
            max_date = max(date_list)
            company_placeholders = ', '.join(['%s'] * len(company_list))
            cursor.execute(
                f"""
                SELECT
                    DATE_FORMAT(date, '%Y-%m-%d') as tanggal,
                    company_name as perusahaan,
                    item_name as barang,
                    COALESCE(doc_number, '') as doc_number,
                    COALESCE(unit, '') as satuan,
                    qty_out,
                    COALESCE(qty_in, 0) as qty_in
                FROM transactions
                WHERE company_name IN ({company_placeholders})
                  AND date BETWEEN %s AND %s
                  AND (doc_number IS NULL OR doc_number = '')
                """.strip(),
                tuple(company_list + [min_date, max_date])
            )
            for row in cursor.fetchall():
                existing_keys.add((
                    build_history_row_key(
                        str(row.get('tanggal') or ''),
                        str(row.get('perusahaan') or ''),
                        str(row.get('barang') or ''),
                        str(row.get('satuan') or ''),
                        int(row.get('qty_out') or 0),
                        int(row.get('qty_in') or 0),
                        str(row.get('doc_number') or '')
                    )
                ))

        cursor2 = conn.cursor()
        for (tanggal, perusahaan, barang, satuan, doc_number, qty_out, qty_in) in parsed:
            cursor2.execute("INSERT IGNORE INTO companies (name, status) VALUES (%s, %s)", (perusahaan, 'Aktif'))
            cursor.execute(
                "SELECT id FROM inventory WHERE company_name = %s AND item_name = %s ORDER BY id ASC LIMIT 1",
                (perusahaan, barang)
            )
            inv_row = cursor.fetchone()
            if not inv_row:
                cursor2.execute(
                    "INSERT INTO inventory (company_name, item_name, unit, stock, location, status) VALUES (%s, %s, %s, %s, %s, %s)",
                    (perusahaan, barang, satuan or 'pcs', 0, 'A-01', 'Tidak Ada')
                )

        new_rows = []
        skipped_existing = 0
        for (tanggal, perusahaan, barang, satuan, doc_number, qty_out, qty_in) in parsed:
            row_key = build_history_row_key(tanggal, perusahaan, barang, satuan or '', int(qty_out), int(qty_in), doc_number)
            if row_key in existing_keys:
                skipped_existing += 1
                continue
            new_rows.append((tanggal, perusahaan, barang, satuan, doc_number, int(qty_out), int(qty_in)))

        if new_rows:
            cursor2.executemany(
                "INSERT INTO transactions (date, company_name, item_name, unit, doc_number, qty_out, qty_in) VALUES (%s, %s, %s, %s, %s, %s, %s)",
                new_rows
            )

        if apply_to_inventory:
            for (tanggal, perusahaan, barang, satuan, doc_number, qty_out, qty_in) in new_rows:
                cursor.execute(
                    "SELECT stock, unit, location, status FROM inventory WHERE company_name = %s AND item_name = %s",
                    (perusahaan, barang)
                )
                inv = cursor.fetchone()
                if not inv:
                    cursor2.execute(
                        "INSERT INTO inventory (company_name, item_name, unit, stock, location, status) VALUES (%s, %s, %s, %s, %s, %s)",
                        (perusahaan, barang, satuan or 'pcs', 0, 'A-01', 'Tidak Ada')
                    )
                    current_stock = 0
                else:
                    current_stock = int(inv.get('stock') or 0)

                new_stock = current_stock + int(qty_in) - int(qty_out)
                if new_stock < 0:
                    new_stock = 0
                new_status = 'Ada' if new_stock > 0 else 'Tidak Ada'
                cursor2.execute(
                    "UPDATE inventory SET stock = %s, status = %s, unit = COALESCE(%s, unit) WHERE company_name = %s AND item_name = %s",
                    (int(new_stock), new_status, satuan, perusahaan, barang)
                )

        conn.commit()
        return jsonify({
            "status": "success",
            "imported": len(new_rows),
            "skipped_existing": skipped_existing,
            "duplicate_in_file": duplicate_in_file,
            "apply_to_inventory": apply_to_inventory
        })
    except Error as e:
        return jsonify({"status": "error", "message": str(e)}), 500
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500
    finally:
        try:
            if cursor2:
                cursor2.close()
        except Exception:
            pass
        if cursor:
            cursor.close()
        conn.close()

@app.route('/api/inventory/bulk', methods=['POST'])
def bulk_inventory():
    auth_err = _require_auth()
    if auth_err:
        return auth_err

    payload = request.json or {}
    rows = payload.get('rows') or []

    if not isinstance(rows, list) or len(rows) == 0:
        return jsonify({"status": "error", "message": "rows wajib diisi (array)"}), 400
    if len(rows) > 5000:
        return jsonify({"status": "error", "message": "Maksimal 5000 baris per upload"}), 400

    parsed = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        perusahaan = (r.get('perusahaan') or r.get('company_name') or '').strip()
        barang = (r.get('nama_barang') or r.get('barang') or r.get('item_name') or '').strip()
        satuan = (r.get('satuan') or r.get('unit') or 'pcs').strip() or 'pcs'
        lokasi = (r.get('lokasi') or r.get('location') or 'A-01').strip() or 'A-01'
        stok = _safe_int(r.get('stok') or r.get('stock') or 0)

        if not perusahaan or not barang or stok is None:
            continue
        if stok < 0:
            stok = 0

        status = 'Ada' if int(stok) > 0 else 'Tidak Ada'
        parsed.append((perusahaan, barang, satuan, int(stok), lokasi, status))

    if not parsed:
        return jsonify({"status": "error", "message": "Tidak ada baris valid untuk diimpor"}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({"status": "error", "message": "Database connection failed"}), 500

    cursor = None
    cursor2 = None
    try:
        cursor = conn.cursor(dictionary=True)
        cursor2 = conn.cursor()

        for (perusahaan, barang, satuan, stok, lokasi, status) in parsed:
            cursor2.execute("INSERT IGNORE INTO companies (name, status) VALUES (%s, %s)", (perusahaan, 'Aktif'))
            cursor.execute(
                "SELECT id FROM inventory WHERE company_name = %s AND item_name = %s ORDER BY id ASC LIMIT 1",
                (perusahaan, barang)
            )
            existing = cursor.fetchone()
            if existing:
                cursor2.execute(
                    """
                    UPDATE inventory
                    SET unit = %s, stock = %s, location = %s, status = %s
                    WHERE id = %s
                    """.strip(),
                    (satuan, stok, lokasi, status, int(existing.get('id')))
                )
            else:
                cursor2.execute(
                    """
                    INSERT INTO inventory (company_name, item_name, unit, stock, location, status)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    """.strip(),
                    (perusahaan, barang, satuan, stok, lokasi, status)
                )

        conn.commit()
        return jsonify({"status": "success", "imported": len(parsed)})
    except Error as e:
        return jsonify({"status": "error", "message": str(e)}), 500
    finally:
        try:
            if cursor2:
                cursor2.close()
        except Exception:
            pass
        if cursor:
            cursor.close()
        conn.close()

@app.route('/api/work-orders', methods=['GET'])
def get_work_orders():
    try:
        limit_raw = request.args.get('limit')
        offset_raw = request.args.get('offset')
        limit = int(limit_raw) if limit_raw is not None else 100
        offset = int(offset_raw) if offset_raw is not None else 0
    except Exception:
        limit = 100
        offset = 0

    if limit <= 0:
        limit = 100
    if limit > 500:
        limit = 500
    if offset < 0:
        offset = 0

    conn = get_db_connection()
    if not conn:
        return jsonify([])

    cursor = None
    try:
        cursor = conn.cursor(dictionary=True)
        _ensure_work_orders_table(cursor)
        cursor.execute(
            """
            SELECT
                id,
                created_at,
                company_name as perusahaan,
                item_name as barang,
                DATE_FORMAT(target_month, '%Y-%m-%d') as target_month,
                planned_qty,
                unit,
                status,
                DATE_FORMAT(due_date, '%Y-%m-%d') as due_date
            FROM work_orders
            ORDER BY created_at DESC, id DESC
            LIMIT %s OFFSET %s
            """.strip(),
            (limit, offset)
        )
        rows = cursor.fetchall()
        for r in rows:
            if r.get('created_at') is not None:
                r['created_at'] = str(r['created_at'])
        return jsonify(rows)
    except Exception:
        return jsonify([])
    finally:
        if cursor:
            cursor.close()
        conn.close()

@app.route('/api/work-orders/<int:wo_id>', methods=['GET'])
def get_work_order_detail(wo_id: int):
    conn = get_db_connection()
    if not conn:
        return jsonify({"status": "error", "message": "Database connection failed"}), 500

    cursor = None
    try:
        cursor = conn.cursor(dictionary=True)
        _ensure_work_orders_table(cursor)
        cursor.execute(
            """
            SELECT
                id,
                created_at,
                company_name as perusahaan,
                item_name as barang,
                DATE_FORMAT(target_month, '%Y-%m-%d') as target_month,
                planned_qty,
                unit,
                lead_time,
                service_level,
                prediction_log_id,
                status,
                DATE_FORMAT(due_date, '%Y-%m-%d') as due_date,
                notes,
                instructions
            FROM work_orders
            WHERE id = %s
            """.strip(),
            (wo_id,)
        )
        row = cursor.fetchone()
        if not row:
            return jsonify({"status": "error", "message": "Work order tidak ditemukan"}), 404
        if row.get('created_at') is not None:
            row['created_at'] = str(row['created_at'])
        return jsonify({"status": "success", "work_order": row})
    except Error as e:
        return jsonify({"status": "error", "message": str(e)}), 500
    finally:
        if cursor:
            cursor.close()
        conn.close()

@app.route('/api/work-orders', methods=['POST'])
def create_work_order():
    auth_err = _require_auth()
    if auth_err:
        return auth_err

    payload = request.json or {}
    perusahaan = (payload.get('perusahaan') or payload.get('company_name') or '').strip()
    barang = (payload.get('barang') or payload.get('item_name') or '').strip()
    unit = (payload.get('unit') or payload.get('satuan') or '').strip()
    notes = (payload.get('notes') or payload.get('catatan') or '').strip()

    planned_qty = _safe_int(payload.get('planned_qty'))
    if planned_qty is None:
        planned_qty = _safe_int(payload.get('qty'))

    if not perusahaan or not barang:
        return jsonify({"status": "error", "message": "perusahaan dan barang wajib diisi"}), 400
    if planned_qty is None or planned_qty <= 0:
        return jsonify({"status": "error", "message": "planned_qty harus lebih dari 0"}), 400

    target_month_iso = _parse_iso_date(payload.get('target_month'))
    due_date_iso = _parse_iso_date(payload.get('due_date'))

    lead_time = _safe_int(payload.get('lead_time'))
    service_level = _safe_float(payload.get('service_level'))
    prediction_log_id = _safe_int(payload.get('prediction_log_id'))

    status_val = _normalize_work_order_status(payload.get('status')) or 'Draft'

    instructions = _build_work_order_instructions(
        company_name=perusahaan,
        item_name=barang,
        planned_qty=int(planned_qty),
        unit=unit,
        target_month_iso=target_month_iso,
        due_date_iso=due_date_iso
    )

    conn = get_db_connection()
    if not conn:
        return jsonify({"status": "error", "message": "Database connection failed"}), 500

    cursor = None
    try:
        cursor = conn.cursor()
        _ensure_work_orders_table(cursor)
        cursor.execute(
            """
            INSERT INTO work_orders
                (company_name, item_name, target_month, planned_qty, unit, lead_time, service_level, prediction_log_id, status, due_date, notes, instructions)
            VALUES
                (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """.strip(),
            (
                perusahaan,
                barang,
                target_month_iso[:10] if target_month_iso else None,
                int(planned_qty),
                unit if unit else None,
                int(lead_time) if lead_time is not None else None,
                float(service_level) if service_level is not None else None,
                int(prediction_log_id) if prediction_log_id is not None else None,
                status_val,
                due_date_iso[:10] if due_date_iso else None,
                notes if notes else None,
                instructions
            )
        )
        wo_id = cursor.lastrowid
        conn.commit()
        return jsonify({"status": "success", "id": wo_id, "instructions": instructions})
    except Error as e:
        return jsonify({"status": "error", "message": str(e)}), 500
    finally:
        if cursor:
            cursor.close()
        conn.close()

@app.route('/api/work-orders/<int:wo_id>', methods=['PATCH'])
def update_work_order(wo_id: int):
    auth_err = _require_auth()
    if auth_err:
        return auth_err

    payload = request.json or {}
    status_val = _normalize_work_order_status(payload.get('status'))
    due_date_iso = _parse_iso_date(payload.get('due_date'))
    notes = payload.get('notes')
    if isinstance(notes, str):
        notes = notes.strip()

    updates = []
    params = []
    if status_val:
        updates.append("status = %s")
        params.append(status_val)
    if due_date_iso is not None:
        updates.append("due_date = %s")
        params.append(due_date_iso[:10] if due_date_iso else None)
    if notes is not None:
        updates.append("notes = %s")
        params.append(notes if notes else None)

    if not updates:
        return jsonify({"status": "error", "message": "Tidak ada field yang diupdate"}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({"status": "error", "message": "Database connection failed"}), 500

    cursor = None
    try:
        cursor = conn.cursor(dictionary=True)
        _ensure_work_orders_table(cursor)
        cursor.execute(
            "SELECT company_name, item_name, planned_qty, unit, DATE_FORMAT(target_month, '%Y-%m-%d') as target_month FROM work_orders WHERE id = %s",
            (wo_id,)
        )
        base = cursor.fetchone()
        if not base:
            return jsonify({"status": "error", "message": "Work order tidak ditemukan"}), 404

        cursor2 = conn.cursor()
        cursor2.execute(
            f"UPDATE work_orders SET {', '.join(updates)} WHERE id = %s",
            tuple(params + [wo_id])
        )
        if cursor2.rowcount <= 0:
            cursor2.close()
            return jsonify({"status": "error", "message": "Work order tidak ditemukan"}), 404
        cursor2.close()

        cursor.execute(
            "SELECT DATE_FORMAT(due_date, '%Y-%m-%d') as due_date FROM work_orders WHERE id = %s",
            (wo_id,)
        )
        after = cursor.fetchone() or {}
        due_date_after = after.get('due_date')

        instructions = _build_work_order_instructions(
            company_name=base.get('company_name') or '',
            item_name=base.get('item_name') or '',
            planned_qty=int(base.get('planned_qty') or 0),
            unit=base.get('unit') or '',
            target_month_iso=base.get('target_month'),
            due_date_iso=due_date_after
        )
        cursor2 = conn.cursor()
        cursor2.execute("UPDATE work_orders SET instructions = %s WHERE id = %s", (instructions, wo_id))
        cursor2.close()

        conn.commit()
        return jsonify({"status": "success", "id": wo_id, "instructions": instructions})
    except Error as e:
        return jsonify({"status": "error", "message": str(e)}), 500
    finally:
        if cursor:
            cursor.close()
        conn.close()

@app.route('/api/restock', methods=['GET'])
def get_restock_list():
    try:
        lead_time = int(request.args.get('lead_time', '3'))
    except Exception:
        lead_time = 3

    try:
        service_level = float(request.args.get('service_level', '0.95'))
    except Exception:
        service_level = 0.95

    if lead_time <= 0:
        lead_time = 1

    conn = get_db_connection()
    if not conn:
        return jsonify({"status": "error", "message": "Database connection failed"}), 500

    cursor = None
    try:
        cursor = conn.cursor(dictionary=True)

        cursor.execute(
            "SELECT company_name, item_name, unit, stock, location, status FROM inventory"
        )
        inventory_rows = cursor.fetchall()

        cursor.execute(
            "SELECT company_name, item_name, date, qty_out FROM transactions ORDER BY date ASC"
        )
        trx_rows = cursor.fetchall()

        grouped = {}
        for r in trx_rows:
            company = r.get('company_name')
            item = r.get('item_name')
            if not company or not item:
                continue

            d = r.get('date')
            if isinstance(d, datetime):
                d = d.date()
            if not isinstance(d, date):
                continue

            qty = int(r.get('qty_out') or 0)
            if qty < 0:
                qty = 0

            key = (company, item)
            g = grouped.get(key)
            if g is None:
                g = {"day_totals": {}, "min_day": d, "max_day": d}
                grouped[key] = g

            if d < g["min_day"]:
                g["min_day"] = d
            if d > g["max_day"]:
                g["max_day"] = d

            day_totals = g["day_totals"]
            day_totals[d] = day_totals.get(d, 0) + qty

        z = get_z_score(service_level)
        result = []
        for inv in inventory_rows:
            company = inv.get('company_name') or ''
            item = inv.get('item_name') or ''
            unit = inv.get('unit') or ''
            lokasi = inv.get('location') or ''
            status = inv.get('status') or ''
            current_stock = int(inv.get('stock') or 0)

            g = grouped.get((company, item))
            daily_values = []
            if g:
                cur = g["min_day"]
                while cur <= g["max_day"]:
                    daily_values.append(float(g["day_totals"].get(cur, 0)))
                    cur = cur + timedelta(days=1)

            avg_demand = float(sum(daily_values) / len(daily_values)) if daily_values else 0.0
            std_demand = float(_sample_std(daily_values))
            safety_stock = int(max(0, round(z * std_demand * math.sqrt(float(lead_time)))))
            reorder_point = int(max(0, round(avg_demand * float(lead_time) + float(safety_stock))))
            reorder_needed = bool(current_stock <= reorder_point) or bool(status == 'Tidak Ada') or bool(current_stock <= 0)

            if reorder_needed:
                result.append({
                    "perusahaan": company,
                    "barang": item,
                    "unit": unit,
                    "lokasi": lokasi,
                    "stok": current_stock,
                    "safety_stock": safety_stock,
                    "reorder_point": reorder_point,
                    "reorder_needed": True,
                    "cold_start": len(daily_values) < 2,
                    "lead_time": lead_time,
                    "service_level": service_level
                })

        result.sort(key=lambda x: (x.get("perusahaan", ""), x.get("barang", "")))
        return jsonify(result)
    except Error as e:
        return jsonify({"status": "error", "message": str(e)}), 500
    finally:
        if cursor:
            cursor.close()
        conn.close()

@app.route('/api/login', methods=['POST'])
def login():
    payload = request.json or {}
    username = (payload.get('username') or '').strip()
    password = (payload.get('password') or '').strip()

    admin_user = os.environ.get('ADMIN_USER', 'admin')
    admin_pass = os.environ.get('ADMIN_PASSWORD', 'admin123')

    if username == admin_user and password == admin_pass:
        token = _issue_token(username)
        return jsonify({"status": "success", "token": token})

    return jsonify({"status": "error", "message": "Username atau password salah"}), 401

if __name__ == '__main__':
    port = int(os.environ.get('PORT', '8000'))
    app.run(host='0.0.0.0', port=port, debug=False, use_reloader=False)
