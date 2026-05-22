
const initialInventory = [];

let currentPredictItemId = null;

// Global variables to store data
let lastInventoryData = null;
let historicalData = []; // Initialized as empty, will be fetched from server
const historyStorageKey = 'gudang_history';
const themeStorageKey = 'gudang_theme';
let toastTimerId = null;
let showAllHistoryRows = false;
let _inventoryMemo = { ts: 0, data: null };
let _historyMemo = { ts: 0, key: '', data: null };
let _historyAllMemo = { ts: 0, data: null };
let _historyQuerySupported = true;
let _inventoryFetchErrorShown = false;
let inventorySearchTerm = '';

function showToast(message, type = 'info', title = '') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const iconClass =
        type === 'success' ? 'fa-check' :
        type === 'error' ? 'fa-xmark' :
        'fa-circle-info';

    const finalTitle =
        title ? title :
        type === 'success' ? 'Berhasil' :
        type === 'error' ? 'Gagal' :
        'Info';

    toast.innerHTML = `
        <div class="toast-icon"><i class="fas ${iconClass}"></i></div>
        <div class="toast-body">
            <div class="toast-title">${finalTitle}</div>
            <div class="toast-msg">${message}</div>
        </div>
    `;

    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));

    if (toastTimerId) clearTimeout(toastTimerId);
    toastTimerId = setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 220);
    }, 2600);
}

function setTheme(theme) {
    const root = document.documentElement;
    const isDark = theme === 'dark';
    root.setAttribute('data-theme', isDark ? 'dark' : 'light');
    localStorage.setItem(themeStorageKey, theme);

    const btn = document.getElementById('theme-toggle');
    if (btn) {
        btn.innerHTML = isDark ? '<i class="fas fa-sun"></i>' : '<i class="fas fa-moon"></i>';
    }
}

function initTheme() {
    const saved = localStorage.getItem(themeStorageKey);
    if (saved === 'dark' || saved === 'light') {
        setTheme(saved);
        return;
    }
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    setTheme(prefersDark ? 'dark' : 'light');
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    setTheme(current === 'dark' ? 'light' : 'dark');
}

function toggleHistoryForm() {
    const form = document.getElementById('history-form');
    if (!form) return;
    const next = form.style.display === 'none' ? 'block' : 'none';
    form.style.display = next;

    if (next === 'block') {
        const dateInput = document.getElementById('history-date');
        if (dateInput && !dateInput.value) {
            const today = new Date();
            const yyyy = today.getFullYear();
            const mm = String(today.getMonth() + 1).padStart(2, '0');
            const dd = String(today.getDate()).padStart(2, '0');
            dateInput.value = `${yyyy}-${mm}-${dd}`;
        }
    }
}

function loadLocalHistory() {
    const raw = localStorage.getItem(historyStorageKey);
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function saveLocalHistory(list) {
    localStorage.setItem(historyStorageKey, JSON.stringify(list));
}

async function addHistoryEntryFromUI() {
    const pSelect = document.getElementById('perusahaan');
    const bSelect = document.getElementById('nama_barang');
    const sSelect = document.getElementById('satuan');
    const dInput = document.getElementById('history-date');
    const qInput = document.getElementById('history-qty');

    const perusahaan = pSelect?.value;
    const nama_barang = bSelect?.value;
    const satuan = sSelect?.value || 'pcs';
    const tanggal = dInput?.value;
    const qty = parseInt(qInput?.value || '0', 10);

    if (!perusahaan || !nama_barang || !tanggal) {
        showToast('Pilih perusahaan, barang, dan tanggal terlebih dahulu.', 'error');
        return;
    }
    if (!Number.isFinite(qty) || qty <= 0) {
        showToast('Jumlah keluar harus lebih dari 0.', 'error');
        return;
    }

    const entry = { 
        tanggal, 
        perusahaan, 
        nama_barang, 
        satuan, 
        jumlah_terjual: qty 
    };

    try {
        const token = sessionStorage.getItem('gudang_token') || '';
        const response = await fetch(`${API_BASE_URL}/api/history`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
            body: JSON.stringify(entry)
        });

        if (response.ok) {
            showToast('Riwayat tersimpan & Stok otomatis berkurang!', 'success');
            // Refresh local data & UI
            await getInventory(); 
            const h = await getHistory();
            await updateKpiCards();
            await renderRestockList();
            initChart(h);
            
            // Refresh table if in inventory section
            const invSection = document.getElementById('section-inventory');
            if (invSection && invSection.style.display !== 'none') {
                await fetchInventory(); 
            }
            
            toggleHistoryForm();
        } else {
            const err = await response.json();
            showToast(err.message || 'Gagal menyimpan riwayat.', 'error');
        }
    } catch (e) {
        console.error("Save history error:", e);
        showToast('Terjadi kesalahan jaringan.', 'error');
    }
}

// Helper to get inventory from Backend
// GitHub Pages / Remote API Configuration
const isGitHubPages = window.location.hostname.includes('github.io');
// GANTI URL INI dengan URL Backend Anda (misal dari Render.com) jika sudah hosting backend
const REMOTE_API_URL = 'https://gudang-ssi-backend.onrender.com'; 
const API_BASE_URL = isGitHubPages ? REMOTE_API_URL : '';

async function getInventory() {
    if (_inventoryMemo.data && (Date.now() - _inventoryMemo.ts) < 1500) {
        return _inventoryMemo.data;
    }
    try {
        const response = await fetch(`${API_BASE_URL}/api/inventory`);
        if (response.ok) {
            const remoteData = await response.json();
            if (Array.isArray(remoteData)) {
                localStorage.setItem('gudang_inventory', JSON.stringify(remoteData));
                _inventoryMemo = { ts: Date.now(), data: remoteData };
                _inventoryFetchErrorShown = false;
                return remoteData;
            }
        }
    } catch (e) {
        console.warn("Backend fetch failed, using LocalStorage:", e);
    }
    const localData = localStorage.getItem('gudang_inventory');
    const fallback = localData ? JSON.parse(localData) : initialInventory;
    if ((!fallback || (Array.isArray(fallback) && fallback.length === 0)) && !_inventoryFetchErrorShown && !isGitHubPages) {
        _inventoryFetchErrorShown = true;
        showToast('Tidak bisa mengambil data inventori dari server. Pastikan backend berjalan dan database terhubung.', 'error');
    }
    _inventoryMemo = { ts: Date.now(), data: fallback };
    return fallback;
}

