// test.js
const db = require('./database');

async function testKoneksi() {
    try {
        const [rows] = await db.query('SELECT 1 + 1 AS hasil');
        console.log('✅ BERHASIL! Terhubung ke Database SIMRS Khanza.');
    } catch (error) {
        console.error('❌ GAGAL KONEKSI:', error.message);
    } finally {
        process.exit();
    }
}

testKoneksi();