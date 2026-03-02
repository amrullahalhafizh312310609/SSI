from flask import Flask, render_template, request, jsonify
import pandas as pd
from sklearn.linear_model import LinearRegression
from sklearn.preprocessing import OneHotEncoder
from sklearn.compose import ColumnTransformer
from sklearn.pipeline import Pipeline
import numpy as np
from datetime import datetime, timedelta
import sqlite3
import os

app = Flask(__name__)

# Ensure data directory exists
if not os.path.exists('data'):
    os.makedirs('data')

# Load and preprocess data for ML model
def load_and_train():
    data = pd.read_csv('data/stock_data.csv')
    data['tanggal'] = pd.to_datetime(data['tanggal'])
    data['hari_ke'] = data['tanggal'].dt.dayofyear

    X = data[['perusahaan', 'nama_barang', 'satuan', 'hari_ke']]
    y = data['jumlah_terjual']

    # Define preprocessing
    categorical_features = ['perusahaan', 'nama_barang', 'satuan']
    preprocessor = ColumnTransformer(
        transformers=[
            ('cat', OneHotEncoder(handle_unknown='ignore'), categorical_features)],
        remainder='passthrough')

    # Create and train pipeline
    model = Pipeline(steps=[('preprocessor', preprocessor),
                          ('regressor', LinearRegression())])
    model.fit(X, y)
    return model, data

model, data_raw = load_and_train()