async function getHistory(limit = 2000, offset = 0) {
    const key = `${API_BASE_URL}|${String(limit)}|${String(offset)}`;
    if (_historyMemo.data && _historyMemo.key === key && (Date.now() - _historyMemo.ts) < 4000) {
        historicalData = _historyMemo.data;
        return _historyMemo.data;
    }
    if (!_historyQuerySupported) {
        const all = await getHistoryAll();
        const sliced = all.slice(offset, offset + limit);
        historicalData = sliced;
        localStorage.setItem('gudang_history', JSON.stringify(sliced));
        _historyMemo = { ts: Date.now(), key, data: sliced };
        return sliced;
    }
    try {
        const url = `${API_BASE_URL}/api/history?limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}`;
        const response = await fetch(url);
        if (!response.ok) {
            _historyQuerySupported = false;
            const all = await getHistoryAll();
            const sliced = all.slice(offset, offset + limit);
            historicalData = sliced;
            localStorage.setItem('gudang_history', JSON.stringify(sliced));
            _historyMemo = { ts: Date.now(), key, data: sliced };
            return sliced;
        }

        const remoteData = await response.json();
        if (Array.isArray(remoteData)) {
            historicalData = remoteData;
            localStorage.setItem('gudang_history', JSON.stringify(remoteData));
            _historyMemo = { ts: Date.now(), key, data: remoteData };
            return remoteData;
        }

        _historyQuerySupported = false;
        const all = await getHistoryAll();
        const sliced = all.slice(offset, offset + limit);
        historicalData = sliced;
        localStorage.setItem('gudang_history', JSON.stringify(sliced));
        _historyMemo = { ts: Date.now(), key, data: sliced };
        return sliced;
    } catch (e) {
        console.warn("History fetch failed:", e);
    }
    const local = localStorage.getItem('gudang_history');
    historicalData = local ? JSON.parse(local) : [];
    _historyMemo = { ts: Date.now(), key, data: historicalData };
    return historicalData;
}

async function getHistoryAll() {
    if (_historyAllMemo.data && (Date.now() - _historyAllMemo.ts) < 30000) {
        return _historyAllMemo.data;
    }
    try {
        const response = await fetch(`${API_BASE_URL}/api/history`);
        if (response.ok) {
            const remoteData = await response.json();
            if (Array.isArray(remoteData)) {
                _historyAllMemo = { ts: Date.now(), data: remoteData };
                return remoteData;
            }
        }
    } catch (e) {
        console.warn("History fetch failed:", e);
    }
    return [];
}

async function getRestockList() {
    const leadTimeInput = document.getElementById('lead-time');
    const serviceLevelSelect = document.getElementById('service-level');
    const lead_time = parseInt(leadTimeInput?.value || '3', 10);
    const service_level = parseFloat(serviceLevelSelect?.value || '0.95');

    const lt = Number.isFinite(lead_time) && lead_time > 0 ? lead_time : 3;
    const sl = Number.isFinite(service_level) ? service_level : 0.95;

    const url = `${API_BASE_URL}/api/restock?lead_time=${encodeURIComponent(String(lt))}&service_level=${encodeURIComponent(String(sl))}`;
    try {
        const response = await fetch(url);
        if (!response.ok) return [];
        const data = await response.json();
        return Array.isArray(data) ? data : [];
    } catch (e) {
        console.warn("Restock fetch failed:", e);
        return [];
    }
}

async function renderRestockList() {
    const tbody = document.getElementById('restock-table-body');
    const empty = document.getElementById('restock-empty');
    if (!tbody) return;

    const items = await getRestockList();
    tbody.innerHTML = '';

    if (!items.length) {
        if (empty) empty.style.display = 'block';
        return;
    }

    if (empty) empty.style.display = 'none';
    items.forEach(item => {
        const badgeClass = item.reorder_needed ? 'rop-badge rop-badge--danger' : 'rop-badge rop-badge--success';
        const badgeText = item.reorder_needed ? 'Reorder' : 'Aman';
        const row = `
            <tr>
                <td>${item.perusahaan}</td>
                <td>${item.barang}</td>
                <td>${Number(item.stok || 0).toLocaleString('id-ID')}</td>
                <td>${Number(item.safety_stock || 0).toLocaleString('id-ID')}</td>
                <td>${Number(item.reorder_point || 0).toLocaleString('id-ID')}</td>
                <td><span class="${badgeClass}">${badgeText}</span></td>
                <td><button class="btn-table" onclick="selectCompany('${item.perusahaan}', '${item.barang}')">Prediksi</button></td>
            </tr>
        `;
        tbody.innerHTML += row;
    });
}

async function saveInventory(inventory, options = {}) {
    const silent = Boolean(options.silent);

    localStorage.setItem('gudang_inventory', JSON.stringify(inventory));
    lastInventoryData = JSON.stringify(inventory);
    _inventoryMemo = { ts: Date.now(), data: inventory };

    if (isGitHubPages) {
        if (!silent) showToast('Tersimpan di browser (Mode GitHub)', 'info');
        return true;
    }

    try {
        const token = sessionStorage.getItem('gudang_token') || '';
        const response = await fetch(`${API_BASE_URL}/api/inventory`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
            body: JSON.stringify({ inventory: inventory })
        });

        if (response.ok) {
            if (!silent) showToast('Database MySQL berhasil diperbarui!', 'success');
            return true;
        }

        const err = await response.json().catch(() => ({}));
        if (!silent) showToast(err.message || 'Gagal update database', 'error');
        return false;
    } catch (e) {
        console.error("Save error:", e);
        if (!silent) showToast('Koneksi server terputus', 'error');
        return false;
    }
}

// Helper to get unique companies
async function getUniqueCompanies() {
    const inventory = await getInventory();
    const invCompanies = inventory.map(d => d.perusahaan);
    return [...new Set([...invCompanies])].sort();
}

async function updateKpiCards() {
    const inventory = await getInventory();
    const companies = await getUniqueCompanies();
    const totalItems = inventory.length;
    const availableItems = inventory.filter(i => i.status === 'Ada' && Number(i.stok) > 0).length;
    const restockItems = inventory.filter(i => Number(i.stok) <= 0 || i.status === 'Tidak Ada').length;

    const totalEl = document.getElementById('kpi-total-items');
    const availEl = document.getElementById('kpi-available-items');
    const restockEl = document.getElementById('kpi-restock-items');
    const companyEl = document.getElementById('kpi-total-company');

    if (totalEl) totalEl.textContent = totalItems.toLocaleString('id-ID');
    if (availEl) availEl.textContent = availableItems.toLocaleString('id-ID');
    if (restockEl) restockEl.textContent = restockItems.toLocaleString('id-ID');
    if (companyEl) companyEl.textContent = companies.length.toLocaleString('id-ID');
}

let transactionChart = null;
let predictChart = null;

