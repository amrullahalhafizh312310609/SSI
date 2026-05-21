-- Database Schema for Gudang PT. SEIGO SELARAS INDONESIA

CREATE DATABASE IF NOT EXISTS gudang_db;
USE gudang_db;

-- Table for Companies
CREATE TABLE IF NOT EXISTS companies (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    status ENUM('Aktif', 'Non-Aktif') DEFAULT 'Aktif'
);

-- Table for Inventory Items
CREATE TABLE IF NOT EXISTS inventory (
    id INT AUTO_INCREMENT PRIMARY KEY,
    company_name VARCHAR(255) NOT NULL,
    item_name VARCHAR(255) NOT NULL,
    unit VARCHAR(50) DEFAULT 'pcs',
    stock INT DEFAULT 0,
    location VARCHAR(100) DEFAULT 'A-01',
    status ENUM('Ada', 'Tidak Ada') DEFAULT 'Ada',
    FOREIGN KEY (company_name) REFERENCES companies(name) ON DELETE CASCADE
);

-- Table for Transaction History
CREATE TABLE IF NOT EXISTS transactions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    date DATE NOT NULL,
    company_name VARCHAR(255) NOT NULL,
    item_name VARCHAR(255) NOT NULL,
    unit VARCHAR(50) NOT NULL,
    qty_out INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

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
);
