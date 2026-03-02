
let currentPredictItemId = null;

document.addEventListener('DOMContentLoaded', () => {
    const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    document.getElementById('current-date').innerText = new Date().toLocaleDateString('id-ID', options);
    showSection('dashboard');
});

function showSection(sectionId) {
    document.querySelectorAll('.app-section').forEach(s => s.style.display = 'none');
    document.getElementById(`section-${sectionId}`).style.display = 'block';
    
    document.querySelectorAll('.sidebar-nav li').forEach(li => li.classList.remove('active'));
    document.getElementById(`nav-${sectionId}`).classList.add('active');

    if (sectionId === 'inventory') fetchInventory();
}

async function updateItems() {
    const perusahaan = document.getElementById('perusahaan').value;
    const itemSelect = document.getElementById('nama_barang');
    const unitSelect = document.getElementById('satuan');
    
    if (!perusahaan) return;
    
    itemSelect.innerHTML = '<option disabled selected>Memuat...</option>';

    try {
        const response = await fetch('/get_items', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ perusahaan: perusahaan })
        });
        const data = await response.json();
        
        itemSelect.innerHTML = '<option disabled selected>Pilih Barang...</option>';
        data.items.forEach(item => {
            const option = document.createElement('option');
            option.value = item.nama_barang;
            option.textContent = item.nama_barang;
            option.dataset.satuan = item.satuan;
            itemSelect.appendChild(option);
        });

        itemSelect.onchange = () => {
            const selected = itemSelect.options[itemSelect.selectedIndex];
            if (selected && selected.dataset.satuan) {
                unitSelect.value = selected.dataset.satuan;
            }
        };
    } catch (error) {
        console.error('Error:', error);
    }
}

async function fetchInventory() {
    const tbody = document.getElementById('inventory-table-body');
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center">Memuat...</td></tr>';
    
    try {
        const response = await fetch('/get_inventory');
        const data = await response.json();
        
        tbody.innerHTML = '';
        data.forEach(item => {
            const statusClass = item.status === 'Ada' ? 'ada' : 'tidak-ada';
            const row = `
                <tr>
                    <td>${item.perusahaan}</td>
                    <td>${item.barang}</td>
                    <td>
                        <div class="edit-stock-cell">
                            <input type="number" value="${item.stok}" class="stock-input" onchange="updateStock(${item.id}, this.value)">
                        </div>
                    </td>
                    <td>${item.satuan}</td>
                    <td>${item.lokasi}</td>
                    <td>
                        <select class="status-toggle ${statusClass}" onchange="updateStatus(${item.id}, this)">
                            <option value="Ada" ${item.status === 'Ada' ? 'selected' : ''}>Ada</option>
                            <option value="Tidak Ada" ${item.status === 'Tidak Ada' ? 'selected' : ''}>Tidak Ada</option>
                        </select>
                    </td>
                    <td><button class="btn-table" onclick="selectCompany('${item.perusahaan}', '${item.barang}')">Prediksi</button></td>
                </tr>
            `;
            tbody.innerHTML += row;
        });
    } catch (error) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center">Gagal memuat.</td></tr>';
    }
}

async function updateStock(id, newValue) {
    try {
        const response = await fetch('/update_stock', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: id, stok: newValue })
        });
        const data = await response.json();
        if (data.success) {
            // Re-fetch to update status badges etc
            fetchInventory();
        }
    } catch (error) {
        alert('Gagal update stok');
    }
}

function toggleAddForm() {
    const form = document.getElementById('add-inventory-form');
    form.style.display = form.style.display === 'none' ? 'block' : 'none';
}

async function submitNewInventory() {
    const perusahaan = document.getElementById('new-perusahaan').value;
    const barang = document.getElementById('new-barang').value;
    const satuan = document.getElementById('new-satuan').value;
    const stok = document.getElementById('new-stok').value;
    const lokasi = document.getElementById('new-lokasi').value;

    if (!perusahaan || !barang || !stok || !lokasi) return alert('Mohon isi semua field!');

    try {
        const response = await fetch('/add_inventory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ perusahaan, barang, satuan, stok, lokasi })
        });
        const data = await response.json();
        if (data.success) {
            alert('Barang berhasil ditambahkan!');
            toggleAddForm();
            fetchInventory();
            // Refresh to update company list in sidebar and dropdowns
            location.reload(); 
        }
    } catch (error) {
        alert('Gagal menambah barang');
    }
}

async function updateStatus(id, selectElement) {
    const newStatus = selectElement.value;
    try {
        await fetch('/update_inventory_status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: id, status: newStatus })
        });
        fetchInventory();
    } catch (error) {
        alert('Gagal update status');
    }
}