function initChart(data = []) {
    const ctx = document.getElementById('transactionChart');
    if (!ctx) return;

    if (!Array.isArray(data) || data.length === 0) {
        console.warn("Chart data empty");
        return;
    }

    // Group data by date and sum quantities
    const grouped = data.reduce((acc, curr) => {
        if (!curr.tanggal) return acc;
        acc[curr.tanggal] = (acc[curr.tanggal] || 0) + (parseInt(curr.jumlah_terjual) || 0);
        return acc;
    }, {});

    const sortedDates = Object.keys(grouped).sort();
    const labels = sortedDates.slice(-7); // Last 7 days
    const values = labels.map(l => grouped[l]);

    if (transactionChart) {
        transactionChart.destroy();
    }

    transactionChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Volume Transaksi',
                data: values,
                borderColor: '#4f46e5',
                backgroundColor: 'rgba(79, 70, 229, 0.1)',
                borderWidth: 3,
                tension: 0.4,
                fill: true,
                pointBackgroundColor: '#4f46e5',
                pointRadius: 5,
                pointHoverRadius: 8
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#1e293b',
                    padding: 12,
                    titleFont: { size: 14, weight: 'bold' },
                    bodyFont: { size: 13 }
                }
            },
            scales: {
                y: { 
                    beginAtZero: true, 
                    grid: { color: 'rgba(0,0,0,0.05)', drawBorder: false },
                    ticks: { color: '#64748b' }
                },
                x: { 
                    grid: { display: false },
                    ticks: { color: '#64748b' }
                }
            }
        }
    });
}

function renderPredictChart(historySeries = [], targetMonth = '', prediction = 0) {
    const canvas = document.getElementById('predictChart');
    if (!canvas) return;
    if (typeof Chart === 'undefined') return;

    const labels = [];
    const histValues = [];

    if (Array.isArray(historySeries)) {
        historySeries.forEach(p => {
            const m = String(p.month || '').slice(0, 7);
            if (!m) return;
            labels.push(m);
            histValues.push(Number(p.qty || 0));
        });
    }

    const targetLabel = String(targetMonth || '').slice(0, 7);
    if (targetLabel && (labels.length === 0 || labels[labels.length - 1] !== targetLabel)) {
        labels.push(targetLabel);
        histValues.push(null);
    }

    const predValues = labels.map(l => (l === targetLabel ? Number(prediction || 0) : null));

    if (predictChart) {
        predictChart.destroy();
    }

    predictChart = new Chart(canvas, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'Historis',
                    data: histValues,
                    borderColor: '#0ea5e9',
                    backgroundColor: 'rgba(14, 165, 233, 0.12)',
                    borderWidth: 3,
                    tension: 0.35,
                    fill: true,
                    pointRadius: 3
                },
                {
                    label: 'Prediksi',
                    data: predValues,
                    borderColor: '#f97316',
                    backgroundColor: 'rgba(249, 115, 22, 0.12)',
                    borderWidth: 3,
                    tension: 0.35,
                    fill: false,
                    pointRadius: 6,
                    pointHoverRadius: 8,
                    borderDash: [6, 6],
                    spanGaps: true
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: true }
            },
            scales: {
                y: {
                    beginAtZero: true
                }
            }
        }
    });
}

// Fixed polling and error handling
let isFetching = false;
async function startPolling() {
    setInterval(async () => {
        if (isFetching) return;
        isFetching = true;
        try {
            const inventory = await getInventory();
            
            const currentDataStr = JSON.stringify(inventory);
            if (currentDataStr !== lastInventoryData) {
                lastInventoryData = currentDataStr;
                
                // Update UI only if needed
                const invSection = document.getElementById('section-inventory');
                if (invSection && invSection.style.display !== 'none') {
                    await fetchInventory(); 
                }
                await populateCompanyDropdowns();
                await updateKpiCards();
            }
        } catch (e) {
            console.error("Polling error:", e);
        } finally {
            isFetching = false;
        }
    }, 5000); // Polling every 5s for better performance
}

document.addEventListener('DOMContentLoaded', async () => {
    console.log("Gudang PT. SSI - System Ready");
    try {
        initTheme();
        
        // Ensure checkLogin is called immediately
        checkLogin();

        const backdrop = document.getElementById('sidebar-backdrop');
        if (backdrop) {
            backdrop.addEventListener('click', () => closeSidebar());
        }
        
        const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
        const dateElem = document.getElementById('current-date');
        if (dateElem) {
            dateElem.innerText = new Date().toLocaleDateString('id-ID', options);
        }

        const predDate = document.getElementById('tanggal');
        if (predDate && !predDate.value) {
            const now = new Date();
            const y = now.getFullYear();
            const m = now.getMonth();
            const firstNextMonth = new Date(y, m + 1, 1);
            const yyyy = firstNextMonth.getFullYear();
            const mm = String(firstNextMonth.getMonth() + 1).padStart(2, '0');
            const dd = String(firstNextMonth.getDate()).padStart(2, '0');
            predDate.value = `${yyyy}-${mm}-${dd}`;
        }
        
        await populateCompanyDropdowns();
        await updateKpiCards();
        const h = await getHistory(1000, 0);
        await renderRestockList();
        initChart(h);
        
        // Show default section
        showSection('dashboard');

        const invSearch = document.getElementById('inventory-search');
        if (invSearch) {
            invSearch.addEventListener('input', () => {
                inventorySearchTerm = String(invSearch.value || '').toLowerCase();
                const invSection = document.getElementById('section-inventory');
                if (invSection && invSection.style.display !== 'none') {
                    fetchInventory();
                }
            });
        }

        // Setup login event listeners
        const loginPass = document.getElementById('login-password');
        if (loginPass) {
            loginPass.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') handleLogin();
            });
        }

        startPolling();
    } catch (err) {
        console.error("Initialization failed:", err);
    }
});

function toggleSidebar() {
    const app = document.getElementById('main-app');
    if (!app) return;
    app.classList.toggle('sidebar-open');
}

function closeSidebar() {
    const app = document.getElementById('main-app');
    if (!app) return;
    app.classList.remove('sidebar-open');
}

// Authentication Logic
function checkLogin() {
    try {
        const isLoggedIn = sessionStorage.getItem('gudang_isLoggedIn');
        const token = sessionStorage.getItem('gudang_token');
        const loginPage = document.getElementById('login-page');
        const mainApp = document.getElementById('main-app');

        console.log("Checking login status:", isLoggedIn);

        if (isLoggedIn === 'true' && token) {
            if (loginPage) loginPage.style.display = 'none';
            if (mainApp) mainApp.style.display = 'flex';
        } else {
            if (loginPage) loginPage.style.display = 'flex';
            if (mainApp) mainApp.style.display = 'none';
        }
    } catch (e) {
        console.error("Cek login gagal:", e);
    }
}

