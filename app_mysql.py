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
except Exception:
    train_test_split = None
    mean_absolute_error = None
    mean_squared_error = None
    r2_score = None

app = Flask(__name__, static_folder='static')
CORS(app) # Mengizinkan akses dari domain lain (seperti GitHub Pages)

# Konfigurasi Database MySQL
try:
    _DB_CONNECT_TIMEOUT = int(os.environ.get('DB_CONNECT_TIMEOUT', '1'))
except Exception:
    _DB_CONNECT_TIMEOUT = 3

if _DB_CONNECT_TIMEOUT <= 0:
    _DB_CONNECT_TIMEOUT = 3

DB_CONFIG = {
    'host': os.environ.get('DB_HOST', 'localhost'),
    'user': os.environ.get('DB_USER', 'root'),
    'password': os.environ.get('DB_PASSWORD', ''),
    'database': os.environ.get('DB_NAME', 'gudang_db'),
    'connection_timeout': _DB_CONNECT_TIMEOUT,
    'read_timeout': _DB_CONNECT_TIMEOUT,
    'write_timeout': _DB_CONNECT_TIMEOUT
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

def _ensure_transactions_support_qty_in(cursor):
    try:
        if not _has_column(cursor, "transactions", "qty_in"):
            cursor.execute("ALTER TABLE transactions ADD COLUMN qty_in INT NOT NULL DEFAULT 0")
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
                prediction INT NOT NULL,
                current_stock INT NOT NULL,
                needed_stock INT NOT NULL,
                safety_stock INT NOT NULL,
                reorder_point INT NOT NULL,
                reorder_needed TINYINT(1) NOT NULL,
                accuracy DOUBLE NULL,
                mae DOUBLE NULL,
                rmse DOUBLE NULL,
                r2 DOUBLE NULL
            )
            """.strip()
        )
        if not _has_column(cursor, "prediction_logs", "accuracy"):
            cursor.execute("ALTER TABLE prediction_logs ADD COLUMN accuracy DOUBLE NULL")
    except Exception:
        return

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

def _mae(y_true, y_pred):
    if not y_true:
        return 0.0
    return sum(abs(a - b) for a, b in zip(y_true, y_pred)) / len(y_true)

def _rmse(y_true, y_pred):
    if not y_true:
        return 0.0
    return math.sqrt(sum((a - b) ** 2 for a, b in zip(y_true, y_pred)) / len(y_true))

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
        return {"mae": 0.0, "rmse": 0.0, "r2": 0.0, "accuracy": 0.0}
    accuracy_val = _tolerance_accuracy(y_true, y_pred, tolerance=0.20)
    if mean_absolute_error and mean_squared_error and r2_score:
        try:
            mae_val = float(mean_absolute_error(y_true, y_pred))
            mse_val = float(mean_squared_error(y_true, y_pred))
            rmse_val = float(math.sqrt(mse_val))
            r2_val = float(r2_score(y_true, y_pred))
            if r2_val < -1.0:
                r2_val = -1.0
            return {"mae": mae_val, "rmse": rmse_val, "r2": r2_val, "accuracy": accuracy_val}
        except Exception:
            pass
    return {
        "mae": _mae(y_true, y_pred),
        "rmse": _rmse(y_true, y_pred),
        "r2": _r2(y_true, y_pred),
        "accuracy": accuracy_val
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
    perusahaan = (payload.get('perusahaan') or '').strip()
    barang = (payload.get('barang') or '').strip()
    satuan = (payload.get('satuan') or 'pcs').strip()
    lokasi = (payload.get('lokasi') or 'A-01').strip()

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
        perusahaan = entry.get('perusahaan')
        barang = entry.get('nama_barang')
        jumlah_keluar = int(entry.get('jumlah_terjual', 0))

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
            query_hist = "INSERT INTO transactions (date, company_name, item_name, unit, qty_out, qty_in) VALUES (%s, %s, %s, %s, %s, %s)"
            cursor.execute(query_hist, (
                entry.get('tanggal'), perusahaan, barang,
                entry.get('satuan'), jumlah_keluar, 0
            ))
        else:
            query_hist = "INSERT INTO transactions (date, company_name, item_name, unit, qty_out) VALUES (%s, %s, %s, %s, %s)"
            cursor.execute(query_hist, (
                entry.get('tanggal'), perusahaan, barang,
                entry.get('satuan'), jumlah_keluar
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
    perusahaan = payload.get('perusahaan')
    barang = payload.get('nama_barang')
    satuan = payload.get('satuan') or 'pcs'
    tanggal = payload.get('tanggal')
    qty_in = _safe_int(payload.get('qty_in', 0)) or 0

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
                "INSERT INTO transactions (date, company_name, item_name, unit, qty_out, qty_in) VALUES (%s, %s, %s, %s, %s, %s)",
                (tanggal, perusahaan, barang, satuan, 0, qty_in)
            )
        else:
            cursor.execute(
                "INSERT INTO transactions (date, company_name, item_name, unit, qty_out) VALUES (%s, %s, %s, %s, %s)",
                (tanggal, perusahaan, barang, satuan, 0)
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
    perusahaan = payload.get('perusahaan')
    nama_barang = payload.get('nama_barang')
    target_date_raw = payload.get('target_date')

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
            metrics = {"mae": 0.0, "rmse": 0.0, "r2": 0.0, "accuracy": 0.0}
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
            m_full, b_full = simple_linear_regression(xs_all, ys_all)
            if n < 3:
                eval_mode = "none"
                metrics = {"mae": 0.0, "rmse": 0.0, "r2": 0.0, "accuracy": 0.0}
            else:
                eval_mode = "in_sample_all"
                y_pred_all = [m_full * x + b_full for x in xs_all]
                metrics = calculate_metrics(ys_all, y_pred_all)

            target_index = _month_diff(first_month, target_month) + 1
            if target_index < 1:
                target_index = 1

            prediction_raw = m_full * float(target_index) + b_full
            prediction = int(max(0, round(prediction_raw)))

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
                    (company_name, item_name, target_month, lead_time, service_level, prediction, current_stock, needed_stock,
                     safety_stock, reorder_point, reorder_needed, accuracy, mae, rmse, r2)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """.strip(),
                (
                    perusahaan, nama_barang, target_month_iso[:10] if target_month_iso else None,
                    int(lead_time), float(service_level), int(prediction), int(current_stock), int(needed_stock),
                    int(safety_stock), int(reorder_point), 1 if reorder_needed else 0,
                    _safe_float(metrics.get("accuracy")),
                    _safe_float(metrics.get("mae")), _safe_float(metrics.get("rmse")), _safe_float(metrics.get("r2"))
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
            "metrics": metrics,
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
                prediction,
                current_stock,
                needed_stock,
                safety_stock,
                reorder_point,
                reorder_needed,
                accuracy,
                mae,
                rmse,
                r2
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
