
const initialInventory = [];

let currentPredictItemId = null;

// Global variables to store data
let lastInventoryData = null;
let historicalData = []; // Initialized as empty, will be fetched from server
const historyStorageKey = 'gudang_history';
const themeStorageKey = 'gudang_theme';
let toastTimerId = null;
const recentToastMap = new Map();
let showAllHistoryRows = false;
let _inventoryMemo = { ts: 0, data: null };
let _historyMemo = { ts: 0, key: '', data: null };
let _historyAllMemo = { ts: 0, data: null };
let _historyQuerySupported = true;
let _inventoryFetchErrorShown = false;
let inventorySearchTerm = '';
let inventoryFilterCompany = '';
let inventoryFilterStatus = '';
let inventoryFilterUnit = '';
let lastForecastResult = null;
let activeWorkOrderModal = null;
let bulkImportState = null;
let ropAlertedKeys = new Set();
let _restockMemo = { ts: 0, items: [], map: new Map() };
const ROP_ALERT_KEY = 'gudang_rop_alerts_v1';
const ROP_ALERT_COOLDOWN_MS = 30 * 60 * 1000;
const TOAST_DEDUPE_WINDOW_MS = 12 * 1000;
let _unauthorizedHandled = false;
const UNIT_OPTIONS = [
    { value: 'pcs', label: 'Pieces (pcs)' },
    { value: 'kg', label: 'Kilogram (kg)' },
    { value: 'roll', label: 'Roll' },
    { value: 'meter', label: 'Meter' },
    { value: 'box', label: 'Box' },
    { value: 'set', label: 'Set' },
    { value: 'unit', label: 'Unit' },
    { value: 'pack', label: 'Pack' }
];

function normalizeUnitValue(value) {
    return String(value || '').trim().toLowerCase();
}

function renderUnitOptions(selectedValue = '', includeEmpty = false) {
    const selected = normalizeUnitValue(selectedValue);
    const options = UNIT_OPTIONS.slice();
    if (selected && !options.some(opt => normalizeUnitValue(opt.value) === selected)) {
        options.push({ value: selectedValue, label: selectedValue });
    }
    const rows = [];
    if (includeEmpty) {
        rows.push('<option value="">Pilih Satuan</option>');
    }
    options.forEach(opt => {
        const isSelected = normalizeUnitValue(opt.value) === selected ? 'selected' : '';
        rows.push(`<option value="${_escapeHtml(opt.value)}" ${isSelected}>${_escapeHtml(opt.label)}</option>`);
    });
    return rows.join('');
}

function ensureUnitOption(selectElem, value) {
    if (!selectElem) return;
    const normalized = normalizeUnitValue(value);
    if (!normalized) return;
    const exists = Array.from(selectElem.options || []).some(opt => normalizeUnitValue(opt.value) === normalized);
    if (!exists) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        selectElem.appendChild(option);
    }
    selectElem.value = value;
}

function showToast(message, type = 'info', title = '') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toastKey = `${String(title || '').trim()}|${String(type || '').trim()}|${String(message || '').trim()}`;
    const now = Date.now();
    const lastShownAt = Number(recentToastMap.get(toastKey) || 0);
    if (lastShownAt && (now - lastShownAt) < TOAST_DEDUPE_WINDOW_MS) {
        return;
    }
    recentToastMap.set(toastKey, now);
    Array.from(recentToastMap.entries()).forEach(([key, ts]) => {
        if ((now - Number(ts || 0)) > TOAST_DEDUPE_WINDOW_MS) {
            recentToastMap.delete(key);
        }
    });

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

