// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const db = require('./database');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Memory Set: Pelacak Resep Dokter Masuk & Resep Selesai
const resepMasukTerdata = new Set();
const resepSelesaiTerpanggil = new Set();

// =================================================================
// 0. INISIALISASI RADAR FARMASI
// =================================================================
async function initServer() {
    try {
        // Catat resep dokter yang sudah ada hari ini
        const [resepDokter] = await db.query(`SELECT no_resep FROM resep_obat WHERE tgl_peresepan = CURDATE()`);
        resepDokter.forEach(r => resepMasukTerdata.add(r.no_resep));

        // Catat resep yang sudah selesai/disimpan apoteker
        const [resepSelesai] = await db.query(`
            SELECT no_resep FROM resep_obat 
            WHERE tgl_perawatan = CURDATE() AND jam != '00:00:00' AND jam IS NOT NULL
        `);
        resepSelesai.forEach(r => resepSelesaiTerpanggil.add(r.no_resep));

        console.log(`💊 Radar Farmasi Siap: ${resepMasukTerdata.size} resep dokter & ${resepSelesaiTerpanggil.size} resep selesai tercatat.`);
    } catch (err) {
        console.error('Error init farmasi:', err.message);
    }
}
initServer();

// =================================================================
// 1. MODUL POLIKLINIK
// =================================================================
app.get('/api/poli', async (req, res) => {
    try {
        const [rows] = await db.query("SELECT kd_poli, nm_poli FROM poliklinik WHERE status='1' ORDER BY nm_poli ASC");
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.get('/api/antrian-poli/:kd_poli', async (req, res) => {
    try {
        const query = `
            SELECT 
                reg.no_reg, reg.no_rawat, pas.nm_pasien, dok.nm_dokter, reg.stts, poli.nm_poli, reg.kd_pj,
                CASE WHEN reg.kd_pj = 'BPJ' THEN 'BPJS' ELSE 'UMUM' END AS jenis_pasien
            FROM reg_periksa reg
            INNER JOIN pasien pas ON reg.no_rkm_medis = pas.no_rkm_medis
            INNER JOIN dokter dok ON reg.kd_dokter = dok.kd_dokter
            INNER JOIN poliklinik poli ON reg.kd_poli = poli.kd_poli
            WHERE reg.kd_poli = ? AND reg.tgl_registrasi = CURDATE()
            ORDER BY reg.no_reg ASC
        `;
        const [rows] = await db.query(query, [req.params.kd_poli]);
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/antrian-poli/update-status', async (req, res) => {
    const { no_rawat, stts } = req.body;
    try {
        await db.query('UPDATE reg_periksa SET stts = ? WHERE no_rawat = ?', [stts, no_rawat]);
        io.emit('status-pasien-berubah', { no_rawat, stts });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// =================================================================
// 2. MODUL LOKET PENDAFTARAN
// =================================================================
app.post('/api/loket/ambil-tiket', async (req, res) => {
    const { jenis } = req.body;
    let prefix = jenis === 'UMUM' ? 'B' : (jenis === 'PRIORITAS' ? 'C' : 'A');
    try {
        const [last] = await db.query('SELECT MAX(angka) as max_angka FROM custom_antrian_loket WHERE tanggal = CURDATE() AND prefix = ?', [prefix]);
        const nextAngka = (last[0].max_angka || 0) + 1;
        const nomorLengkap = `${prefix}-${String(nextAngka).padStart(3, '0')}`;
        const kodeBooking = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}${prefix}${String(nextAngka).padStart(3, '0')}`;

        await db.query(`
            INSERT INTO custom_antrian_loket (tanggal, prefix, angka, nomor_lengkap, kode_booking, jenis, status, waktu_ambil, waktu_ambil_ms)
            VALUES (CURDATE(), ?, ?, ?, ?, ?, 'Menunggu', CURTIME(), ?)
        `, [prefix, nextAngka, nomorLengkap, kodeBooking, jenis, Date.now()]);

        io.emit('antrian-loket-baru', { nomorLengkap, jenis });
        res.json({ success: true, nomor_antrian: nomorLengkap, jenis });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.get('/api/loket/status-hari-ini', async (req, res) => {
    try {
        const [antrean] = await db.query(`SELECT * FROM custom_antrian_loket WHERE tanggal = CURDATE() ORDER BY id ASC`);
        res.json({ success: true, data: antrean });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/loket/panggil-berikutnya', async (req, res) => {
    const { nama_loket, filter_jenis } = req.body;
    try {
        let sql = `SELECT * FROM custom_antrian_loket WHERE tanggal = CURDATE() AND status = 'Menunggu' `;
        let params = [];
        if (filter_jenis && filter_jenis !== 'SEMUA') {
            sql += `AND jenis = ? `;
            params.push(filter_jenis);
        }
        sql += `ORDER BY id ASC LIMIT 1`;

        const [antrean] = await db.query(sql, params);
        if (antrean.length === 0) return res.json({ success: false, message: 'Tidak ada antrean yang menunggu.' });

        const terpanggil = antrean[0];
        await db.query(`UPDATE custom_antrian_loket SET status = 'Dipanggil', loket = ?, waktu_panggil = CURTIME(), waktu_panggil_ms = ? WHERE id = ?`, [nama_loket, Date.now(), terpanggil.id]);

        const dataPanggilan = { id: terpanggil.id, nomor: terpanggil.nomor_lengkap, jenis: terpanggil.jenis, loket: nama_loket };
        io.emit('suara-panggil-loket', dataPanggilan);
        io.emit('update-antrian-loket', dataPanggilan);
        res.json({ success: true, data: dataPanggilan });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/loket/panggil-spesifik', async (req, res) => {
    const { id, nama_loket } = req.body;
    try {
        const [antrean] = await db.query('SELECT * FROM custom_antrian_loket WHERE id = ?', [id]);
        if (antrean.length === 0) return res.status(404).json({ success: false, message: 'Antrean tidak ditemukan' });

        const terpanggil = antrean[0];
        await db.query(`UPDATE custom_antrian_loket SET status = 'Dipanggil', loket = ?, waktu_panggil = CURTIME(), waktu_panggil_ms = ? WHERE id = ?`, [nama_loket, Date.now(), id]);

        const dataPanggilan = { id: terpanggil.id, nomor: terpanggil.nomor_lengkap, jenis: terpanggil.jenis, loket: nama_loket };
        io.emit('suara-panggil-loket', dataPanggilan);
        io.emit('update-antrian-loket', dataPanggilan);
        res.json({ success: true, data: dataPanggilan });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/loket/tautkan-rm', async (req, res) => {
    const { id, no_rkm_medis } = req.body;
    try {
        const [cek] = await db.query('SELECT nm_pasien FROM pasien WHERE no_rkm_medis = ? LIMIT 1', [no_rkm_medis]);
        const namaPasien = cek.length > 0 ? cek[0].nm_pasien : 'Pasien Terdaftar';
        await db.query(`UPDATE custom_antrian_loket SET no_rkm_medis = ?, nm_pasien = ?, status = 'Selesai' WHERE id = ?`, [no_rkm_medis, namaPasien, id]);
        io.emit('status-loket-selesai', { id, no_rkm_medis, nm_pasien: namaPasien });
        res.json({ success: true, nm_pasien: namaPasien, no_rkm_medis });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// =================================================================
// 3. MODUL FARMASI: STATUS HARI INI (MENAMPILKAN NOMOR TIKET F-001)
// =================================================================
app.get('/api/farmasi/status-hari-ini', async (req, res) => {
    try {
        // A. Resep yang SUDAH SELESAI / SIAP DIAMBIL
        const [siapDiambil] = await db.query(`
            SELECT 
                r.no_resep, 
                r.no_rawat, 
                r.jam AS waktu_selesai, 
                p.nm_pasien, 
                poli.nm_poli,
                IFNULL(caf.nomor_antrian, r.no_resep) AS nomor_antrian
            FROM resep_obat r
            INNER JOIN reg_periksa reg ON r.no_rawat = reg.no_rawat
            INNER JOIN pasien p ON reg.no_rkm_medis = p.no_rkm_medis
            INNER JOIN poliklinik poli ON reg.kd_poli = poli.kd_poli
            LEFT JOIN custom_antrian_farmasi caf ON r.no_rawat = caf.no_rawat AND caf.tanggal = CURDATE()
            WHERE r.tgl_perawatan = CURDATE() 
                AND r.jam != '00:00:00' 
                AND r.jam IS NOT NULL
            ORDER BY r.jam DESC
            LIMIT 10
        `);

        // B. Resep yang BARU MASUK DARI DOKTER (Sedang Diracik)
        const [sedangDiracik] = await db.query(`
            SELECT 
                r.no_resep, 
                r.no_rawat, 
                r.jam_peresepan, 
                p.nm_pasien, 
                poli.nm_poli,
                IFNULL(caf.nomor_antrian, r.no_resep) AS nomor_antrian
            FROM resep_obat r
            INNER JOIN reg_periksa reg ON r.no_rawat = reg.no_rawat
            INNER JOIN pasien p ON reg.no_rkm_medis = p.no_rkm_medis
            INNER JOIN poliklinik poli ON reg.kd_poli = poli.kd_poli
            LEFT JOIN custom_antrian_farmasi caf ON r.no_rawat = caf.no_rawat AND caf.tanggal = CURDATE()
            WHERE r.tgl_peresepan = CURDATE() 
                AND (r.tgl_perawatan = '0000-00-00' OR r.tgl_perawatan IS NULL OR r.jam = '00:00:00' OR r.jam IS NULL)
            ORDER BY r.jam_peresepan DESC
            LIMIT 15
        `);

        res.json({ success: true, siap_diambil: siapDiambil, sedang_diracik: sedangDiracik });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// =================================================================
// RADAR FARMASI DENGAN TIKET F-001
// =================================================================
setInterval(async () => {
    try {
        // Radar 1: Dokter input resep
        const [resepBaruDokter] = await db.query(`
            SELECT r.no_resep FROM resep_obat r WHERE r.tgl_peresepan = CURDATE()
        `);
        let adaBaru = false;
        for (const r of resepBaruDokter) {
            if (!resepMasukTerdata.has(r.no_resep)) {
                resepMasukTerdata.add(r.no_resep);
                adaBaru = true;
            }
        }
        if (adaBaru) io.emit('update-antrian-farmasi');

        // Radar 2: Apoteker klik Simpan Obat (Ambil juga nomor tiket F-001)
        const [resepSelesai] = await db.query(`
            SELECT 
                r.no_resep, 
                r.no_rawat, 
                r.jam, 
                p.nm_pasien, 
                poli.nm_poli,
                IFNULL(caf.nomor_antrian, r.no_resep) AS nomor_antrian
            FROM resep_obat r
            INNER JOIN reg_periksa reg ON r.no_rawat = reg.no_rawat
            INNER JOIN pasien p ON reg.no_rkm_medis = p.no_rkm_medis
            INNER JOIN poliklinik poli ON reg.kd_poli = poli.kd_poli
            LEFT JOIN custom_antrian_farmasi caf ON r.no_rawat = caf.no_rawat AND caf.tanggal = CURDATE()
            WHERE r.tgl_perawatan = CURDATE() 
                AND r.jam != '00:00:00' 
                AND r.jam IS NOT NULL
            ORDER BY r.jam DESC
            LIMIT 5
        `);

        for (const item of resepSelesai) {
            if (!resepSelesaiTerpanggil.has(item.no_resep)) {
                resepSelesaiTerpanggil.add(item.no_resep);
                console.log(`💊 [FARMASI SIAP] Obat Selesai: ${item.nomor_antrian} - ${item.nm_pasien}`);
                io.emit('suara-panggil-farmasi', item);
                io.emit('update-antrian-farmasi');
            }
        }
    } catch (err) {}
}, 2000);

// =================================================================
// 4. TABEL & API ANTREAN TIKET FARMASI (F-001, F-002, dst)
// =================================================================
async function initTabelFarmasi() {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS custom_antrian_farmasi (
                id INT AUTO_INCREMENT PRIMARY KEY,
                tanggal DATE NOT NULL,
                angka INT NOT NULL,
                nomor_antrian VARCHAR(10) NOT NULL,
                no_rawat VARCHAR(25) NOT NULL,
                no_rkm_medis VARCHAR(15) DEFAULT NULL,
                nm_pasien VARCHAR(50) NOT NULL,
                nm_poli VARCHAR(50) DEFAULT NULL,
                nm_dokter VARCHAR(50) DEFAULT NULL,
                status ENUM('Menunggu', 'Dipanggil', 'Selesai', 'Batal') DEFAULT 'Menunggu',
                waktu_cetak TIME NOT NULL,
                KEY idx_tgl_status (tanggal, status),
                KEY idx_rawat (no_rawat)
            ) ENGINE=InnoDB;
        `);
        console.log('✅ Tabel custom_antrian_farmasi siap.');
    } catch (e) {
        console.error('Error init custom_antrian_farmasi:', e.message);
    }
}
initTabelFarmasi();

// API Generate / Cetak Tiket Farmasi dari Meja Poli
app.post('/api/farmasi/cetak-tiket', async (req, res) => {
    const { no_rawat, no_rkm_medis, nm_pasien, nm_poli, nm_dokter } = req.body;
    try {
        // 1. Cek apakah pasien ini sudah pernah dicetakkan tiket hari ini (Anti-Duplikat)
        const [existing] = await db.query(
            'SELECT nomor_antrian, waktu_cetak FROM custom_antrian_farmasi WHERE tanggal = CURDATE() AND no_rawat = ? LIMIT 1',
            [no_rawat]
        );

        if (existing.length > 0) {
            return res.json({
                success: true,
                is_reprint: true,
                nomor_antrian: existing[0].nomor_antrian,
                waktu_cetak: existing[0].waktu_cetak
            });
        }

        // 2. Generate Nomor Baru: F-001, F-002, dst
        const [last] = await db.query(
            'SELECT MAX(angka) as max_angka FROM custom_antrian_farmasi WHERE tanggal = CURDATE()'
        );
        const nextAngka = (last[0].max_angka || 0) + 1;
        const nomorAntrian = `F-${String(nextAngka).padStart(3, '0')}`;

        await db.query(`
            INSERT INTO custom_antrian_farmasi 
            (tanggal, angka, nomor_antrian, no_rawat, no_rkm_medis, nm_pasien, nm_poli, nm_dokter, status, waktu_cetak)
            VALUES (CURDATE(), ?, ?, ?, ?, ?, ?, ?, 'Menunggu', CURTIME())
        `, [nextAngka, nomorAntrian, no_rawat, no_rkm_medis, nm_pasien, nm_poli, nm_dokter]);

        res.json({
            success: true,
            is_reprint: false,
            nomor_antrian: nomorAntrian,
            waktu_cetak: new Date().toLocaleTimeString('id-ID')
        });
    } catch (e) {
        console.error('Error cetak tiket farmasi:', e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});

// =================================================================
// 5. MODUL DISPLAY KETERSEDIAAN KAMAR RAWAT INAP KHANZA
// =================================================================
app.get('/api/kamar/ketersediaan', async (req, res) => {
    try {
        const query = `
            SELECT 
                b.nm_bangsal,
                k.kelas,
                COUNT(k.kd_kamar) AS total,
                SUM(CASE WHEN k.status = 'KOSONG' THEN 1 ELSE 0 END) AS kosong,
                SUM(CASE WHEN k.status = 'ISI' THEN 1 ELSE 0 END) AS terisi
            FROM kamar k
            INNER JOIN bangsal b ON k.kd_bangsal = b.kd_bangsal
            WHERE k.statusdata = '1' AND b.status = '1'
            GROUP BY b.nm_bangsal, k.kelas
            ORDER BY b.nm_bangsal ASC, k.kelas ASC
        `;
        const [rows] = await db.query(query);
        res.json({ success: true, data: rows });
    } catch (e) {
        console.error('Error ketersediaan kamar:', e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});

// =================================================================
// 5. SOCKET.IO EVENT LISTENERS (WAJIB ADA AGAR TV BISA MERESPON)
// =================================================================
io.on('connection', (socket) => {
    // Tangkap panggilan dari dokter poli lalu pancarkan ke TV Poli
    socket.on('panggil-poli', (data) => {
        console.log('📢 Dokter Memanggil Pasien Poli:', data);
        io.emit('suara-panggil-poli', data);
    });

    // Tangkap panggilan dari loket pendaftaran
    socket.on('panggil-ulang-loket', (data) => {
        io.emit('suara-panggil-loket', data);
    });
});

server.listen(PORT, () => {
    console.log(`===============================================`);
    console.log(`🚀 Server Berjalan di: http://localhost:${PORT}`);
    console.log(`===============================================`);
});