function handleLogin() {
    (async () => {
        try {
            const userElem = document.getElementById('login-username');
            const passElem = document.getElementById('login-password');
            const errorMsg = document.getElementById('login-error');

            if (!userElem || !passElem) return;
            if (errorMsg) errorMsg.style.display = 'none';

            const username = userElem.value.trim();
            const password = passElem.value.trim();

            const response = await fetch(`${API_BASE_URL}/api/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });

            if (!response.ok) {
                if (errorMsg) errorMsg.style.display = 'block';
                showToast("Username atau password salah!", "error");
                return;
            }

            const data = await response.json();
            if (data?.token) {
                sessionStorage.setItem('gudang_token', data.token);
                sessionStorage.setItem('gudang_isLoggedIn', 'true');
                checkLogin();
                showToast("Login berhasil!", "success");
                await renderRestockList();
            } else {
                if (errorMsg) errorMsg.style.display = 'block';
                showToast("Login gagal.", "error");
            }
        } catch (e) {
            console.error("Login error:", e);
            showToast("Terjadi kesalahan saat login.", "error");
        }
    })();
}

function handleLogout() {
    sessionStorage.removeItem('gudang_isLoggedIn');
    sessionStorage.removeItem('gudang_token');
    location.reload();
}

function toggleHistoryView() {
    showAllHistoryRows = !showAllHistoryRows;
    const btn = document.getElementById('toggle-history-btn');
    if (btn) btn.textContent = showAllHistoryRows ? 'Tampilkan 10' : 'Lihat Semua';
    fetchInventory();
}

function _historyRowToHtml(h) {
    const jenis = h.jenis || (Number(h.qty_in || 0) > 0 ? 'Masuk' : 'Keluar');
    const jumlah = Number(
        h.jumlah ??
        (jenis === 'Masuk' ? (h.qty_in || 0) : (h.qty_out ?? h.jumlah_terjual ?? 0))
    );
    return `
                <tr>
                    <td>${h.tanggal}</td>
                    <td>${h.perusahaan}</td>
                    <td>${h.nama_barang}</td>
                    <td>${h.satuan}</td>
                    <td>${jenis}</td>
                    <td>${jumlah.toLocaleString('id-ID')}</td>
                </tr>
            `;
}

async function _renderHistoryChunked(tbody, data, chunkSize = 300) {
    tbody.innerHTML = '';
    for (let i = 0; i < data.length; i += chunkSize) {
        const chunk = data.slice(i, i + chunkSize).map(_historyRowToHtml).join('');
        tbody.insertAdjacentHTML('beforeend', chunk);
        await new Promise(resolve => requestAnimationFrame(resolve));
    }
}

async function populateCompanyDropdowns() {
    const companies = await getUniqueCompanies();
    
    // Sidebar Nav
    const navList = document.getElementById('company-nav-list');
    if (navList) {
        navList.innerHTML = '';
        companies.forEach(company => {
            const li = document.createElement('li');
            li.innerHTML = `<a href="#" onclick="selectCompany('${company}')"><i class="fas fa-building"></i> <span>${company}</span></a>`;
            navList.appendChild(li);
        });
    }

    // Prediction Dropdown
    const pSelect = document.getElementById('perusahaan');
    if (pSelect) {
        const currentValue = pSelect.value;
        pSelect.innerHTML = '<option value="" disabled selected>Pilih Klien Perusahaan</option>';
        companies.forEach(company => {
            const opt = document.createElement('option');
            opt.value = company;
            opt.textContent = company;
            pSelect.appendChild(opt);
        });
        if (currentValue) pSelect.value = currentValue;
    }

    const siSelect = document.getElementById('stockin-perusahaan');
    if (siSelect) {
        const currentValue = siSelect.value;
        siSelect.innerHTML = '<option value="" disabled selected>Pilih Klien Perusahaan</option>';
        companies.forEach(company => {
            const opt = document.createElement('option');
            opt.value = company;
            opt.textContent = company;
            siSelect.appendChild(opt);
        });
        if (currentValue) siSelect.value = currentValue;
    }
}

async function showSection(sectionId) {
    document.querySelectorAll('.app-section').forEach(s => s.style.display = 'none');
    const target = document.getElementById(`section-${sectionId}`);
    if (target) target.style.display = 'block';
    
    document.querySelectorAll('.sidebar-nav li').forEach(li => li.classList.remove('active'));
    const navItem = document.getElementById(`nav-${sectionId}`);
    if (navItem) navItem.classList.add('active');

    if (sectionId === 'inventory') await fetchInventory();
    if (sectionId === 'dashboard') await renderRestockList();
    if (sectionId === 'predictions') await refreshPredictionLogs();
    closeSidebar();
}

async function updateItems() {
    const perusahaanElem = document.getElementById('perusahaan');
    const itemSelect = document.getElementById('nama_barang');
    const unitSelect = document.getElementById('satuan');
    
    if (!perusahaanElem || !itemSelect) return;
    const perusahaan = perusahaanElem.value;
    
    // Get items from historical data
    const csvItems = historicalData
        .filter(d => d.perusahaan === perusahaan)
        .map(d => ({ nama_barang: d.nama_barang, satuan: d.satuan }));
    
    // Get items from inventory
    const inventory = await getInventory();
    const invItems = inventory
        .filter(d => d.perusahaan === perusahaan)
        .map(d => ({ nama_barang: d.barang, satuan: d.satuan }));

    // Merge and unique
    const combined = [];
    const seen = new Set();
    [...csvItems, ...invItems].forEach(item => {
        if (!seen.has(item.nama_barang)) {
            seen.add(item.nama_barang);
            combined.push(item);
        }
    });
    
    itemSelect.innerHTML = '<option disabled selected>Pilih Barang...</option>';
    combined.forEach(item => {
        const option = document.createElement('option');
        option.value = item.nama_barang;
        option.textContent = item.nama_barang;
        option.dataset.satuan = item.satuan;
        itemSelect.appendChild(option);
    });

    itemSelect.onchange = () => {
        const selected = itemSelect.options[itemSelect.selectedIndex];
        if (selected && selected.dataset.satuan && unitSelect) {
            unitSelect.value = selected.dataset.satuan;
        }
    };
}

async function fetchInventory() {
    const tbody = document.getElementById('inventory-table-body');
    const hbody = document.getElementById('history-table-body');
    if (!tbody) return;
    
    const data = await getInventory();
    const filtered = inventorySearchTerm
        ? data.filter(item => {
            const perusahaan = String(item.perusahaan || '').toLowerCase();
            const barang = String(item.barang || '').toLowerCase();
            const lokasi = String(item.lokasi || '').toLowerCase();
            const satuan = String(item.satuan || '').toLowerCase();
            return perusahaan.includes(inventorySearchTerm) || barang.includes(inventorySearchTerm) || lokasi.includes(inventorySearchTerm) || satuan.includes(inventorySearchTerm);
        })
        : data;
    
    tbody.innerHTML = filtered.map(item => {
        const statusClass = item.status === 'Ada' ? 'ada' : 'tidak-ada';
        return `
            <tr>
                <td>${item.perusahaan}</td>
                <td>${item.barang}</td>
                <td>
                    <div class="edit-stock-cell">
                        <input type="number" value="${item.stok}" class="stock-input" onfocus="this.dataset.prev=this.value" onchange="updateStock(${item.id}, this)">
                    </div>
                </td>
                <td>
                    <input type="text" value="${item.satuan || ''}" list="unit-options" class="stock-input" onfocus="this.dataset.prev=this.value" onchange="updateUnit(${item.id}, this)">
                </td>
                <td>${item.lokasi}</td>
                <td>
                    <select class="status-toggle ${statusClass}" onfocus="this.dataset.prev=this.value" onchange="updateStatus(${item.id}, this)">
                        <option value="Ada" ${item.status === 'Ada' ? 'selected' : ''}>Ada</option>
                        <option value="Tidak Ada" ${item.status === 'Tidak Ada' ? 'selected' : ''}>Tidak Ada</option>
                    </select>
                </td>
                <td>
                    <button class="btn-table" onclick="selectCompany('${item.perusahaan}', '${item.barang}')">Prediksi</button>
                    <button class="btn-table" onclick="deleteInventoryItem(${item.id})">Hapus</button>
                </td>
            </tr>
        `;
    }).join('');

    // Also update history table if it exists
    if (hbody) {
        const hData = showAllHistoryRows ? await getHistoryAll() : await getHistory(10, 0);
        if (showAllHistoryRows && hData.length > 400) {
            await _renderHistoryChunked(hbody, hData, 300);
        } else {
            hbody.innerHTML = hData.map(_historyRowToHtml).join('');
        }
    }
}

async function updateStock(id, inputElem) {
    const prev = inputElem?.dataset?.prev ?? '';
    const nextRaw = inputElem?.value ?? '';
    const next = parseInt(nextRaw, 10);
    if (!Number.isFinite(next) || next < 0) {
        if (inputElem) inputElem.value = prev;
        showToast('Stok harus angka dan tidak boleh negatif.', 'error');
        return;
    }
    if (String(prev) === String(nextRaw)) return;
    const okConfirm = confirm('Simpan perubahan stok?');
    if (!okConfirm) {
        if (inputElem) inputElem.value = prev;
        return;
    }
    const data = await getInventory();
    const itemIndex = data.findIndex(i => i.id === id);
    if (itemIndex > -1) {
        data[itemIndex].stok = next;
        data[itemIndex].status = next > 0 ? 'Ada' : 'Tidak Ada';
        await saveInventory(data, { silent: true });
        await updateKpiCards();
        await fetchInventory();
    }
}

async function updateUnit(id, inputElem) {
    const prev = String(inputElem?.dataset?.prev ?? '');
    const next = String(inputElem?.value ?? '').trim();
    if (!next) {
        if (inputElem) inputElem.value = prev;
        showToast('Satuan tidak boleh kosong.', 'error');
        return;
    }
    if (next.length > 50) {
        if (inputElem) inputElem.value = prev;
        showToast('Satuan terlalu panjang.', 'error');
        return;
    }
    if (prev === next) return;
    const okConfirm = confirm('Simpan perubahan satuan?');
    if (!okConfirm) {
        if (inputElem) inputElem.value = prev;
        return;
    }
    const data = await getInventory();
    const itemIndex = data.findIndex(i => i.id === id);
    if (itemIndex > -1) {
        data[itemIndex].satuan = next;
        await saveInventory(data, { silent: true });
        await fetchInventory();
        await populateCompanyDropdowns();
    }
}

function toggleAddForm() {
    const form = document.getElementById('add-inventory-form');
    if (form) form.style.display = form.style.display === 'none' ? 'block' : 'none';
}

function toggleStockInForm() {
    const form = document.getElementById('stockin-form');
    if (!form) return;
    const next = form.style.display === 'none' ? 'block' : 'none';
    form.style.display = next;
    if (next === 'block') {
        const dateInput = document.getElementById('stockin-date');
        if (dateInput && !dateInput.value) {
            const today = new Date();
            const yyyy = today.getFullYear();
            const mm = String(today.getMonth() + 1).padStart(2, '0');
            const dd = String(today.getDate()).padStart(2, '0');
            dateInput.value = `${yyyy}-${mm}-${dd}`;
        }
    }
}

async function updateStockInItems() {
    const perusahaanElem = document.getElementById('stockin-perusahaan');
    const itemSelect = document.getElementById('stockin-nama-barang');
    const unitSelect = document.getElementById('stockin-satuan');
    if (!perusahaanElem || !itemSelect) return;
    const perusahaan = perusahaanElem.value;
    const inventory = await getInventory();
    const invItems = inventory
        .filter(d => d.perusahaan === perusahaan)
        .map(d => ({ nama_barang: d.barang, satuan: d.satuan }));

    itemSelect.innerHTML = '<option disabled selected>Pilih Barang...</option>';
    invItems.forEach(item => {
        const option = document.createElement('option');
        option.value = item.nama_barang;
        option.textContent = item.nama_barang;
        option.dataset.satuan = item.satuan;
        itemSelect.appendChild(option);
    });

    itemSelect.onchange = () => {
        const selected = itemSelect.options[itemSelect.selectedIndex];
        if (selected && selected.dataset.satuan && unitSelect) {
            unitSelect.value = selected.dataset.satuan;
        }
    };
}

async function addStockInEntryFromUI() {
    const pSelect = document.getElementById('stockin-perusahaan');
    const bSelect = document.getElementById('stockin-nama-barang');
    const sSelect = document.getElementById('stockin-satuan');
    const dInput = document.getElementById('stockin-date');
    const qInput = document.getElementById('stockin-qty');

    const perusahaan = pSelect?.value;
    const nama_barang = bSelect?.value;
    const satuan = sSelect?.value || 'pcs';
    const tanggal = dInput?.value;
    const qty_in = parseInt(qInput?.value || '0', 10);

    if (!perusahaan || !nama_barang || !tanggal) {
        showToast('Pilih perusahaan, barang, dan tanggal terlebih dahulu.', 'error');
        return;
    }
    if (!Number.isFinite(qty_in) || qty_in <= 0) {
        showToast('Jumlah masuk harus lebih dari 0.', 'error');
        return;
    }

    try {
        const token = sessionStorage.getItem('gudang_token') || '';
        const response = await fetch(`${API_BASE_URL}/api/stock-in`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
            body: JSON.stringify({ tanggal, perusahaan, nama_barang, satuan, qty_in })
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            showToast(err.message || 'Gagal menyimpan barang masuk.', 'error');
            return;
        }

        showToast('Barang masuk tersimpan & Stok bertambah!', 'success');
        await fetchInventory();
        await populateCompanyDropdowns();
        await updateKpiCards();
        toggleStockInForm();
    } catch (e) {
        console.error("Save stock-in error:", e);
        showToast('Terjadi kesalahan jaringan.', 'error');
    }
}

async function submitNewInventory() {
    const perusahaan = document.getElementById('new-perusahaan')?.value;
    const barang = document.getElementById('new-barang')?.value;
    const satuan = document.getElementById('new-satuan')?.value;
    const stok = document.getElementById('new-stok')?.value;
    const lokasi = document.getElementById('new-lokasi')?.value;

    if (!perusahaan || !barang || !stok || !lokasi) {
        showToast("Mohon isi semua field.", "error");
        return;
    }

    if (isGitHubPages) {
        const inventory = await getInventory();
        const newId = inventory.length > 0 ? Math.max(...inventory.map(i => i.id)) + 1 : 1;
        inventory.push({
            id: newId,
            perusahaan,
            barang,
            satuan,
            stok: parseInt(stok),
            status: parseInt(stok) > 0 ? "Ada" : "Tidak Ada",
            lokasi
        });
        const ok = await saveInventory(inventory);
        if (ok) showToast("Barang berhasil ditambahkan.", "success");
    } else {
        try {
            const token = sessionStorage.getItem('gudang_token') || '';
            const response = await fetch(`${API_BASE_URL}/api/inventory/add`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
                body: JSON.stringify({
                    perusahaan: String(perusahaan).trim(),
                    barang: String(barang).trim(),
                    satuan: String(satuan || 'pcs').trim(),
                    stok: parseInt(stok, 10),
                    lokasi: String(lokasi).trim()
                })
            });
            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                showToast(err.message || "Gagal menambah barang.", "error");
                return;
            }
            showToast("Barang berhasil ditambahkan.", "success");
        } catch (e) {
            console.error("Add inventory error:", e);
            showToast("Terjadi kesalahan jaringan.", "error");
            return;
        }
    }
    
    toggleAddForm();
    await fetchInventory();
    await populateCompanyDropdowns();
    await updateKpiCards();
}

async function deleteInventoryItem(id) {
    const okConfirm = confirm('Hapus barang ini?');
    if (!okConfirm) return;

    if (isGitHubPages) {
        const inventory = await getInventory();
        const next = inventory.filter(i => Number(i.id) !== Number(id));
        await saveInventory(next, { silent: true });
        showToast('Barang dihapus.', 'success');
        await fetchInventory();
        await populateCompanyDropdowns();
        await updateKpiCards();
        return;
    }

    try {
        const token = sessionStorage.getItem('gudang_token') || '';
        const response = await fetch(`${API_BASE_URL}/api/inventory/${encodeURIComponent(String(id))}`, {
            method: 'DELETE',
            headers: { 'X-Auth-Token': token }
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            showToast(err.message || 'Gagal menghapus barang.', 'error');
            return;
        }
        showToast('Barang dihapus.', 'success');
        await fetchInventory();
        await populateCompanyDropdowns();
        await updateKpiCards();
    } catch (e) {
        console.error("Delete inventory error:", e);
        showToast('Terjadi kesalahan jaringan.', 'error');
    }
}

async function exportToExcel() {
    const inventory = await getInventory();
    const uniqueCompanies = await getUniqueCompanies();
    const historyAll = await getHistoryAll();
    const leadTimeInput = document.getElementById('lead-time');
    const serviceLevelSelect = document.getElementById('service-level');
    const tInput = document.getElementById('tanggal');

    const lead_time = parseInt(leadTimeInput?.value || '3', 10);
    const service_level = parseFloat(serviceLevelSelect?.value || '0.95');

    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    const defaultTarget = new Date(y, m + 1, 1);
    const defaultTargetStr = `${defaultTarget.getFullYear()}-${String(defaultTarget.getMonth() + 1).padStart(2, '0')}-${String(defaultTarget.getDate()).padStart(2, '0')}`;
    const target_date = (tInput?.value || '').trim() || defaultTargetStr;
    
    // Prepare Data for Excel Sheets
    const companyData = uniqueCompanies.map(name => ({
        'Nama Perusahaan': name,
        'Status': 'Aktif'
    }));

    const masterBarang = inventory.map(item => ({
        'ID': item.id,
        'Perusahaan': item.perusahaan,
        'Nama Barang': item.barang,
        'Satuan': item.satuan,
        'Stok': item.stok,
        'Lokasi': item.lokasi,
        'Status': item.status
    }));

    const historySheet = historyAll.map(d => ({
        'Tanggal': d.tanggal,
        'Perusahaan': d.perusahaan,
        'Nama Barang': d.nama_barang,
        'Satuan': d.satuan,
        'Jenis': d.jenis || (Number(d.qty_in || 0) > 0 ? 'Masuk' : 'Keluar'),
        'Jumlah': Number(d.jumlah ?? (Number(d.qty_in || 0) > 0 ? (d.qty_in || 0) : (d.qty_out ?? d.jumlah_terjual ?? 0)))
    }));

    const items = inventory.map(item => ({ perusahaan: item.perusahaan, nama_barang: item.barang }));

    async function mapWithConcurrency(list, concurrency, mapper) {
        const result = new Array(list.length);
        let idx = 0;
        const workers = new Array(Math.max(1, concurrency)).fill(0).map(async () => {
            while (idx < list.length) {
                const cur = idx++;
                try {
                    result[cur] = await mapper(list[cur], cur);
                } catch (e) {
                    result[cur] = null;
                }
            }
        });
        await Promise.all(workers);
        return result;
    }

    const predictionsRaw = await mapWithConcurrency(items, 5, async (it) => {
        const response = await fetch(`${API_BASE_URL}/api/predict`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                perusahaan: it.perusahaan,
                nama_barang: it.nama_barang,
                target_date,
                lead_time: Number.isFinite(lead_time) && lead_time > 0 ? lead_time : 3,
                service_level: Number.isFinite(service_level) ? service_level : 0.95
            })
        });
        if (!response.ok) return null;
        const data = await response.json();
        return {
            'Perusahaan': data.perusahaan,
            'Nama Barang': data.nama_barang,
            'Target Bulan': (data.target_month || '').slice(0, 10),
            'Lead Time': data.lead_time,
            'Service Level': data.service_level,
            'Prediksi': Number(data.prediction || 0),
            'Stok Saat Ini': Number(data.current_stock || 0),
            'Perlu Ditambah': Number(data.needed_stock || 0),
            'Safety Stock': Number(data.safety_stock || 0),
            'Reorder Point': Number(data.reorder_point || 0),
            'Status ROP': data.reorder_needed ? 'Reorder' : 'Aman',
            'MAE': Number(data.metrics?.mae ?? 0),
            'RMSE': Number(data.metrics?.rmse ?? 0),
            'R2': Number(data.metrics?.r2 ?? 0),
            'History (bulan)': Number(data.history_points || 0),
            'Cold Start': data.cold_start ? 'Ya' : 'Tidak'
        };
    });

    const predictions = predictionsRaw.filter(Boolean);

    try {
        // Use SheetJS (XLSX) to create workbook
        const wb = XLSX.utils.book_new();
        
        const ws_comp = XLSX.utils.json_to_sheet(companyData);
        const ws_inv = XLSX.utils.json_to_sheet(masterBarang);
        const ws_hist = XLSX.utils.json_to_sheet(historySheet);
        const ws_pred = XLSX.utils.json_to_sheet(predictions);

        XLSX.utils.book_append_sheet(wb, ws_comp, "Profil Perusahaan");
        XLSX.utils.book_append_sheet(wb, ws_inv, "Master Barang");
        XLSX.utils.book_append_sheet(wb, ws_hist, "Log Transaksi");
        XLSX.utils.book_append_sheet(wb, ws_pred, "Prediksi Stok");

        // Generate and download the file
        XLSX.writeFile(wb, "stok_perusahaan.xlsx");
        
        console.log("Excel generated and downloaded via SheetJS.");
    } catch (err) {
        console.error("SheetJS Error:", err);
        showToast("Gagal membuat file Excel. Pastikan library XLSX tersedia.", "error", "Ekspor");
    }
}

async function getPredictionLogs(limit = 100, offset = 0) {
    try {
        const url = `${API_BASE_URL}/api/predictions?limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}`;
        const response = await fetch(url);
        if (!response.ok) return [];
        const data = await response.json();
        return Array.isArray(data) ? data : [];
    } catch (e) {
        return [];
    }
}

async function refreshPredictionLogs() {
    const tbody = document.getElementById('prediction-log-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    const rows = await getPredictionLogs(200, 0);
    if (!rows.length) {
        tbody.innerHTML = `
            <tr>
                <td colspan="9" style="text-align:center; color: var(--muted); padding: 1rem;">
                    Belum ada data prediksi.
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = rows.map(r => {
        const reorderNeeded = Boolean(r.reorder_needed);
        const badgeClass = reorderNeeded ? 'rop-badge rop-badge--danger' : 'rop-badge rop-badge--success';
        const badgeText = reorderNeeded ? 'Reorder' : 'Aman';
        return `
            <tr>
                <td>${r.created_at || '-'}</td>
                <td>${r.perusahaan || '-'}</td>
                <td>${r.nama_barang || '-'}</td>
                <td>${(r.target_month || '').slice(0, 10) || '-'}</td>
                <td>${Number(r.prediction || 0).toLocaleString('id-ID')}</td>
                <td>${Number(r.current_stock || 0).toLocaleString('id-ID')}</td>
                <td>${Number(r.needed_stock || 0).toLocaleString('id-ID')}</td>
                <td>${Number(r.reorder_point || 0).toLocaleString('id-ID')}</td>
                <td><span class="${badgeClass}">${badgeText}</span></td>
            </tr>
        `;
    }).join('');
}

async function importFromExcel(input) {
    const file = input.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });

        // Parse Master Barang Sheet
        const ws_inv = workbook.Sheets["Database Master Barang"] || workbook.Sheets["Master Barang"];
        if (!ws_inv) return showToast("Format file salah. Pastikan ada sheet 'Database Master Barang' atau 'Master Barang'.", "error", "Impor");

        const jsonData = XLSX.utils.sheet_to_json(ws_inv);
        
        // Transform Excel data to internal inventory format
        const newInventory = jsonData.map((row, index) => ({
            id: row['ID'] || row['id'] || index + 1,
            perusahaan: row['Perusahaan'] || row['perusahaan'] || row['Nama Perusahaan'],
            barang: row['Barang'] || row['barang'] || row['Nama Barang'],
            satuan: row['Satuan'] || row['satuan'] || 'pcs',
            stok: parseInt(row['Stok'] || row['stok'] || 0),
            status: parseInt(row['Stok'] || row['stok'] || 0) > 0 ? "Ada" : "Tidak Ada",
            lokasi: row['Lokasi'] || row['lokasi'] || 'A-01'
        }));

        if (newInventory.length > 0) {
            await saveInventory(newInventory);
            await fetchInventory();
            await populateCompanyDropdowns();
            showToast(`Berhasil mengimpor ${newInventory.length} data barang.`, "success", "Impor");
        }
        
        // Reset file input
        input.value = '';
    };
    reader.readAsArrayBuffer(file);
}