function selectCompany(companyName, itemName = null) {
    showSection('dashboard');
    const cSelect = document.getElementById('perusahaan');
    cSelect.value = companyName;
    updateItems().then(() => {
        if (itemName) {
            const iSelect = document.getElementById('nama_barang');
            iSelect.value = itemName;
            iSelect.dispatchEvent(new Event('change'));
        }
    });
}

async function predictStock() {
    const p = document.getElementById('perusahaan').value;
    const b = document.getElementById('nama_barang').value;
    const s = document.getElementById('satuan').value;
    const t = document.getElementById('tanggal').value;
    const res = document.getElementById('result');
    const unitLabel = document.getElementById('result-unit');
    const locLabel = document.getElementById('storage-location');

    if (!p || !b || !t) return alert('Lengkapi data!');

    res.innerText = "...";
    document.getElementById('current-stock-val').innerText = "...";
    document.getElementById('needed-stock-val').innerText = "...";
    res.classList.add('loading-pulse');

    try {
        console.log("Sending prediction request:", { perusahaan: p, nama_barang: b, satuan: s, tanggal: t });
        const response = await fetch('/predict', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ perusahaan: p, nama_barang: b, satuan: s, tanggal: t })
        });
        const data = await response.json();
        console.log("Prediction response received:", data);
        
        const resElem = document.getElementById('result');
        const stockElem = document.getElementById('current-stock-val');
        const neededElem = document.getElementById('needed-stock-val');

        if (resElem) animateValue(resElem, 0, data.prediction || 0, 1000);
        if (stockElem) animateValue(stockElem, 0, data.current_stock || 0, 1000);
        if (neededElem) animateValue(neededElem, 0, data.needed_stock || 0, 1000);
        
        if (neededElem) {
            if ((data.needed_stock || 0) > 0) {
                neededElem.classList.add('highlight');
            } else {
                neededElem.classList.remove('highlight');
            }
        }
        
        unitLabel.innerText = data.satuan ? data.satuan.toUpperCase() : "UNIT";
        locLabel.innerText = data.lokasi || "-";
        currentPredictItemId = data.item_id;
        
        res.classList.remove('loading-pulse');
    } catch (error) {
        console.error("Prediction error:", error);
        res.innerText = "Error";
    }
}

async function saveNewLayout() {
    const newLoc = document.getElementById('new-location-input').value;
    if (!currentPredictItemId) return alert('Lakukan prediksi barang terlebih dahulu!');
    if (!newLoc) return alert('Masukkan lokasi baru!');

    try {
        const response = await fetch('/update_layout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: currentPredictItemId, lokasi: newLoc })
        });
        const data = await response.json();
        if (data.success) {
            document.getElementById('storage-location').innerText = newLoc;
            alert('Lokasi tata letak berhasil diperbarui!');
        }
    } catch (error) {
        alert('Gagal menyimpan lokasi');
    }
}

// Shelf Visualization
async function openShelfVisualization() {
    const modal = document.getElementById('shelf-modal');
    const grid = document.getElementById('warehouse-grid');
    modal.style.display = "block";
    grid.innerHTML = '';

    try {
        const response = await fetch('/get_inventory');
        const inventory = await response.json();
        const occupiedLocations = inventory.filter(i => i.status === 'Ada').map(i => i.lokasi);

        // Generate a 5x10 grid (A to E, 01 to 10)
        const rows = ['A', 'B', 'C', 'D', 'E'];
        rows.forEach(row => {
            for (let i = 1; i <= 10; i++) {
                const locCode = `${row}-${i < 10 ? '0' + i : i}`;
                const isOccupied = occupiedLocations.includes(locCode);
                const cell = document.createElement('div');
                cell.className = `shelf-cell ${isOccupied ? 'occupied' : 'empty'}`;
                cell.innerHTML = `<span>${locCode}</span>`;
                if (isOccupied) {
                    const item = inventory.find(inv => inv.lokasi === locCode);
                    cell.title = `${item.barang} (${item.perusahaan})`;
                }
                grid.appendChild(cell);
            }
        });
    } catch (error) {
        console.error('Shelf Viz Error:', error);
    }
}

function closeShelfVisualization() {
    document.getElementById('shelf-modal').style.display = "none";
}

window.onclick = function(event) {
    const modal = document.getElementById('shelf-modal');
    if (event.target == modal) closeShelfVisualization();
}

function animateValue(obj, start, end, duration) {
    if (!obj) return;
    let startTimestamp = null;
    const step = (timestamp) => {
        if (!startTimestamp) startTimestamp = timestamp;
        const progress = Math.min((timestamp - startTimestamp) / duration, 1);
        const val = Math.floor(progress * (end - start) + start);
        obj.innerHTML = val;
        if (progress < 1) {
            window.requestAnimationFrame(step);
        } else {
            obj.innerHTML = end; // Final value ensures it matches exactly
        }
    };
    window.requestAnimationFrame(step);
}