function _normKeyText(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

function _buildCompanyItemKey(perusahaan, barang) {
    const p = _normKeyText(perusahaan);
    const b = _normKeyText(barang);
    if (!p || !b) return '';
    return `${p}|${b}`;
}

function _handleUnauthorizedOnce() {
    if (_unauthorizedHandled) return;
    _unauthorizedHandled = true;
    sessionStorage.removeItem('gudang_isLoggedIn');
    sessionStorage.removeItem('gudang_token');
    const loginPage = document.getElementById('login-page');
    const mainApp = document.getElementById('main-app');
    if (loginPage) loginPage.style.display = 'flex';
    if (mainApp) mainApp.style.display = 'none';
    showToast('Sesi login habis. Silakan login ulang.', 'error');
}

function getPersistedRopAlerts() {
    try {
        const raw = localStorage.getItem(ROP_ALERT_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function savePersistedRopAlerts(mapObj) {
    try {
        localStorage.setItem(ROP_ALERT_KEY, JSON.stringify(mapObj || {}));
    } catch {
        // ignore storage failures
    }
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
        const response = await fetchApiWithFallback(`/api/history`, {
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
const isFileProtocol = window.location.protocol === 'file:';
const isLocalhost =
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1';
// GANTI URL INI dengan URL Backend Anda (misal dari Render.com) jika sudah hosting backend
const REMOTE_API_URL = 'https://web-production-28984.up.railway.app'; 
const LOCAL_API_URL = 'http://localhost:8000';
const API_BASE_URL = isGitHubPages ? REMOTE_API_URL : (isFileProtocol ? LOCAL_API_URL : '');

function _joinApi(baseUrl, path) {
    if (!baseUrl) return path;
    const b = String(baseUrl).replace(/\/+$/, '');
    const p = String(path || '').startsWith('/') ? String(path) : `/${String(path || '')}`;
    return `${b}${p}`;
}

async function fetchApiWithFallback(path, options = {}) {
    const candidates = [];
    const add = (u) => {
        const s = (u || '').trim();
        if (!candidates.includes(s)) candidates.push(s);
    };

    add(API_BASE_URL);
    if (!isGitHubPages) add('');
    if (isFileProtocol) {
        add(LOCAL_API_URL);
    } else if (isLocalhost) {
        add(LOCAL_API_URL);
    } else {
        add(REMOTE_API_URL);
    }

    let lastNetworkError = null;
    let lastResponse = null;
    for (const base of candidates) {
        try {
            const res = await fetch(_joinApi(base, path), options);
            lastResponse = res;
            if (res.status === 404) continue;
            if (res.status === 401) {
                _handleUnauthorizedOnce();
            }
            return res;
        } catch (e) {
            lastNetworkError = e;
            continue;
        }
    }

    if (lastResponse) return lastResponse;
    throw lastNetworkError || new Error('Network error');
}

async function getInventory() {
    if (_inventoryMemo.data && (Date.now() - _inventoryMemo.ts) < 1500) {
        return _inventoryMemo.data;
    }
    try {
        const response = await fetchApiWithFallback(`/api/inventory`);
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
    if ((!fallback || (Array.isArray(fallback) && fallback.length === 0)) && !_inventoryFetchErrorShown) {
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
        const path = `/api/history?limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}`;
        const response = await fetchApiWithFallback(path);
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
        const response = await fetchApiWithFallback(`/api/history`);
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

    const path = `/api/restock?lead_time=${encodeURIComponent(String(lt))}&service_level=${encodeURIComponent(String(sl))}`;
    try {
        const response = await fetchApiWithFallback(path);
        if (!response.ok) return [];
        const data = await response.json();
        return Array.isArray(data) ? data : [];
    } catch (e) {
        console.warn("Restock fetch failed:", e);
        return [];
    }
}

async function getRestockMapMemo() {
    if (_restockMemo.map && (Date.now() - _restockMemo.ts) < 8000) {
        return _restockMemo.map;
    }
    const items = await getRestockList();
    const map = new Map();
    if (Array.isArray(items)) {
        items.forEach(it => {
            const key = _buildCompanyItemKey(it.perusahaan, it.barang);
            if (!key) return;
            map.set(key, it);
        });
    }
    _restockMemo = { ts: Date.now(), items: Array.isArray(items) ? items : [], map };
    return map;
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

    notifyRopAlerts(items);
}

function notifyRopAlerts(items) {
    if (!Array.isArray(items)) return;
    const reorderItems = items.filter(it => Boolean(it.reorder_needed));
    if (!reorderItems.length) return;
    const activeKeys = new Set(
        reorderItems
            .map(it => _buildCompanyItemKey(it.perusahaan, it.barang))
            .filter(Boolean)
    );
    Array.from(ropAlertedKeys).forEach(key => {
        if (!activeKeys.has(key)) {
            ropAlertedKeys.delete(key);
        }
    });
    const persisted = getPersistedRopAlerts();
    const now = Date.now();
    const newAlerts = [];

    reorderItems.forEach(it => {
        const key = _buildCompanyItemKey(it.perusahaan, it.barang);
        if (!key || ropAlertedKeys.has(key)) return;

        const lastShown = Number(persisted[key] || 0);
        if (lastShown && (now - lastShown) < ROP_ALERT_COOLDOWN_MS) {
            ropAlertedKeys.add(key);
            return;
        }

        ropAlertedKeys.add(key);
        persisted[key] = now;
        newAlerts.push(it);
    });

    savePersistedRopAlerts(persisted);

    if (!newAlerts.length) return;
    const count = newAlerts.length;
    const first = newAlerts[0];
    if (count === 1) {
        showToast(`Stok mencapai ROP: ${first.perusahaan} - ${first.barang}.`, 'error', 'Notifikasi ROP');
        return;
    }
    showToast(`${count} item mencapai ROP. Cek tabel restock untuk detailnya.`, 'error', 'Notifikasi ROP');
}

async function saveInventory(inventory, options = {}) {
    const silent = Boolean(options.silent);

    localStorage.setItem('gudang_inventory', JSON.stringify(inventory));
    lastInventoryData = JSON.stringify(inventory);
    _inventoryMemo = { ts: Date.now(), data: inventory };

    try {
        const token = sessionStorage.getItem('gudang_token') || '';
        const response = await fetchApiWithFallback(`/api/inventory`, {
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
    const restockList = await getRestockList();
    const restockItems = Array.isArray(restockList) ? restockList.filter(r => Boolean(r?.reorder_needed)).length : 0;

    const totalEl = document.getElementById('kpi-total-items');
    const availEl = document.getElementById('kpi-available-items');
    const restockEl = document.getElementById('kpi-restock-items');
    const companyEl = document.getElementById('kpi-total-company');

    if (totalEl) totalEl.textContent = totalItems.toLocaleString('id-ID');
    if (availEl) availEl.textContent = availableItems.toLocaleString('id-ID');
    if (restockEl) restockEl.textContent = restockItems.toLocaleString('id-ID');
    if (companyEl) companyEl.textContent = companies.length.toLocaleString('id-ID');

    const restockCard = document.getElementById('kpi-card-restock');
    if (restockCard) {
        restockCard.classList.toggle('kpi-card--danger', restockItems > 0);
    }
}

let transactionChart = null;
let predictChart = null;
let pvaChart = null;

function initChart(data = []) {
    const ctx = document.getElementById('transactionChart');
    if (!ctx) return;

    const rows = Array.isArray(data) ? data : [];

    const grouped = rows.reduce((acc, curr) => {
        const tanggal = String(curr.tanggal || '').slice(0, 10);
        if (!tanggal) return acc;

        const monthKey = tanggal.slice(0, 7);
        const jenis = String(curr.jenis || curr.jenis_transaksi || '').toLowerCase();
        const isKeluar = jenis ? jenis.includes('keluar') : true;
        if (!isKeluar) return acc;

        const qtyRaw =
            curr.jumlah_keluar ??
            curr.qty_out ??
            curr.jumlah_terjual ??
            curr.jumlah ??
            0;
        const qty = Number(qtyRaw) || 0;
        acc[monthKey] = (acc[monthKey] || 0) + qty;
        return acc;
    }, {});

    const sortedMonths = Object.keys(grouped).sort();
    let labels = sortedMonths.slice(-12);
    if (labels.length === 0) {
        const now = new Date();
        const tmp = [];
        for (let i = 11; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            tmp.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
        }
        labels = tmp;
    }
    const values = labels.map(l => Number(grouped[l] || 0));

    if (transactionChart) {
        transactionChart.destroy();
    }

    transactionChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Permintaan (Keluar)',
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

// Z-score helper
function getZScore(serviceLevel) {
    const sl = Number(serviceLevel);
    if (sl >= 0.99) return 2.33;
    if (sl >= 0.95) return 1.65;
    if (sl >= 0.90) return 1.28;
    return 1.65;
}

// Update Z-score display
function updateZScoreDisplay() {
    const slSelect = document.getElementById('service-level');
    const zDisplay = document.getElementById('z-score-display');
    if (!slSelect || !zDisplay) return;
    const z = getZScore(slSelect.value);
    const slPercent = Math.round(parseFloat(slSelect.value) * 100);
    zDisplay.innerHTML = `Service level ${slPercent}% → Z = ${z.toFixed(2)}`;
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

        // Initialize Z-score display
        updateZScoreDisplay();
        const slSelect = document.getElementById('service-level');
        if (slSelect) {
            slSelect.addEventListener('change', updateZScoreDisplay);
        }
        
        await populateCompanyDropdowns();
        await updateKpiCards();
        await renderRestockList();
        
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

        const invCompany = document.getElementById('inventory-filter-company');
        if (invCompany) {
            invCompany.addEventListener('change', () => {
                inventoryFilterCompany = String(invCompany.value || '');
                const invSection = document.getElementById('section-inventory');
                if (invSection && invSection.style.display !== 'none') {
                    fetchInventory();
                }
            });
        }

        const invStatus = document.getElementById('inventory-filter-status');
        if (invStatus) {
            invStatus.addEventListener('change', () => {
                inventoryFilterStatus = String(invStatus.value || '');
                const invSection = document.getElementById('section-inventory');
                if (invSection && invSection.style.display !== 'none') {
                    fetchInventory();
                }
            });
        }

        const invUnit = document.getElementById('inventory-filter-unit');
        if (invUnit) {
            invUnit.addEventListener('change', () => {
                inventoryFilterUnit = String(invUnit.value || '').trim();
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

            const response = await fetchApiWithFallback(`/api/login`, {
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

function setHistoryExpanded(expanded) {
    showAllHistoryRows = Boolean(expanded);
    const btn = document.getElementById('toggle-history-btn');
    if (btn) btn.textContent = showAllHistoryRows ? 'Tampilkan 10' : 'Lihat Semua';
}

function scrollToHistoryTable() {
    const historySection = document.getElementById('history-table-body');
    if (!historySection) return;
    const tableCard = historySection.closest('.card');
    if (!tableCard || typeof tableCard.scrollIntoView !== 'function') return;
    tableCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
                    <td>${_escapeHtml(h.nomor_dokumen || '-')}</td>
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

    const invCompanyFilter = document.getElementById('inventory-filter-company');
    if (invCompanyFilter) {
        const currentValue = invCompanyFilter.value;
        invCompanyFilter.innerHTML = '<option value="">Semua</option>';
        companies.forEach(company => {
            const opt = document.createElement('option');
            opt.value = company;
            opt.textContent = company;
            invCompanyFilter.appendChild(opt);
        });
        if (currentValue) invCompanyFilter.value = currentValue;
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
    if (sectionId === 'predictions') {
        await populatePrediksiVsAktualFilters();
        await refreshPredictionLogs();
        await renderPrediksiVsAktual(true);
    }
    if (sectionId === 'planning') await renderWorkOrders();
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
            ensureUnitOption(unitSelect, selected.dataset.satuan);
        }
    };
}

async function fetchInventory() {
    const tbody = document.getElementById('inventory-table-body');
    const hbody = document.getElementById('history-table-body');
    if (!tbody) return;
    
    const data = await getInventory();
    const restockMap = await getRestockMapMemo();
    let filtered = Array.isArray(data) ? data.slice() : [];

    if (inventorySearchTerm) {
        filtered = filtered.filter(item => {
            const perusahaan = String(item.perusahaan || '').toLowerCase();
            const barang = String(item.barang || '').toLowerCase();
            const lokasi = String(item.lokasi || '').toLowerCase();
            const satuan = String(item.satuan || '').toLowerCase();
            return perusahaan.includes(inventorySearchTerm) || barang.includes(inventorySearchTerm) || lokasi.includes(inventorySearchTerm) || satuan.includes(inventorySearchTerm);
        });
    }

    if (inventoryFilterCompany) {
        filtered = filtered.filter(item => String(item.perusahaan || '') === String(inventoryFilterCompany));
    }
    if (inventoryFilterStatus) {
        filtered = filtered.filter(item => String(item.status || '') === String(inventoryFilterStatus));
    }
    if (inventoryFilterUnit) {
        const u = String(inventoryFilterUnit || '').toLowerCase();
        filtered = filtered.filter(item => String(item.satuan || '').toLowerCase().includes(u));
    }
    
    tbody.innerHTML = filtered.map(item => {
        const statusClass = item.status === 'Ada' ? 'ada' : 'tidak-ada';
        const key = _buildCompanyItemKey(item.perusahaan, item.barang);
        const ropInfo = key ? restockMap.get(key) : null;
        const isRop = Boolean(ropInfo?.reorder_needed);
        const ropBadge = isRop ? `<span class="rop-badge rop-badge--danger" style="white-space:nowrap;">ROP</span>` : '';
        const rowStyle = isRop ? ` style="background: rgba(220, 38, 38, 0.06);"` : '';
        return `
            <tr${rowStyle}>
                <td>${item.perusahaan}</td>
                <td>${item.barang}</td>
                <td>
                    <div class="edit-stock-cell">
                        <input type="number" value="${item.stok}" class="stock-input" onfocus="this.dataset.prev=this.value" onchange="updateStock(${item.id}, this)">
                    </div>
                </td>
                <td>
                    <select class="stock-input" onfocus="this.dataset.prev=this.value" onchange="updateUnit(${item.id}, this)">
                        ${renderUnitOptions(item.satuan || '', false)}
                    </select>
                </td>
                <td>${item.lokasi}</td>
                <td>
                    <div style="display:flex; align-items:center; gap:10px;">
                        <select class="status-toggle ${statusClass}" onfocus="this.dataset.prev=this.value" onchange="updateStatus(${item.id}, this)">
                            <option value="Ada" ${item.status === 'Ada' ? 'selected' : ''}>Ada</option>
                            <option value="Tidak Ada" ${item.status === 'Tidak Ada' ? 'selected' : ''}>Tidak Ada</option>
                        </select>
                        ${ropBadge}
                    </div>
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
            ensureUnitOption(unitSelect, selected.dataset.satuan);
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
        const response = await fetchApiWithFallback(`/api/stock-in`, {
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

    try {
        const token = sessionStorage.getItem('gudang_token') || '';
        const response = await fetchApiWithFallback(`/api/inventory/add`, {
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
    
    _inventoryMemo = { ts: 0, data: null };
    lastInventoryData = null;
    toggleAddForm();
    await fetchInventory();
    await populateCompanyDropdowns();
    await updateKpiCards();
}

async function deleteInventoryItem(id) {
    const okConfirm = confirm('Hapus barang ini?');
    if (!okConfirm) return;

    try {
        const token = sessionStorage.getItem('gudang_token') || '';
        const response = await fetchApiWithFallback(`/api/inventory/${encodeURIComponent(String(id))}`, {
            method: 'DELETE',
            headers: { 'X-Auth-Token': token }
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            showToast(err.message || 'Gagal menghapus barang.', 'error');
            return;
        }
        showToast('Barang dihapus.', 'success');
        _inventoryMemo = { ts: 0, data: null };
        lastInventoryData = null;
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
    const algorithm = 'xgboost';

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
        const response = await fetchApiWithFallback(`/api/predict`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                perusahaan: it.perusahaan,
                nama_barang: it.nama_barang,
                target_date,
                lead_time: Number.isFinite(lead_time) && lead_time > 0 ? lead_time : 3,
                service_level: Number.isFinite(service_level) ? service_level : 0.95,
                algorithm
            })
        });
        if (!response.ok) return null;
        const data = await response.json();
        return {
            'Perusahaan': data.perusahaan,
            'Nama Barang': data.nama_barang,
            'Target Bulan': (data.target_month || '').slice(0, 10),
            'Algoritma': String(data.algorithm || algorithm),
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
            'MAPE': Number(data.metrics?.mape ?? 0),
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
        const path = `/api/predictions?limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}`;
        const response = await fetchApiWithFallback(path);
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
                <td colspan="12" style="text-align:center; color: var(--muted); padding: 1rem;">
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
                <td>${r.algorithm || r.metode || 'Formula Statistik'}</td>
                <td>${Number(r.avg_demand || r.avgDemand || 0).toLocaleString('id-ID')}</td>
                <td>${Number(r.std_dev || r.stdDev || 0).toLocaleString('id-ID')}</td>
                <td>${Number(r.prediction || 0).toLocaleString('id-ID')}</td>
                <td>${Number(r.current_stock || 0).toLocaleString('id-ID')}</td>
                <td>${Number(r.needed_stock || 0).toLocaleString('id-ID')}</td>
                <td>${Number(r.reorder_point || 0).toLocaleString('id-ID')}</td>
                <td><span class="${badgeClass}">${badgeText}</span></td>
            </tr>
        `;
    }).join('');
}

async function populatePrediksiVsAktualFilters() {
    const pSel = document.getElementById('pva-perusahaan');
    const bSel = document.getElementById('pva-barang');
    if (!pSel || !bSel) return;

    const inventory = await getInventory();
    const companies = [...new Set(inventory.map(i => String(i.perusahaan || '').trim()).filter(Boolean))].sort();

    const prevCompany = pSel.value || '';
    pSel.innerHTML = '<option value="" disabled selected>Pilih Perusahaan</option>';
    companies.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = c;
        pSel.appendChild(opt);
    });

    const desiredCompany = String(lastForecastResult?.perusahaan || prevCompany || companies[0] || '');
    if (desiredCompany) pSel.value = desiredCompany;

    const fillItems = (company) => {
        const items = inventory
            .filter(i => String(i.perusahaan || '') === String(company || ''))
            .map(i => String(i.barang || '').trim())
            .filter(Boolean);
        const uniqueItems = [...new Set(items)].sort();
        const prevItem = bSel.value || '';
        bSel.innerHTML = '<option value="" disabled selected>Pilih Barang</option>';
        uniqueItems.forEach(nm => {
            const opt = document.createElement('option');
            opt.value = nm;
            opt.textContent = nm;
            bSel.appendChild(opt);
        });
        const desiredItem = String(lastForecastResult?.nama_barang || prevItem || uniqueItems[0] || '');
        if (desiredItem) bSel.value = desiredItem;
    };

    fillItems(pSel.value);
    pSel.onchange = () => {
        fillItems(pSel.value);
    };
}

async function renderPrediksiVsAktual(silent = false) {
    const pSel = document.getElementById('pva-perusahaan');
    const bSel = document.getElementById('pva-barang');
    const canvas = document.getElementById('pvaChart');
    if (!pSel || !bSel || !canvas) return;

    const perusahaan = String(pSel.value || '').trim();
    const nama_barang = String(bSel.value || '').trim();
    if (!perusahaan || !nama_barang) {
        if (!silent) showToast('Pilih perusahaan dan barang untuk menampilkan grafik.', 'error');
        return;
    }

    try {
        const path = `/api/predictions-vs-actual?perusahaan=${encodeURIComponent(perusahaan)}&nama_barang=${encodeURIComponent(nama_barang)}&months=12`;
        const response = await fetchApiWithFallback(path);
        if (!response.ok) {
            const msg = await readApiErrorMessage(response);
            if (!silent) showToast(msg || 'Gagal memuat grafik prediksi vs aktual.', 'error');
            return;
        }
        const data = await response.json().catch(() => ({}));
        const series = Array.isArray(data.series) ? data.series : [];

        const labels = series.map(x => String(x.month || '').slice(0, 7));
        const actual = series.map(x => (x.actual == null ? null : Number(x.actual || 0)));
        const predicted = series.map(x => (x.predicted == null ? null : Number(x.predicted || 0)));

        if (pvaChart) pvaChart.destroy();
        pvaChart = new Chart(canvas, {
            type: 'line',
            data: {
                labels,
                datasets: [
                    {
                        label: 'Aktual (Keluar)',
                        data: actual,
                        borderColor: '#16a34a',
                        backgroundColor: 'rgba(22, 163, 74, 0.08)',
                        borderWidth: 3,
                        tension: 0.35,
                        fill: true,
                        pointRadius: 4
                    },
                    {
                        label: 'Prediksi',
                        data: predicted,
                        borderColor: '#4f46e5',
                        borderWidth: 3,
                        borderDash: [8, 6],
                        tension: 0.35,
                        fill: false,
                        pointRadius: 4
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: true },
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
    } catch (e) {
        if (!silent) showToast('Terjadi kesalahan jaringan saat memuat grafik.', 'error');
    }
}

async function compareAlgoritma() {
    const pSel = document.getElementById('pva-perusahaan');
    const bSel = document.getElementById('pva-barang');
    const wrap = document.getElementById('algo-compare-wrap');
    if (!pSel || !bSel || !wrap) return;

    const perusahaan = String(pSel.value || '').trim();
    const nama_barang = String(bSel.value || '').trim();
    if (!perusahaan || !nama_barang) {
        showToast('Pilih perusahaan dan barang untuk komparasi.', 'error');
        return;
    }

    wrap.innerHTML = 'Memuat komparasi...';
    try {
        const response = await fetchApiWithFallback(`/api/compare-algorithms`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ perusahaan, nama_barang })
        });
        if (!response.ok) {
            const msg = await readApiErrorMessage(response);
            wrap.innerHTML = _escapeHtml(msg || 'Gagal memuat komparasi.');
            return;
        }
        const data = await response.json().catch(() => ({}));
        const results = Array.isArray(data.results) ? data.results : [];
        if (!results.length) {
            wrap.innerHTML = 'Tidak ada data komparasi.';
            return;
        }

        const rowsHtml = results.map(r => {
            const algo = String(r.algorithm || '-');
            const ok = Boolean(r.available);
            const mae = Number(r.metrics?.mae || 0);
            const rmse = Number(r.metrics?.rmse || 0);
            const mape = Number(r.metrics?.mape || 0);
            const msg = String(r.message || '');
            return `
                <tr>
                    <td>${_escapeHtml(algo)}</td>
                    <td>${ok ? 'OK' : 'Tidak'}</td>
                    <td>${mae.toFixed(2)}</td>
                    <td>${rmse.toFixed(2)}</td>
                    <td>${mape.toFixed(2)}%</td>
                    <td>${_escapeHtml(msg || '-')}</td>
                </tr>
            `;
        }).join('');

        wrap.innerHTML = `
            <div class="table-container">
                <table class="modern-table">
                    <thead>
                        <tr>
                            <th>Algoritma</th>
                            <th>Tersedia</th>
                            <th>MAE</th>
                            <th>RMSE</th>
                            <th>MAPE</th>
                            <th>Catatan</th>
                        </tr>
                    </thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
            </div>
        `;
    } catch (e) {
        wrap.innerHTML = 'Terjadi kesalahan jaringan.';
    }
}

function printPredictionsReport() {
    const pSel = document.getElementById('pva-perusahaan');
    const bSel = document.getElementById('pva-barang');
    const perusahaan = String(pSel?.value || '').trim();
    const nama_barang = String(bSel?.value || '').trim();
    if (!perusahaan || !nama_barang) {
        showToast('Pilih perusahaan dan barang sebelum ekspor PDF.', 'error');
        return;
    }

    const canvas = document.getElementById('pvaChart');
    const chartImg = canvas && typeof canvas.toDataURL === 'function' ? canvas.toDataURL('image/png') : '';

    const rows = Array.from(document.querySelectorAll('#prediction-log-body tr')).slice(0, 50).map(tr => {
        const tds = Array.from(tr.querySelectorAll('td')).map(td => td.textContent || '');
        return tds;
    });

    const head = ['Waktu', 'Perusahaan', 'Barang', 'Target', 'Algoritma', 'Prediksi', 'Stok', 'Perlu', 'ROP', 'Status'];
    const tableHead = head.map(h => `<th>${_escapeHtml(h)}</th>`).join('');
    const tableBody = rows.map(cols => `<tr>${cols.map(c => `<td>${_escapeHtml(c)}</td>`).join('')}</tr>`).join('');

    const html = `
        <!doctype html>
        <html>
        <head>
            <meta charset="utf-8">
            <title>Laporan Prediksi - ${_escapeHtml(perusahaan)} - ${_escapeHtml(nama_barang)}</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 22px; color: #111; }
                h1 { font-size: 16px; margin: 0 0 4px 0; }
                .sub { font-size: 12px; color: #444; margin-bottom: 12px; }
                img { width: 100%; max-height: 340px; object-fit: contain; border: 1px solid #ddd; border-radius: 10px; }
                table { width: 100%; border-collapse: collapse; margin-top: 14px; font-size: 11px; }
                th, td { border: 1px solid #ddd; padding: 6px; text-align: left; vertical-align: top; }
                th { background: #f3f4f6; font-weight: 700; }
                @media print { body { padding: 0; } }
            </style>
        </head>
        <body>
            <h1>Laporan Prediksi vs Aktual</h1>
            <div class="sub">${_escapeHtml(perusahaan)} — ${_escapeHtml(nama_barang)}</div>
            ${chartImg ? `<img src="${chartImg}" alt="Grafik">` : ''}
            <table>
                <thead><tr>${tableHead}</tr></thead>
                <tbody>${tableBody}</tbody>
            </table>
            <script>window.focus(); window.print();</script>
        </body>
        </html>
    `;

    const w = window.open('', '_blank');
    if (!w) {
        showToast('Popup diblokir browser. Izinkan popup untuk ekspor PDF.', 'error');
        return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
}

async function getWorkOrders(limit = 200, offset = 0) {
    try {
        const path = `/api/work-orders?limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}`;
        const response = await fetchApiWithFallback(path);
        if (!response.ok) return [];
        const data = await response.json();
        return Array.isArray(data) ? data : [];
    } catch (e) {
        return [];
    }
}

async function renderWorkOrders() {
    const tbody = document.getElementById('workorder-table-body');
    const empty = document.getElementById('workorder-empty');
    if (!tbody) return;

    const rows = await getWorkOrders(200, 0);
    tbody.innerHTML = '';

    if (!rows.length) {
        if (empty) empty.style.display = 'block';
        return;
    }
    if (empty) empty.style.display = 'none';

    tbody.innerHTML = rows.map(r => {
        const id = Number(r.id || 0);
        const status = String(r.status || 'Draft');
        const badgeClass =
            status === 'Completed' ? 'rop-badge rop-badge--success' :
            status === 'Cancelled' ? 'rop-badge rop-badge--danger' :
            status === 'In Progress' ? 'rop-badge' :
            status === 'Released' ? 'rop-badge' :
            'rop-badge';

        return `
            <tr>
                <td>${r.created_at || '-'}</td>
                <td>${r.perusahaan || '-'}</td>
                <td>${r.barang || '-'}</td>
                <td>${(r.target_month || '').slice(0, 10) || '-'}</td>
                <td>${Number(r.planned_qty || 0).toLocaleString('id-ID')} ${String(r.unit || '').trim()}</td>
                <td><span class="${badgeClass}">${status}</span></td>
                <td>
                    <button class="btn-table" onclick="openWorkOrderModal(${id})">Buka</button>
                </td>
            </tr>
        `;
    }).join('');
}

async function readApiErrorMessage(response) {
    try {
        const cloned = response.clone();
        try {
            const data = await response.json();
            const msg = (data && typeof data.message === 'string') ? data.message.trim() : '';
            const url = String(response?.url || '').trim();
            if (msg) return url ? `${msg} (URL: ${url})` : msg;
            return url ? `HTTP ${response.status} (URL: ${url})` : `HTTP ${response.status}`;
        } catch {
            const text = await cloned.text().catch(() => '');
            const snippet = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
            const url = String(response?.url || '').trim();
            if (snippet) return url ? `HTTP ${response.status} (URL: ${url}): ${snippet}` : `HTTP ${response.status}: ${snippet}`;
            return url ? `HTTP ${response.status} (URL: ${url})` : `HTTP ${response.status}`;
        }
    } catch {
        return `HTTP ${response?.status || 'error'}`;
    }
}

function _escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function closeWorkOrderModal() {
    const modal = document.getElementById('workorder-modal');
    if (modal) modal.style.display = 'none';
    activeWorkOrderModal = null;
}

async function openWorkOrderModal(id) {
    const woId = Number(id || 0);
    if (!woId) return;

    const modal = document.getElementById('workorder-modal');
    const body = document.getElementById('workorder-modal-body');
    if (!modal || !body) return;

    body.innerHTML = 'Memuat...';
    modal.style.display = 'block';

    try {
        const response = await fetchApiWithFallback(`/api/work-orders/${encodeURIComponent(String(woId))}`);
        if (!response.ok) {
            const msg = await readApiErrorMessage(response);
            body.innerHTML = _escapeHtml(msg || 'Gagal memuat work order.');
            return;
        }

        const data = await response.json().catch(() => ({}));
        const wo = data.work_order || {};
        activeWorkOrderModal = { id: woId, wo };

        const status = String(wo.status || 'Draft');
        const due = String(wo.due_date || '').slice(0, 10);
        const notes = String(wo.notes || '');
        const instr = String(wo.instructions || '');
        const qtyText = `${Number(wo.planned_qty || 0).toLocaleString('id-ID')} ${String(wo.unit || '').trim()}`.trim();

        body.innerHTML = `
            <div class="form-container">
                <div class="form-row">
                    <div class="form-group">
                        <label>ID</label>
                        <input type="text" id="wo-m-id" value="${_escapeHtml(String(wo.id || woId))}" readonly>
                    </div>
                    <div class="form-group">
                        <label>Tanggal</label>
                        <input type="text" id="wo-m-created" value="${_escapeHtml(String(wo.created_at || '-'))}" readonly>
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label>Perusahaan</label>
                        <input type="text" id="wo-m-perusahaan" value="${_escapeHtml(String(wo.perusahaan || ''))}" readonly>
                    </div>
                    <div class="form-group">
                        <label>Barang</label>
                        <input type="text" id="wo-m-barang" value="${_escapeHtml(String(wo.barang || ''))}" readonly>
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label>Target Bulan</label>
                        <input type="text" id="wo-m-target" value="${_escapeHtml(String(wo.target_month || '').slice(0, 10))}" readonly>
                    </div>
                    <div class="form-group">
                        <label>Qty Produksi</label>
                        <input type="text" id="wo-m-qty" value="${_escapeHtml(qtyText)}" readonly>
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label>Status</label>
                        <select id="wo-m-status" class="status-toggle">
                            <option value="Draft">Draft</option>
                            <option value="Released">Released</option>
                            <option value="In Progress">In Progress</option>
                            <option value="Completed">Completed</option>
                            <option value="Cancelled">Cancelled</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Due Date</label>
                        <input type="date" id="wo-m-due-date" value="${_escapeHtml(due)}">
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group" style="flex: 1;">
                        <label>Catatan</label>
                        <input type="text" id="wo-m-notes" value="${_escapeHtml(notes)}" placeholder="Catatan tambahan (opsional)">
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group" style="flex: 1;">
                        <label>Instruksi</label>
                        <pre id="wo-m-instructions" style="white-space: pre-wrap; background: var(--bg-main); border: 1px solid var(--glass-border); padding: 1rem; border-radius: var(--radius-lg); font-weight: 700; line-height: 1.5;">${_escapeHtml(instr || '-')}</pre>
                    </div>
                </div>
            </div>
        `;

        const statusSelect = document.getElementById('wo-m-status');
        if (statusSelect) statusSelect.value = status;

        if (!modal.dataset.bound) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) closeWorkOrderModal();
            });
            modal.dataset.bound = '1';
        }
    } catch (e) {
        body.innerHTML = _escapeHtml('Terjadi kesalahan jaringan saat memuat work order.');
    }
}

async function saveWorkOrderModal() {
    const id = Number(activeWorkOrderModal?.id || 0);
    if (!id) return;

    const status = (document.getElementById('wo-m-status')?.value || '').trim();
    const due_date = (document.getElementById('wo-m-due-date')?.value || '').trim();
    const notes = (document.getElementById('wo-m-notes')?.value || '').trim();

    try {
        const token = sessionStorage.getItem('gudang_token') || '';
        const response = await fetchApiWithFallback(`/api/work-orders/${encodeURIComponent(String(id))}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
            body: JSON.stringify({ status, due_date: due_date || null, notes })
        });
        if (!response.ok) {
            const msg = await readApiErrorMessage(response);
            return showToast(msg || 'Gagal menyimpan work order.', 'error');
        }
        const data = await response.json().catch(() => ({}));
        const instr = String(data.instructions || '').trim();
        const pre = document.getElementById('wo-m-instructions');
        if (pre && instr) pre.textContent = instr;
        showToast('Work order tersimpan.', 'success');
        await renderWorkOrders();
    } catch (e) {
        showToast('Terjadi kesalahan jaringan saat menyimpan work order.', 'error');
    }
}

function printWorkOrderModal() {
    const id = Number(activeWorkOrderModal?.id || 0);
    if (!id) return;

    const perusahaan = document.getElementById('wo-m-perusahaan')?.value || '';
    const barang = document.getElementById('wo-m-barang')?.value || '';
    const target = document.getElementById('wo-m-target')?.value || '';
    const qty = document.getElementById('wo-m-qty')?.value || '';
    const status = document.getElementById('wo-m-status')?.value || '';
    const due = document.getElementById('wo-m-due-date')?.value || '';
    const notes = document.getElementById('wo-m-notes')?.value || '';
    const instr = document.getElementById('wo-m-instructions')?.textContent || '';

    const html = `
        <!doctype html>
        <html>
        <head>
            <meta charset="utf-8">
            <title>WO-${_escapeHtml(String(id))}</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 24px; color: #111; }
                h1 { font-size: 18px; margin: 0 0 12px 0; }
                .meta { margin-bottom: 14px; }
                .row { display: flex; gap: 18px; margin: 6px 0; }
                .item { flex: 1; }
                .label { font-size: 12px; color: #444; font-weight: 700; margin-bottom: 2px; }
                .val { font-size: 13px; }
                pre { white-space: pre-wrap; border: 1px solid #ccc; padding: 12px; border-radius: 8px; font-size: 12px; line-height: 1.5; }
                @media print { body { padding: 0; } }
            </style>
        </head>
        <body>
            <h1>WORK ORDER PRODUKSI</h1>
            <div class="meta">
                <div class="row">
                    <div class="item"><div class="label">WO ID</div><div class="val">${_escapeHtml(String(id))}</div></div>
                    <div class="item"><div class="label">Status</div><div class="val">${_escapeHtml(String(status))}</div></div>
                </div>
                <div class="row">
                    <div class="item"><div class="label">Perusahaan</div><div class="val">${_escapeHtml(String(perusahaan))}</div></div>
                    <div class="item"><div class="label">Barang</div><div class="val">${_escapeHtml(String(barang))}</div></div>
                </div>
                <div class="row">
                    <div class="item"><div class="label">Target Bulan</div><div class="val">${_escapeHtml(String(target))}</div></div>
                    <div class="item"><div class="label">Qty Produksi</div><div class="val">${_escapeHtml(String(qty))}</div></div>
                </div>
                <div class="row">
                    <div class="item"><div class="label">Due Date</div><div class="val">${_escapeHtml(String(due || '-'))}</div></div>
                    <div class="item"><div class="label">Catatan</div><div class="val">${_escapeHtml(String(notes || '-'))}</div></div>
                </div>
            </div>
            <div class="label">Instruksi</div>
            <pre>${_escapeHtml(instr || '')}</pre>
            <script>window.focus(); window.print();</script>
        </body>
        </html>
    `;

    const w = window.open('', '_blank');
    if (!w) {
        showToast('Popup diblokir browser. Izinkan popup untuk print.', 'error');
        return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
}

function getBulkImportConfig(mode = 'barang_keluar') {
    if (String(mode) === 'finish_good') {
        return {
            mode: 'finish_good',
            title: 'Import Stok Finish Good (Excel)',
            required: ['perusahaan', 'nama_barang', 'stok'],
            labels: {
                perusahaan: 'Kolom Perusahaan',
                nama_barang: 'Kolom Barang',
                satuan: 'Kolom Satuan',
                stok: 'Kolom Stok',
                lokasi: 'Kolom Lokasi (opsional)'
            }
        };
    }
    return {
        mode: 'barang_keluar',
        title: 'Import Data Barang Keluar (CSV/Excel)',
        required: ['doc_number', 'tanggal', 'perusahaan', 'nama_barang', 'qty_out'],
        labels: {
            doc_number: 'Kolom Nomor Dokumen/Transaksi',
            tanggal: 'Kolom Tanggal',
            perusahaan: 'Kolom Perusahaan',
            nama_barang: 'Kolom Barang',
            satuan: 'Kolom Satuan (opsional)',
            qty_out: 'Kolom Qty Keluar',
            qty_in: 'Kolom Qty Masuk (opsional)'
        }
    };
}

function downloadExcelTemplate(mode = 'barang_keluar') {
    if (typeof XLSX === 'undefined') {
        showToast('Library XLSX belum tersedia.', 'error');
        return;
    }

    const isFinishGood = String(mode) === 'finish_good';
    const rows = isFinishGood
        ? [
            {
                'Perusahaan': 'PT. Contoh Indonesia',
                'Nama Barang': 'FINISH GOOD A',
                'Satuan': 'pcs',
                'Stok': 1500,
                'Lokasi': 'FG-01'
            }
        ]
        : [
            {
                'Nomor Dokumen': 'DO-2026-0001',
                'Tanggal': '2026-06-01',
                'Perusahaan': 'PT. Contoh Indonesia',
                'Nama Barang': 'FINISH GOOD A',
                'Satuan': 'pcs',
                'Qty Keluar': 250,
                'Qty Masuk': 0
            }
        ];

    const infoRows = isFinishGood
        ? [
            { 'Petunjuk': 'Isi kolom Perusahaan, Nama Barang, Satuan, Stok, dan Lokasi.' },
            { 'Petunjuk': 'Kolom Lokasi boleh dikosongkan, default akan menjadi A-01.' },
            { 'Petunjuk': 'Nilai stok harus berupa angka 0 atau lebih.' }
        ]
        : [
            { 'Petunjuk': 'Isi kolom Nomor Dokumen/Transaksi agar sistem dapat mendeteksi data yang sudah pernah diimport.' },
            { 'Petunjuk': 'Isi kolom Tanggal, Perusahaan, Nama Barang, dan Qty Keluar.' },
            { 'Petunjuk': 'Format tanggal yang disarankan: YYYY-MM-DD.' },
            { 'Petunjuk': 'Qty Masuk opsional, isi 0 jika tidak ada barang masuk.' }
        ];

    const wb = XLSX.utils.book_new();
    const wsData = XLSX.utils.json_to_sheet(rows);
    const wsInfo = XLSX.utils.json_to_sheet(infoRows);
    XLSX.utils.book_append_sheet(wb, wsData, 'Template');
    XLSX.utils.book_append_sheet(wb, wsInfo, 'Petunjuk');

    const filename = isFinishGood ? 'template_stok_finish_good.xlsx' : 'template_barang_keluar.xlsx';
    XLSX.writeFile(wb, filename);
    showToast(`Template ${isFinishGood ? 'stok finish good' : 'barang keluar'} berhasil diunduh.`, 'success');
}

function openBulkImport(mode = 'barang_keluar') {
    const input = document.getElementById('bulk-import-file');
    const title = document.getElementById('bulk-import-title');
    const wrap = document.getElementById('bulk-apply-wrap');
    const checkbox = document.getElementById('bulk-apply-inventory');
    const config = getBulkImportConfig(mode);
    bulkImportState = { mode: config.mode, raw: [], headers: [], mapping: {} };
    if (title) title.textContent = config.title;
    if (wrap) wrap.style.display = config.mode === 'barang_keluar' ? 'flex' : 'none';
    if (checkbox) checkbox.checked = false;
    if (!input) return;
    input.value = '';
    input.click();
}

function closeBulkImportModal() {
    const modal = document.getElementById('bulk-import-modal');
    if (modal) modal.style.display = 'none';
    bulkImportState = null;
}

function setBulkImportSubmitting(isSubmitting) {
    const submitBtn = document.querySelector('#bulk-import-modal button[onclick="submitBulkImport()"]');
    if (!submitBtn) return;
    submitBtn.disabled = Boolean(isSubmitting);
    submitBtn.style.opacity = isSubmitting ? '0.7' : '';
    submitBtn.style.cursor = isSubmitting ? 'not-allowed' : '';
    submitBtn.textContent = isSubmitting ? 'Mengimpor...' : 'Import';
}

function _normHeader(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[\s\-_]+/g, '')
        .replace(/[^a-z0-9]/g, '');
}

function _autoMapHeaders(headers, mode = 'barang_keluar') {
    const map = {};
    const normToHeader = new Map();
    headers.forEach(h => {
        normToHeader.set(_normHeader(h), h);
    });

    const find = (...candidates) => {
        for (const c of candidates) {
            const h = normToHeader.get(_normHeader(c));
            if (h) return h;
        }
        for (const h of headers) {
            const nh = _normHeader(h);
            for (const c of candidates) {
                if (nh.includes(_normHeader(c))) return h;
            }
        }
        return '';
    };

    map.perusahaan = find('perusahaan', 'company', 'companyname', 'customer');
    map.nama_barang = find('nama_barang', 'barang', 'item', 'itemname', 'product');
    map.satuan = find('satuan', 'unit', 'uom');
    if (String(mode) === 'finish_good') {
        map.stok = find('stok', 'stock', 'qty', 'jumlah_stok', 'finishgood', 'stokakhir');
        map.lokasi = find('lokasi', 'location', 'rak', 'bin');
        return map;
    }
    map.doc_number = find('nomor_dokumen', 'nomortransaksi', 'nomor_dokumen_transaksi', 'document_number', 'transaction_number', 'nodokumen', 'notransaksi', 'docnumber', 'transactionno', 'documentno', 'no dokumen', 'no transaksi');
    map.tanggal = find('tanggal', 'date', 'tgl', 'transactiondate');
    map.qty_out = find('qty_out', 'jumlah_keluar', 'keluar', 'qty', 'jumlah', 'po', 'orderqty');
    map.qty_in = find('qty_in', 'jumlah_masuk', 'masuk', 'in');
    return map;
}

async function handleBulkImportFile(input) {
    const file = input?.files?.[0];
    if (!file) return;
    if (typeof XLSX === 'undefined') {
        showToast('Library XLSX belum tersedia.', 'error');
        return;
    }

    const modal = document.getElementById('bulk-import-modal');
    const body = document.getElementById('bulk-import-body');
    if (!modal || !body) return;
    body.innerHTML = 'Memuat file...';
    modal.style.display = 'block';

    try {
        const ext = String(file.name || '').toLowerCase();
        const isCsv = ext.endsWith('.csv');

        const data = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = reject;
            if (isCsv) reader.readAsText(file);
            else reader.readAsArrayBuffer(file);
        });

        let wb;
        if (isCsv) {
            wb = XLSX.read(String(data || ''), { type: 'string' });
        } else {
            wb = XLSX.read(data, { type: 'array' });
        }

        const sheetName = wb.SheetNames?.[0];
        const ws = wb.Sheets?.[sheetName];
        if (!ws) {
            body.innerHTML = 'Sheet tidak ditemukan.';
            return;
        }

        const json = XLSX.utils.sheet_to_json(ws, { defval: '' });
        if (!Array.isArray(json) || json.length === 0) {
            body.innerHTML = 'Data kosong.';
            return;
        }

        const headers = Object.keys(json[0] || {});
        const mode = String(bulkImportState?.mode || 'barang_keluar');
        const config = getBulkImportConfig(mode);
        const mapping = _autoMapHeaders(headers, mode);
        bulkImportState = { raw: json, headers, mapping, mode };

        const title = document.getElementById('bulk-import-title');
        const wrap = document.getElementById('bulk-apply-wrap');
        if (title) title.textContent = config.title;
        if (wrap) wrap.style.display = mode === 'barang_keluar' ? 'flex' : 'none';

        const selectHtml = (id, label, selected) => {
            const opts = [''].concat(headers).map(h => {
                const sel = String(h) === String(selected) ? 'selected' : '';
                const text = h ? _escapeHtml(h) : '-';
                const val = _escapeHtml(h);
                return `<option value="${val}" ${sel}>${text}</option>`;
            }).join('');
            return `
                <div class="form-group">
                    <label>${_escapeHtml(label)}</label>
                    <select id="${_escapeHtml(id)}" class="stock-input">${opts}</select>
                </div>
            `;
        };

        const previewRows = json.slice(0, 10);
        const previewCols = headers.slice(0, 8);
        const previewHead = previewCols.map(h => `<th>${_escapeHtml(h)}</th>`).join('');
        const previewBody = previewRows.map(r => {
            const tds = previewCols.map(h => `<td>${_escapeHtml(r?.[h] ?? '')}</td>`).join('');
            return `<tr>${tds}</tr>`;
        }).join('');

        const mappingRows = mode === 'finish_good'
            ? `
                <div class="form-row">
                    ${selectHtml('map-perusahaan', config.labels.perusahaan, mapping.perusahaan)}
                    ${selectHtml('map-barang', config.labels.nama_barang, mapping.nama_barang)}
                    ${selectHtml('map-satuan', config.labels.satuan, mapping.satuan)}
                </div>
                <div class="form-row">
                    ${selectHtml('map-stok', config.labels.stok, mapping.stok)}
                    ${selectHtml('map-lokasi', config.labels.lokasi, mapping.lokasi)}
                </div>
            `
            : `
                <div class="form-row">
                    ${selectHtml('map-doc-number', config.labels.doc_number, mapping.doc_number)}
                    ${selectHtml('map-tanggal', config.labels.tanggal, mapping.tanggal)}
                    ${selectHtml('map-perusahaan', config.labels.perusahaan, mapping.perusahaan)}
                </div>
                <div class="form-row">
                    ${selectHtml('map-barang', config.labels.nama_barang, mapping.nama_barang)}
                    ${selectHtml('map-satuan', config.labels.satuan, mapping.satuan)}
                    ${selectHtml('map-qtyout', config.labels.qty_out, mapping.qty_out)}
                    ${selectHtml('map-qtyin', config.labels.qty_in, mapping.qty_in)}
                </div>
            `;

        body.innerHTML = `
            <div class="form-container">
                ${mappingRows}
                <div class="divider"></div>
                <div style="font-weight:900; margin-bottom: 0.5rem;">Preview (10 baris pertama)</div>
                <div class="table-container">
                    <table class="modern-table">
                        <thead><tr>${previewHead}</tr></thead>
                        <tbody>${previewBody}</tbody>
                    </table>
                </div>
            </div>
        `;
    } catch (e) {
        console.error('Bulk import parse error:', e);
        body.innerHTML = 'Gagal membaca file.';
    }
}

async function submitBulkImport() {
    const state = bulkImportState;
    if (!state || state.submitting) return;
    const body = document.getElementById('bulk-import-body');
    const applyCheckbox = document.getElementById('bulk-apply-inventory');
    const apply_to_inventory = Boolean(applyCheckbox?.checked);
    const mode = String(state.mode || 'barang_keluar');
    state.submitting = true;
    setBulkImportSubmitting(true);

    const getMapVal = (id) => (document.getElementById(id)?.value || '').trim();
    const colPerusahaan = getMapVal('map-perusahaan');
    const colBarang = getMapVal('map-barang');
    const colSatuan = getMapVal('map-satuan');
    let endpoint = '/api/history/bulk';
    let payload = {};

    if (mode === 'finish_good') {
        const colStok = getMapVal('map-stok');
        const colLokasi = getMapVal('map-lokasi');
        if (!colPerusahaan || !colBarang || !colStok) {
            showToast('Mapping wajib diisi: Perusahaan, Barang, dan Stok.', 'error');
            state.submitting = false;
            setBulkImportSubmitting(false);
            return;
        }
        const rows = [];
        for (const r of state.raw) {
            rows.push({
                perusahaan: r[colPerusahaan],
                nama_barang: r[colBarang],
                satuan: colSatuan ? r[colSatuan] : '',
                stok: colStok ? r[colStok] : 0,
                lokasi: colLokasi ? r[colLokasi] : ''
            });
        }
        endpoint = '/api/inventory/bulk';
        payload = { rows };
    } else {
        const colDocNumber = getMapVal('map-doc-number');
        const colTanggal = getMapVal('map-tanggal');
        const colQtyOut = getMapVal('map-qtyout');
        const colQtyIn = getMapVal('map-qtyin');
        if (!colDocNumber || !colTanggal || !colPerusahaan || !colBarang || !colQtyOut) {
            showToast('Mapping wajib diisi: Nomor Dokumen, Tanggal, Perusahaan, Barang, dan Qty Keluar.', 'error');
            state.submitting = false;
            setBulkImportSubmitting(false);
            return;
        }
        const rows = [];
        for (const r of state.raw) {
            rows.push({
                doc_number: r[colDocNumber],
                tanggal: r[colTanggal],
                perusahaan: r[colPerusahaan],
                nama_barang: r[colBarang],
                satuan: colSatuan ? r[colSatuan] : '',
                qty_out: colQtyOut ? r[colQtyOut] : 0,
                qty_in: colQtyIn ? r[colQtyIn] : 0
            });
        }
        payload = { rows, apply_to_inventory };
    }

    let response;
    try {
        const token = sessionStorage.getItem('gudang_token') || '';
        response = await fetchApiWithFallback(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
            body: JSON.stringify(payload)
        });
    } catch (e) {
        console.error('Bulk import request error:', e);
        showToast('Terjadi kesalahan jaringan saat import.', 'error');
        if (body) body.innerHTML = _escapeHtml('Terjadi kesalahan jaringan saat import.');
        state.submitting = false;
        setBulkImportSubmitting(false);
        return;
    }

    if (!response.ok) {
        const msg = await readApiErrorMessage(response);
        showToast(msg || 'Gagal import data.', 'error');
        state.submitting = false;
        setBulkImportSubmitting(false);
        return;
    }

    const data = await response.json().catch(() => ({}));
    const imported = Number(data.imported || 0);
    const skippedExisting = Number(data.skipped_existing || 0);
    const duplicateInFile = Number(data.duplicate_in_file || 0);
    const detail = [];
    detail.push(`${imported.toLocaleString('id-ID')} data baru ditambahkan`);
    if (skippedExisting > 0) {
        detail.push(`${skippedExisting.toLocaleString('id-ID')} data lama dilewati`);
    }
    if (duplicateInFile > 0) {
        detail.push(`${duplicateInFile.toLocaleString('id-ID')} duplikat di file dilewati`);
    }
    const importToastType = imported > 0 ? 'success' : 'info';
    const importToastMessage = imported === 0 && skippedExisting > 0
        ? `Semua data sudah ada di riwayat: ${detail.join(', ')}.`
        : `Import selesai: ${detail.join(', ')}.`;
    showToast(importToastMessage, importToastType);

    closeBulkImportModal();
    _inventoryMemo = { ts: 0, data: null };
    _historyMemo = { ts: 0, key: '', data: null };
    _historyAllMemo = { ts: 0, data: null };

    try {
        if (mode === 'barang_keluar') {
            setHistoryExpanded(true);
        }
        await populateCompanyDropdowns();
        await updateKpiCards();
        await renderRestockList();
        const historyRows = showAllHistoryRows ? await getHistoryAll() : await getHistory(10, 0);
        historicalData = Array.isArray(historyRows) ? historyRows : [];
        const hbody = document.getElementById('history-table-body');
        if (hbody) {
            hbody.innerHTML = historicalData.map(_historyRowToHtml).join('');
        }
        await fetchInventory();
        initChart(await getHistory(1000, 0));
    } catch (e) {
        console.error('Bulk import refresh error:', e);
    } finally {
        state.submitting = false;
        setBulkImportSubmitting(false);
    }

    if (mode === 'barang_keluar') {
        try {
            await showSection('inventory');
            scrollToHistoryTable();
        } catch (e) {
            console.error('Open inventory after import error:', e);
        }
    }
}

function fillWorkOrderFromLastForecast() {
    if (!lastForecastResult) {
        showToast('Belum ada forecast terakhir. Jalankan prediksi di menu Forecast Kebutuhan dulu.', 'error');
        return;
    }

    const p = document.getElementById('wo-perusahaan');
    const b = document.getElementById('wo-barang');
    const tm = document.getElementById('wo-target-month');
    const qty = document.getElementById('wo-qty');
    const unit = document.getElementById('wo-unit');

    if (p) p.value = lastForecastResult.perusahaan || '';
    if (b) b.value = lastForecastResult.nama_barang || '';
    if (tm) tm.value = (lastForecastResult.target_month || '').slice(0, 10);
    if (qty) qty.value = String(Math.max(1, Number(lastForecastResult.needed_stock || 0) || 1));
    if (unit) ensureUnitOption(unit, lastForecastResult.unit || 'pcs');

    showToast('Form work order terisi dari forecast terakhir.', 'success');
}

async function createWorkOrder() {
    const perusahaan = (document.getElementById('wo-perusahaan')?.value || '').trim();
    const barang = (document.getElementById('wo-barang')?.value || '').trim();
    const target_month = (document.getElementById('wo-target-month')?.value || '').trim();
    const qtyRaw = document.getElementById('wo-qty')?.value;
    const unit = (document.getElementById('wo-unit')?.value || '').trim();
    const due_date = (document.getElementById('wo-due-date')?.value || '').trim();
    const notes = (document.getElementById('wo-notes')?.value || '').trim();

    const planned_qty = parseInt(String(qtyRaw || '0'), 10);
    if (!perusahaan || !barang) return showToast('Isi perusahaan dan barang (ambil dari forecast).', 'error');
    if (!Number.isFinite(planned_qty) || planned_qty <= 0) return showToast('Qty produksi harus lebih dari 0.', 'error');

    try {
        const token = sessionStorage.getItem('gudang_token') || '';
        const response = await fetchApiWithFallback(`/api/work-orders`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
            body: JSON.stringify({
                perusahaan,
                barang,
                target_month: target_month || null,
                planned_qty,
                unit,
                due_date: due_date || null,
                notes,
                lead_time: lastForecastResult?.lead_time ?? null,
                service_level: lastForecastResult?.service_level ?? null
            })
        });

        if (!response.ok) {
            const msg = await readApiErrorMessage(response);
            return showToast(msg || 'Gagal membuat work order.', 'error');
        }

        const data = await response.json().catch(() => ({}));
        showToast('Work order berhasil dibuat.', 'success');
        await renderWorkOrders();
        const newId = Number(data.id || 0);
        if (newId) {
            await openWorkOrderModal(newId);
        }
    } catch (e) {
        console.error('Create WO error:', e);
        showToast('Terjadi kesalahan jaringan saat membuat work order.', 'error');
    }
}

async function showWorkOrderDetail(id) {
    const woId = Number(id || 0);
    if (!woId) return;
    try {
        const response = await fetchApiWithFallback(`/api/work-orders/${encodeURIComponent(String(woId))}`);
        if (!response.ok) {
            const msg = await readApiErrorMessage(response);
            return showToast(msg || 'Gagal mengambil detail work order.', 'error');
        }
        const data = await response.json().catch(() => ({}));
        const wo = data.work_order || {};
        const instr = String(wo.instructions || '').trim();
        if (!instr) return showToast('Instruksi work order belum tersedia.', 'error');
        window.prompt('Instruksi Work Order (salin jika perlu):', instr);
    } catch (e) {
        showToast('Terjadi kesalahan jaringan saat mengambil detail work order.', 'error');
    }
}

async function updateWorkOrderStatus(id, currentStatus = 'Draft') {
    const woId = Number(id || 0);
    if (!woId) return;
    const next = window.prompt("Update status (Draft / Released / In Progress / Completed / Cancelled):", String(currentStatus || 'Draft'));
    if (next === null) return;
    const status = String(next || '').trim();
    if (!status) return showToast('Status tidak boleh kosong.', 'error');

    try {
        const token = sessionStorage.getItem('gudang_token') || '';
        const response = await fetchApiWithFallback(`/api/work-orders/${encodeURIComponent(String(woId))}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
            body: JSON.stringify({ status })
        });
        if (!response.ok) {
            const msg = await readApiErrorMessage(response);
            return showToast(msg || 'Gagal update status work order.', 'error');
        }
        await response.json().catch(() => ({}));
        showToast('Status work order diperbarui.', 'success');
        await renderWorkOrders();
    } catch (e) {
        showToast('Terjadi kesalahan jaringan saat update status work order.', 'error');
    }
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
    const res = document.getElementById('result');
    if (res) res.classList.add('loading-pulse');

    try {
        const p = document.getElementById('perusahaan')?.value;
        const b = document.getElementById('nama_barang')?.value;
        const s = document.getElementById('satuan')?.value;
        const t = document.getElementById('tanggal')?.value;
        
        const lt = parseFloat(document.getElementById('lead-time')?.value) || 0;
        const sl = parseFloat(document.getElementById('service-level')?.value) || 0;
        const avgDemand = parseFloat(document.getElementById('avg-demand')?.value) || 0;
        const stdDev = parseFloat(document.getElementById('std-dev')?.value) || 0;

        if (!p || !b || !t) {
            showToast("Mohon lengkapi data perusahaan, barang, dan tanggal prediksi.", "error");
            if (res) res.classList.remove('loading-pulse');
            return;
        }

        // Contoh kalkulasi sederhana (Silakan sesuaikan rumus aslinya jika ada)
        const safetyStock = Math.ceil(1.65 * stdDev * Math.sqrt(lt)); 
        const rop = Math.ceil((avgDemand * lt) + safetyStock);
        const prediction = Math.ceil(avgDemand); 
        const currentInventory = await getInventory();
        const currentStockItem = currentInventory.find(i => i.barang === b && i.perusahaan === p);
        const currentStock = currentStockItem ? parseInt(currentStockItem.stok) : 0;
        const lokasi = currentStockItem ? currentStockItem.lokasi : '-';
        const neededStock = Math.max(0, prediction - currentStock);

        // Update UI Utama
        const resultVal = document.getElementById('result');
        if (resultVal) resultVal.innerText = prediction;
        
        const resultUnit = document.getElementById('result-unit');
        if (resultUnit) resultUnit.innerText = String(s || 'unit').toUpperCase();

        const locLabel = document.getElementById('storage-location');
        if (locLabel) locLabel.innerText = lokasi;

        // Update UI Detail Analisis
        const elements = {
            'current-stock-val': currentStock,
            'needed-stock-val': neededStock,
            'safety-stock-val': safetyStock,
            'rop-val': rop,
            'avg-demand-input-val': avgDemand,
            'std-dev-input-val': stdDev,
            'rop-status-val': currentStock <= rop ? "Perlu Reorder (Stok ≤ ROP)" : "Aman (Stok > ROP)"
        };

        Object.keys(elements).forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerText = elements[id];
        });

        // Tampilkan Langkah Perhitungan (Menggunakan tanda kutip biasa, aman dari kebocoran $)
        // Bagian menampilkan langkah perhitungan di UI Analisis
        const calculationStepsDiv = document.getElementById('calculation-steps');
        if (calculationStepsDiv) {
            calculationStepsDiv.innerHTML = `
                <div style="background: var(--bg-main); padding: 1rem; border-radius: 0.5rem; margin-bottom: 0.7rem;">
                    <div style="font-weight: 600; margin-bottom: 0.5rem;">1. Safety Stock (SS)</div>
                    <div style="font-family: monospace; font-size: 0.9rem;">SS = 1.65 * Std Dev * akar(LT) = 1.65 * ${stdDev} * akar(${lt}) = ${safetyStock} ${s}</div>
                </div>
                <div style="background: var(--bg-main); padding: 1rem; border-radius: 0.5rem; margin-bottom: 0.7rem;">
                    <div style="font-weight: 600; margin-bottom: 0.5rem;">2. Reorder Point (ROP)</div>
                    <div style="font-family: monospace; font-size: 0.9rem;">ROP = (Avg Demand * LT) + SS = (${avgDemand} * ${lt}) + ${safetyStock} = ${rop} ${s}</div>
                </div>
                <div style="background: var(--bg-main); padding: 1rem; border-radius: 0.5rem;">
                    <div style="font-weight: 600; margin-bottom: 0.5rem;">3. Kebutuhan Tambahan</div>
                    <div style="font-family: monospace; font-size: 0.9rem;">Perlu Ditambah = Max(0, Prediksi - Stok Saat Ini) = Max(0, ${prediction} - ${currentStock}) = ${neededStock} ${s}</div>
                </div>
            `;
        }

        const unitLabel = document.getElementById('unit-label');
        if (unitLabel) unitLabel.innerText = String(s || 'unit').toUpperCase();
        if (res) res.classList.remove('loading-pulse');

    } catch (e) {
        console.error("Predict error:", e);
        showToast("Terjadi kesalahan saat prediksi.", "error");
        if (res) res.classList.remove('loading-pulse');
    }
}
        setTimeout(() => {
            if (res) animateValue(res, 0, prediction, 1000);
            if (curStockVal) animateValue(curStockVal, 0, current_stock, 1000);
            if (needStockVal) animateValue(needStockVal, 0, needed_stock, 1000);
            if (safetyStockVal) animateValue(safetyStockVal, 0, safety_stock, 1000);
            if (ropVal) animateValue(ropVal, 0, reorder_point, 1000);

            if (avgDemandInputVal) avgDemandInputVal.innerText = avg_demand.toLocaleString('id-ID');
            if (stdDevInputVal) stdDevInputVal.innerText = std_dev.toLocaleString('id-ID');

            if (ropStatusVal) {
                ropStatusVal.innerText = reorderNeeded ? 'Reorder' : 'Aman';
                ropStatusVal.classList.toggle('rop-badge--danger', reorderNeeded);
                ropStatusVal.classList.toggle('rop-badge--success', !reorderNeeded);
            }

            // Hide history warning, show input warning only if needed
            if (warningBadge) warningBadge.style.display = 'none';

            // Render calculation steps
            if (calculationStepsDiv) {
                const slPercent = Math.round(service_level * 100);
                calculationStepsDiv.innerHTML = `
                    <div class="form-container" style="padding: 1rem;">
                        <h4 style="margin-bottom: 0.75rem; color: var(--primary);">Langkah Perhitungan</h4>
                        
                        <div style="background: var(--bg-main); padding: 1rem; border-radius: 0.5rem; margin-bottom: 0.75rem;">
                            <div style="font-weight: 600; margin-bottom: 0.5rem;">1. Rata-rata Permintaan Harian</div>
                            <div style="font-family: monospace; font-size: 0.9rem;">
                                $\bar{D}_{\text{harian}} = \frac{\bar{D}_{\text{bulanan}}}{30} = \frac{${avg_demand}}{30} = ${avg_demand_daily.toFixed(2)}$ unit/hari
                            </div>
                        </div>

                        <div style="background: var(--bg-main); padding: 1rem; border-radius: 0.5rem; margin-bottom: 0.75rem;">
                            <div style="font-weight: 600; margin-bottom: 0.5rem;">2. Standar Deviasi Permintaan Harian</div>
                            <div style="font-family: monospace; font-size: 0.9rem;">
                                $\sigma_{\text{harian}} = \frac{\sigma_{\text{bulanan}}}{\sqrt{30}} = \frac{${std_dev}}{\sqrt{30}} = ${std_dev_daily.toFixed(2)}$ unit/hari
                            </div>
                        </div>

                        <div style="background: var(--bg-main); padding: 1rem; border-radius: 0.5rem; margin-bottom: 0.75rem;">
                            <div style="font-weight: 600; margin-bottom: 0.5rem;">3. Safety Stock</div>
                            <div style="font-family: monospace; font-size: 0.9rem;">
                                $SS = Z \times \sigma_{\text{harian}} \times \sqrt{LT} = ${z} \times ${std_dev_daily.toFixed(2)} \times \sqrt{${lead_time_days}} = ${safety_stock}$ unit
                            </div>
                            <div style="margin-top: 0.5rem; color: var(--text-muted); font-size: 0.85rem;">
                                Dimana: Z = ${z} (Service Level ${slPercent}%), LT = ${lead_time_days} hari
                            </div>
                        </div>

                        <div style="background: var(--bg-main); padding: 1rem; border-radius: 0.5rem; margin-bottom: 0.75rem;">
                            <div style="font-weight: 600; margin-bottom: 0.5rem;">4. Reorder Point (ROP)</div>
                            <div style="font-family: monospace; font-size: 0.9rem;">
                                $ROP = (\bar{D}_{\text{harian}} \times LT) + SS = (${avg_demand_daily.toFixed(2)} \times ${lead_time_days}) + ${safety_stock} = ${reorder_point}$ unit
                            </div>
                        </div>

                        <div style="background: var(--bg-main); padding: 1rem; border-radius: 0.5rem;">
                            <div style="font-weight: 600; margin-bottom: 0.5rem;">5. Estimasi Kebutuhan Bulan Berikutnya</div>
                            <div style="font-family: monospace; font-size: 0.9rem;">
                                $Prediksi = \bar{D}_{\text{bulanan}} = ${avg_demand}$ unit
                            </div>
                            <div style="margin-top: 0.5rem; font-family: monospace; font-size: 0.9rem;">
                                $Perlu Ditambah = \max(0, Prediksi - Stok Saat Ini) = \max(0, ${prediction} - ${current_stock}) = ${needed_stock}$ unit
                            </div>
                        </div>
                    </div>
           if (unitLabel) unitLabel.innerText = String(s || item?.satuan || 'unit').toUpperCase();
            if (locLabel) locLabel.innerText = lokasi;
            if (res) res.classList.remove('loading-pulse');

    } catch (e) {
        console.error("Predict error:", e);
        showToast('Terjadi kesalahan saat prediksi.', 'error');
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
      // ... sisa kode fungsi saveNewLayout di atasnya ...
    showToast("Lokasi tata letak berhasil diperbarui.", "success");
    await updateKpiCards();
} // <--- Cukup SATU kurung kurawal penutup untuk mengakhiri fungsi saveNewLayout

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
    }); // <--- Pastikan loop forEach ditutup dengan benar di sini
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
        
        // Memastikan teks diisi sebagai angka biasa tanpa simbol string ilegal
        obj.innerText = val.toLocaleString('id-ID'); 
        
        if (progress < 1) {
            window.requestAnimationFrame(step);
        } else {
            obj.innerText = end.toLocaleString('id-ID');
        }
    };
    window.requestAnimationFrame(step);
}