async function updateStatus(id, selectElem) {
    const newStatus = selectElem.value;
    const prev = selectElem?.dataset?.prev ?? '';
    if (String(prev) === String(newStatus)) return;
    const okConfirm = confirm('Simpan perubahan status?');
    if (!okConfirm) {
        if (selectElem) selectElem.value = prev;
        selectElem.className = `status-toggle ${String(prev) === 'Ada' ? 'ada' : 'tidak-ada'}`;
        return;
    }
    const data = await getInventory();
    const itemIndex = data.findIndex(i => i.id === id);
    if (itemIndex > -1) {
        data[itemIndex].status = newStatus;
        
        // Update class visual
        selectElem.className = `status-toggle ${newStatus === 'Ada' ? 'ada' : 'tidak-ada'}`;
        
        await saveInventory(data, { silent: true });
        await updateKpiCards();
    }
}

async function selectCompany(companyName, itemName = null) {
    await showSection('dashboard');
    const cSelect = document.getElementById('perusahaan');
    if (cSelect) {
        cSelect.value = companyName;
        await updateItems();
        
        if (itemName) {
            setTimeout(() => {
                const iSelect = document.getElementById('nama_barang');
                if (iSelect) {
                    iSelect.value = itemName;
                    iSelect.dispatchEvent(new Event('change'));
                }
            }, 100);
        }
    }
}