# Database Initialization
def init_db():
    conn = sqlite3.connect('data/inventory.db')
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS inventory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            perusahaan TEXT NOT NULL,
            barang TEXT NOT NULL,
            satuan TEXT NOT NULL,
            stok INTEGER DEFAULT 0,
            status TEXT DEFAULT 'Ada',
            lokasi TEXT DEFAULT 'Belum Ditentukan'
        )
    ''')
    
    # Check if table is empty, if so, populate with initial dummy data
    cursor.execute('SELECT COUNT(*) FROM inventory')
    if cursor.fetchone()[0] == 0:
        initial_data = [
            ("PT. DASA WINDU AGUNG", "150 x 860 x 0.08", "roll", 1200, "Ada", "A-01"),
            ("PT. DASA WINDU AGUNG", "150 x 1070 x 0.08", "roll", 0, "Tidak Ada", "A-02"),
            ("PT. DASA WINDU AGUNG", "325 x 440 x 0.08", "roll", 800, "Ada", "A-03"),
            ("PT. DASA WINDU AGUNG", "Bahan Baku", "kg", 5000, "Ada", "B-01"),
            ("PT. LOGISTIK MAJU", "Pallet Plastik", "pcs", 150, "Ada", "C-01"),
            ("PT. BERKAH JAYA", "Kardus A1", "pcs", 3000, "Ada", "D-01"),
        ]
        cursor.executemany('''
            INSERT INTO inventory (perusahaan, barang, satuan, stok, status, lokasi)
            VALUES (?, ?, ?, ?, ?, ?)
        ''', initial_data)
        conn.commit()
    conn.close()

init_db()

def get_db_connection():
    conn = sqlite3.connect('data/inventory.db')
    conn.row_factory = sqlite3.Row
    return conn

def get_all_companies():
    # Companies from CSV
    csv_companies = data_raw['perusahaan'].unique().tolist()
    
    # Companies from Database
    conn = get_db_connection()
    db_companies = [row['perusahaan'] for row in conn.execute('SELECT DISTINCT perusahaan FROM inventory').fetchall()]
    conn.close()
    
    # Merge and Sort
    return sorted(list(set(csv_companies + db_companies)))

@app.route('/')
def index():
    return render_template('index.html', companies=get_all_companies())

@app.route('/get_items', methods=['POST'])
def get_items():
    company = request.get_json()['perusahaan']
    # Get items from CSV
    items_csv = data_raw[data_raw['perusahaan'] == company][['nama_barang', 'satuan']].drop_duplicates().to_dict('records')
    
    # Get items from database
    conn = get_db_connection()
    db_items = conn.execute('SELECT barang as nama_barang, satuan FROM inventory WHERE perusahaan = ?', (company,)).fetchall()
    items_inv = [dict(row) for row in db_items]
    conn.close()
    
    # Merge and unique
    seen = set()
    combined_items = []
    for item in items_csv + items_inv:
        if item['nama_barang'] not in seen:
            seen.add(item['nama_barang'])
            combined_items.append(item)
            
    return jsonify({'items': combined_items})

@app.route('/get_inventory', methods=['GET'])
def get_inventory():
    conn = get_db_connection()
    inventory = [dict(row) for row in conn.execute('SELECT * FROM inventory').fetchall()]
    conn.close()
    return jsonify(inventory)

@app.route('/add_inventory', methods=['POST'])
def add_inventory():
    req = request.get_json()
    perusahaan = req['perusahaan']
    barang = req['barang']
    satuan = req['satuan']
    stok = int(req['stok'])
    status = "Ada" if stok > 0 else "Tidak Ada"
    lokasi = req['lokasi']
    
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute('''
        INSERT INTO inventory (perusahaan, barang, satuan, stok, status, lokasi)
        VALUES (?, ?, ?, ?, ?, ?)
    ''', (perusahaan, barang, satuan, stok, status, lokasi))
    conn.commit()
    new_id = cursor.lastrowid
    conn.close()
    
    return jsonify({"success": True, "id": new_id})

@app.route('/update_inventory_status', methods=['POST'])
def update_inventory_status():
    req = request.get_json()
    item_id = req['id']
    new_status = req['status']
    
    conn = get_db_connection()
    if new_status == "Tidak Ada":
        conn.execute('UPDATE inventory SET status = ?, stok = 0 WHERE id = ?', (new_status, item_id))
    else:
        conn.execute('UPDATE inventory SET status = ? WHERE id = ?', (new_status, item_id))
    conn.commit()
    conn.close()
    return jsonify({"success": True})

@app.route('/update_stock', methods=['POST'])
def update_stock():
    req = request.get_json()
    item_id = req['id']
    new_stok = int(req['stok'])
    status = "Ada" if new_stok > 0 else "Tidak Ada"
    
    conn = get_db_connection()
    conn.execute('UPDATE inventory SET stok = ?, status = ? WHERE id = ?', (new_stok, status, item_id))
    conn.commit()
    conn.close()
    return jsonify({"success": True})

@app.route('/update_layout', methods=['POST'])
def update_layout():
    req = request.get_json()
    item_id = req['id']
    new_lokasi = req['lokasi']
    
    conn = get_db_connection()
    conn.execute('UPDATE inventory SET lokasi = ? WHERE id = ?', (new_lokasi, item_id))
    conn.commit()
    conn.close()
    return jsonify({"success": True})

@app.route('/predict', methods=['POST'])
def predict():
    req_data = request.get_json()
    perusahaan = req_data['perusahaan']
    nama_barang = req_data['nama_barang']
    satuan = req_data['satuan']
    tanggal = pd.to_datetime(req_data['tanggal'])
    hari_ke = tanggal.dayofyear

    # Create a DataFrame for prediction
    prediction_data = pd.DataFrame({
        'perusahaan': [perusahaan],
        'nama_barang': [nama_barang],
        'satuan': [satuan],
        'hari_ke': [hari_ke]
    })

    # Make prediction
    prediction = model.predict(prediction_data)
    result = max(0, round(prediction[0]))

    # Get current stock from database (case-insensitive and trimmed)
    conn = get_db_connection()
    row = conn.execute('''
        SELECT id, stok, lokasi FROM inventory 
        WHERE UPPER(TRIM(perusahaan)) = UPPER(TRIM(?)) 
        AND UPPER(TRIM(barang)) = UPPER(TRIM(?))
    ''', (perusahaan, nama_barang)).fetchone()
    conn.close()
    
    if row:
        current_stock = row['stok']
        lokasi = row['lokasi']
        item_id = row['id']
    else:
        current_stock = 0
        lokasi = "Belum Ditentukan"
        item_id = None
    
    # Calculate needed stock
    needed_stock = max(0, result - current_stock)

    return jsonify({
        'prediction': result,
        'current_stock': current_stock,
        'needed_stock': needed_stock,
        'satuan': satuan,
        'lokasi': lokasi,
        'item_id': item_id
    })

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
