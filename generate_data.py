import argparse
import os
import random
from datetime import date, datetime, timedelta

import mysql.connector


def _get_conn():
    try:
        timeout = int(os.environ.get("DB_CONNECT_TIMEOUT", "1"))
    except Exception:
        timeout = 3
    if timeout <= 0:
        timeout = 3
    return mysql.connector.connect(
        def _get_conn():
    return mysql.connector.connect(
        host=os.environ.get("DB_HOST", "localhost"),
        port=int(os.environ.get("DB_PORT", "3306")),
        user=os.environ.get("DB_USER", "root"),
        password=os.environ.get("DB_PASSWORD", ""),
        database=os.environ.get("DB_NAME", "gudang_db"),
    )
        connection_timeout=timeout,
        read_timeout=timeout,
        write_timeout=timeout,
    )


def _month_start(d: date) -> date:
    return date(d.year, d.month, 1)


def _add_months(d: date, months: int) -> date:
    year = d.year + (d.month - 1 + months) // 12
    month = (d.month - 1 + months) % 12 + 1
    return date(year, month, 1)


def _has_column(cursor, table: str, column: str) -> bool:
    cursor.execute(f"SHOW COLUMNS FROM {table} LIKE %s", (column,))
    return cursor.fetchone() is not None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--months", type=int, default=12)
    parser.add_argument("--tx-per-month", type=int, default=10)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--start-month", type=str, default="")
    parser.add_argument("--no-reset", action="store_true")
    parser.add_argument("--no-purge-test-companies", action="store_true")
    parser.add_argument(
        "--purge-companies",
        type=str,
        default="PT. APA SAJA,PT. APIS SEJAHTERA",
        help="Daftar nama perusahaan dipisah koma yang akan dihapus dari companies/inventory sebelum generate (default: perusahaan test).",
    )
    parser.add_argument("--noise-pct", type=float, default=0.05)
    parser.add_argument("--slope-min", type=int, default=40)
    parser.add_argument("--slope-max", type=int, default=90)
    args = parser.parse_args()

    random.seed(args.seed)

    if args.months < 1:
        raise SystemExit("--months minimal 1")
    if args.tx_per_month < 1:
        raise SystemExit("--tx-per-month minimal 1")

    today = date.today()
    if args.start_month:
        base = datetime.strptime(args.start_month[:10], "%Y-%m-%d").date()
        start_month = _month_start(base)
    else:
        start_month = _add_months(_month_start(today), -int(args.months) + 1)

    conn = _get_conn()
    cursor = conn.cursor(dictionary=True)

    reset = not bool(args.no_reset)
    purge_test_companies = not bool(args.no_purge_test_companies)
    purge_companies = [s.strip() for s in str(args.purge_companies or "").split(",") if s.strip()]

    cursor.execute("SELECT company_name, item_name, unit FROM inventory")
    items = cursor.fetchall()
    if not items:
        cursor.close()
        conn.close()
        raise SystemExit("Tabel inventory kosong. Isi inventory dulu sebelum generate data.")

    has_qty_in = _has_column(cursor, "transactions", "qty_in")
    if not has_qty_in:
        try:
            cursor.execute("ALTER TABLE transactions ADD COLUMN qty_in INT NOT NULL DEFAULT 0")
            has_qty_in = True
        except Exception:
            has_qty_in = False
    try:
        cursor.execute("ALTER TABLE transactions MODIFY COLUMN qty_out INT NOT NULL DEFAULT 0")
    except Exception:
        pass

    if purge_test_companies and purge_companies:
        placeholders = ",".join(["%s"] * len(purge_companies))
        try:
            cursor.execute(f"DELETE FROM inventory WHERE company_name IN ({placeholders})", tuple(purge_companies))
            cursor.execute(f"DELETE FROM companies WHERE name IN ({placeholders})", tuple(purge_companies))
            conn.commit()
        except Exception:
            pass

    if reset:
        try:
            cursor.execute("DELETE FROM prediction_logs")
        except Exception:
            pass
        try:
            cursor.execute("DELETE FROM transactions")
        except Exception:
            pass
        conn.commit()

    cursor.execute("SELECT company_name, item_name, unit FROM inventory")
    items = cursor.fetchall()
    if not items:
        cursor.close()
        conn.close()
        raise SystemExit("Tabel inventory kosong (setelah purge). Isi inventory dulu sebelum generate data.")

    rows = []
    for it in items:
        company = it["company_name"]
        item = it["item_name"]
        unit = it.get("unit") or "pcs"

        base_monthly = random.randint(180, 520)
        slope_min = int(args.slope_min)
        slope_max = int(args.slope_max)
        if slope_max < slope_min:
            slope_max = slope_min
        slope = random.randint(slope_min, slope_max)
        noise_pct = float(args.noise_pct)
        if noise_pct < 0:
            noise_pct = 0.0
        noise = max(5, int(round(base_monthly * noise_pct)))

        for mi in range(int(args.months)):
            m0 = _add_months(start_month, mi)
            m1 = _add_months(m0, 1)
            month_total = max(0, base_monthly + slope * mi + random.randint(-noise, noise))
            tx_count = int(args.tx_per_month)
            parts = []
            remain = month_total
            for i in range(tx_count):
                if i == tx_count - 1:
                    q = remain
                else:
                    max_piece = max(0, int(round(remain / (tx_count - i))))
                    q = random.randint(0, max_piece)
                parts.append(q)
                remain -= q
            random.shuffle(parts)

            for q in parts:
                if q <= 0:
                    continue
                span_days = (m1 - m0).days
                d = m0 + timedelta(days=random.randint(0, max(0, span_days - 1)))
                if has_qty_in:
                    rows.append((d, company, item, unit, int(q), 0))
                else:
                    rows.append((d, company, item, unit, int(q)))

    if not rows:
        cursor.close()
        conn.close()
        raise SystemExit("Tidak ada baris yang akan di-insert.")

    if has_qty_in:
        cursor.executemany(
            "INSERT INTO transactions (date, company_name, item_name, unit, qty_out, qty_in) VALUES (%s, %s, %s, %s, %s, %s)",
            rows,
        )
    else:
        cursor.executemany(
            "INSERT INTO transactions (date, company_name, item_name, unit, qty_out) VALUES (%s, %s, %s, %s, %s)",
            rows,
        )

    conn.commit()
    inserted = cursor.rowcount
    cursor.close()
    conn.close()
    print(f"Inserted {inserted} rows into transactions for {len(items)} items ({args.months} months).")


if __name__ == "__main__":
    main()