// Linear Regression Implementation
function simpleLinearRegression(data) {
    const n = data.length;
    if (n === 0) return { m: 0, b: 0 };
    if (n === 1) return { m: 0, b: data[0].y };

    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let i = 0; i < n; i++) {
        sumX += data[i].x;
        sumY += data[i].y;
        sumXY += data[i].x * data[i].y;
        sumX2 += data[i].x * data[i].x;
    }

    const m = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const b = (sumY - m * sumX) / n;
    return { m, b };
}

function getDayOfYear(date) {
    const start = new Date(date.getFullYear(), 0, 0);
    const diff = date - start;
    const oneDay = 1000 * 60 * 60 * 24;
    return Math.floor(diff / oneDay);
}

async function predictStock() {
    const pSelect = document.getElementById('perusahaan');
    const bSelect = document.getElementById('nama_barang');
    const sSelect = document.getElementById('satuan');
    const tInput = document.getElementById('tanggal');
    const leadTimeInput = document.getElementById('lead-time');
    const serviceLevelSelect = document.getElementById('service-level');
    
    if (!pSelect || !bSelect || !tInput) return;

    const p = pSelect.value;
    const b = bSelect.value;
    const s = sSelect?.value || "";
    const t = tInput.value;
    const lead_time = parseInt(leadTimeInput?.value || '3', 10);
    const service_level = parseFloat(serviceLevelSelect?.value || '0.95');

    const res = document.getElementById('result');
    const unitLabel = document.getElementById('result-unit');
    const locLabel = document.getElementById('storage-location');

    if (!p || !b || !t) return showToast("Lengkapi data prediksi terlebih dahulu.", "error");
    if (!Number.isFinite(lead_time) || lead_time <= 0) {
        if (leadTimeInput) leadTimeInput.value = '1';
        return showToast("Lead time harus lebih dari 0.", "error");
    }

    if (res) res.innerText = "...";
    const curStockVal = document.getElementById('current-stock-val');
    const needStockVal = document.getElementById('needed-stock-val');
    const safetyStockVal = document.getElementById('safety-stock-val');
    const ropVal = document.getElementById('rop-val');
    const metricMae = document.getElementById('metric-mae');
    const metricRmse = document.getElementById('metric-rmse');
    const metricR2 = document.getElementById('metric-r2');
    const metricAcc = document.getElementById('metric-acc');
    const ropStatusVal = document.getElementById('rop-status-val');
    if (curStockVal) curStockVal.innerText = "...";
    if (needStockVal) needStockVal.innerText = "...";
    if (safetyStockVal) safetyStockVal.innerText = "...";
    if (ropVal) ropVal.innerText = "...";
    if (metricMae) metricMae.innerText = "...";
    if (metricRmse) metricRmse.innerText = "...";
    if (metricR2) metricR2.innerText = "...";
    if (metricAcc) metricAcc.innerText = "...";
    if (ropStatusVal) ropStatusVal.innerText = "...";
    
    if (res) res.classList.add('loading-pulse');

    try {
        const response = await fetch(`${API_BASE_URL}/api/predict`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                perusahaan: p,
                nama_barang: b,
                target_date: t,
                lead_time: lead_time,
                service_level: Number.isFinite(service_level) ? service_level : 0.95
            })
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            showToast(err.message || 'Gagal menghitung prediksi.', 'error');
            if (res) res.classList.remove('loading-pulse');
            return;
        }

        const data = await response.json();
        const prediction = Number(data.prediction || 0);
        const current_stock = Number(data.current_stock || 0);
        const needed_stock = Number(data.needed_stock || 0);
        const safety_stock = Number(data.safety_stock || 0);
        const reorder_point = Number(data.reorder_point || 0);
        const lokasi = data.lokasi || "Belum Ditentukan";
        currentPredictItemId = Number(data.inventory_id || 0) || null;

        const isHistoryEmpty = Boolean(data.cold_start);
        const reorderNeeded = Boolean(data.reorder_needed);

        setTimeout(() => {
            if (res) animateValue(res, 0, prediction, 1000);
            if (curStockVal) animateValue(curStockVal, 0, current_stock, 1000);
            if (needStockVal) animateValue(needStockVal, 0, needed_stock, 1000);
            if (safetyStockVal) animateValue(safetyStockVal, 0, safety_stock, 1000);
            if (ropVal) animateValue(ropVal, 0, reorder_point, 1000);

            if (metricMae) metricMae.innerText = (data.metrics?.mae ?? 0).toFixed(2);
            if (metricRmse) metricRmse.innerText = (data.metrics?.rmse ?? 0).toFixed(2);
            if (metricR2) metricR2.innerText = (data.metrics?.r2 ?? 0).toFixed(2);
            if (metricAcc) {
                const acc = Number(data.metrics?.accuracy ?? data.accuracy ?? 0);
                metricAcc.innerText = `${acc.toFixed(1)}%`;
            }

            if (ropStatusVal) {
                ropStatusVal.innerText = reorderNeeded ? 'Reorder' : 'Aman';
                ropStatusVal.classList.toggle('rop-badge--danger', reorderNeeded);
                ropStatusVal.classList.toggle('rop-badge--success', !reorderNeeded);
            }

            const warningBadge = document.getElementById('history-warning');
            if (isHistoryEmpty) {
                if (warningBadge) {
                    const warningText = warningBadge.querySelector('span');
                    const points = Number(data.history_points || 0);
                    const minMonths = Number(data.min_history_months || 3);
                    const reason = String(data.cold_start_reason || '').trim();
                    if (warningText) {
                        if (reason) {
                            warningText.textContent = reason;
                        } else if (points > 0) {
                            warningText.textContent = `Riwayat transaksi belum cukup (${points} bulan). Minimal ${minMonths} bulan data disarankan untuk prediksi akurat.`;
                        } else {
                            warningText.textContent = `Riwayat transaksi belum tersedia. Minimal ${minMonths} bulan data disarankan untuk prediksi akurat.`;
                        }
                    }
                    warningBadge.style.display = 'flex';
                }
            } else {
                if (warningBadge) warningBadge.style.display = 'none';
            }

            renderPredictChart(data.history_series || [], data.target_month || '', prediction);

            if (unitLabel) unitLabel.innerText = s.toUpperCase();
            if (locLabel) locLabel.innerText = lokasi;
            if (res) res.classList.remove('loading-pulse');
        }, 500);
    } catch (e) {
        console.error("Predict error:", e);
        showToast('Terjadi kesalahan jaringan saat prediksi.', 'error');
        if (res) res.classList.remove('loading-pulse');
    }
}

