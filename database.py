import sqlite3
import os
from werkzeug.security import generate_password_hash

DATABASE_PATH = os.path.join(os.path.dirname(__file__), 'mental_health.db')


def get_db_connection():
    """Buka koneksi SQLite dengan row_factory agar hasil query bisa diakses seperti dict."""
    conn = sqlite3.connect(DATABASE_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=30000")
    # WAL mode: lebih aman untuk multi-request bersamaan
    conn.execute("PRAGMA journal_mode=WAL")
    # Aktifkan foreign key constraints (CASCADE delete)
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    """
    Inisialisasi database: buat semua tabel jika belum ada, lalu seed admin default.
    Dipanggil sekali saat server Flask pertama kali dijalankan.
    """
    conn = get_db_connection()
    cursor = conn.cursor()

    # ── Tabel 1: Siswa ─────────────────────────────────────────────────────────
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS siswa (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            nama       TEXT    NOT NULL,
            kelas      TEXT    NOT NULL,
            jurusan    TEXT    NOT NULL,
            sekolah    TEXT    NOT NULL,
            created_at DATETIME DEFAULT (datetime('now', 'localtime'))
        )
    """)

    # ── Tabel 2: Admin ─────────────────────────────────────────────────────────
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS admin (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            username      TEXT    NOT NULL UNIQUE,
            password_hash TEXT    NOT NULL,
            sekolah       TEXT
        )
    """)

    # Migrasi database lama: akun tanpa sekolah adalah super admin.
    admin_columns = [row[1] for row in cursor.execute("PRAGMA table_info(admin)").fetchall()]
    if 'sekolah' not in admin_columns:
        cursor.execute("ALTER TABLE admin ADD COLUMN sekolah TEXT")

    # ── Tabel 3: Hasil Kuesioner (FK → siswa.id dengan CASCADE) ────────────────
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS hasil_kuesioner (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            siswa_id       INTEGER NOT NULL,
            kuesioner_type TEXT    NOT NULL,
            label          TEXT,
            scores         TEXT,   -- JSON string
            answers        TEXT,   -- JSON string
            total          REAL,
            category       TEXT,
            created_at     DATETIME DEFAULT (datetime('now', 'localtime')),
            FOREIGN KEY (siswa_id) REFERENCES siswa(id) ON DELETE CASCADE
        )
    """)

    # ── Tabel 4: Hasil Deteksi Emosi (FK → siswa.id dengan CASCADE) ────────────
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS hasil_deteksi (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            siswa_id         INTEGER NOT NULL,
            video_path       TEXT,
            dominant_emotion TEXT,
            emotion_data     TEXT,   -- JSON string persentase per emosi
            created_at       DATETIME DEFAULT (datetime('now', 'localtime')),
            FOREIGN KEY (siswa_id) REFERENCES siswa(id) ON DELETE CASCADE
        )
    """)

    # ── Tabel 5: Hasil Deteksi Fokus Eye Tracking (FK → siswa.id CASCADE) ─────
    # gaze_data menyimpan SELURUH riwayat gaze dalam format terkompresi
    # (EyeViz.pack: Float32Array base64 untuk koordinat + bitmask fiksasi/sakad).
    # Format kompak ini menyimpan semua frame tanpa downsampling, sehingga
    # ukuran DB tetap kecil dan riwayat tidak hilang.
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS hasil_fokus (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            siswa_id      INTEGER NOT NULL,
            session_id    TEXT,
            duration      INTEGER,     -- detik
            data_points   INTEGER,     -- jumlah frame gaze
            avg_focus     REAL,        -- rata-rata focus score 0-100
            status_counts TEXT,        -- JSON: {FOKUS, KURANG_FOKUS, ...}
            gaze_data     TEXT,        -- JSON kompak: {v,n,f,g}
            created_at    DATETIME DEFAULT (datetime('now', 'localtime')),
            FOREIGN KEY (siswa_id) REFERENCES siswa(id) ON DELETE CASCADE
        )
    """)

    # ── Seed Admin Default (hanya jika belum ada akun admin sama sekali) ────────
    existing = cursor.execute("SELECT COUNT(*) FROM admin").fetchone()[0]
    if existing == 0:
        cursor.execute(
            "INSERT INTO admin (username, password_hash, sekolah) VALUES (?, ?, NULL)",
            ('admin', generate_password_hash('admin123'))
        )
        print("[DB] Admin default dibuat -> username: admin | password: admin123")

    # Akun guru sekolah dibuat idempoten agar init_db() aman dipanggil ulang.
    school_admins = [
        ('admin_smkn2', 'AdminSMKN2!2026', 'SMKN 2 Yogyakarta'),
        ('admin_smk3muhammadiyah', 'AdminSMK3!2026', 'SMK 3 Muhammadiyah Yogyakarta'),
    ]
    for username, password, school in school_admins:
        cursor.execute(
            """INSERT INTO admin (username, password_hash, sekolah)
               VALUES (?, ?, ?)
               ON CONFLICT(username) DO UPDATE SET
                   password_hash = excluded.password_hash,
                   sekolah = excluded.sekolah""",
            (username, generate_password_hash(password), school)
        )

    conn.commit()
    conn.close()
    print(f"[DB] Database siap di: {DATABASE_PATH}")
