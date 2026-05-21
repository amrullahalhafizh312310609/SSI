import pandas as pd
import mysql.connector
import os

# Konfigurasi Database (Sesuaikan dengan MySQL Anda)
db_config = {
    'host': 'localhost',
    'user': 'root',
    'password': '',
    'database': 'gudang_db'
}

EXCEL_FILE = 'stok_perusahaan.xlsx'

def migrate():
    if not os.path.exists(EXCEL_FILE):
        print("File Excel tidak ditemukan.")
        return

    try:
        # Hubungkan ke MySQL
        conn = mysql.connector.connect(**db_config)
        cursor = conn.cursor()
        print("Terhubung ke MySQL.")

        # 1. Migrasi Data Perusahaan
        print("Memindahkan data perusahaan...")
        df_comp = pd.read_excel(EXCEL_FILE, sheet_name='Database Perusahaan')
        for _, row in df_comp.iterrows():
            cursor.execute(
                "INSERT IGNORE INTO companies (name, status) VALUES (%s, %s)",
                (row['Nama Perusahaan'], row['Status'])
            )

        # 2. Migrasi Data Inventori
        print("Memindahkan data inventori...")
        df_inv = pd.read_excel(EXCEL_FILE, sheet_name='Database Master Barang')
        for _, row in df_inv.iterrows():
            cursor.execute(
                "INSERT INTO inventory (company_name, item_name, unit, stock, location, status) VALUES (%s, %s, %s, %s, %s, %s)",
                (row['Perusahaan'], row['Barang'], row['Satuan'], row['Stok'], row['Lokasi'], row['Status'])
            )

        # 3. Migrasi Data Riwayat
        print("Memindahkan data riwayat transaksi...")
        df_hist = pd.read_excel(EXCEL_FILE, sheet_name='Riwayat Transaksi')
        for _, row in df_hist.iterrows():
            cursor.execute(
                "INSERT INTO transactions (date, company_name, item_name, unit, qty_out) VALUES (%s, %s, %s, %s, %s)",
                (row['Tanggal'], row['Perusahaan'], row['Nama Barang'], row['Satuan'], row['Jumlah Keluar'])
            )

        conn.commit()
        print("Migrasi Berhasil Selesai!")

    except mysql.connector.Error as err:
        print(f"Error: {err}")
    finally:
        if conn.is_connected():
            cursor.close()
            conn.close()

if __name__ == "__main__":
    migrate()