async function saveNewLayout() {
    const locInput = document.getElementById('new-location-input');
    if (!locInput) return;
    const newLoc = locInput.value;
    
    if (!currentPredictItemId) return showToast("Lakukan prediksi barang terlebih dahulu.", "error");
    if (!newLoc) return showToast("Masukkan lokasi baru.", "error");

    const inventory = await getInventory();
    const index = inventory.findIndex(item => item.id === currentPredictItemId);
    if (index !== -1) {
        inventory[index].lokasi = newLoc;
        await saveInventory(inventory);
        const locLabel = document.getElementById('storage-location');
        if (locLabel) locLabel.innerText = newLoc;
        showToast("Lokasi tata letak berhasil diperbarui.", "success");
        await updateKpiCards();
    }
}

// Shelf Visualization
async function openShelfVisualization() {
    const modal = document.getElementById('shelf-modal');
    const grid = document.getElementById('warehouse-grid');
    if (!modal || !grid) return;

    modal.style.display = "block";
    grid.innerHTML = '';

    const inventory = await getInventory();
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
                if (item) cell.title = `${item.barang} (${item.perusahaan})`;
            }
            grid.appendChild(cell);
        }
    });
}

function closeShelfVisualization() {
    const modal = document.getElementById('shelf-modal');
    if (modal) modal.style.display = "none";
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
            obj.innerHTML = end;
        }
    };
    window.requestAnimationFrame(step);
}
