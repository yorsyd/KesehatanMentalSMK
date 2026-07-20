from flask import Flask, render_template, request, jsonify, redirect, url_for, session, flash
from werkzeug.security import check_password_hash
from functools import wraps
import cv2
import os
import time
import json
from fer.fer import FER
from database import get_db_connection, init_db

# ── Inisialisasi Aplikasi ──────────────────────────────────────────────────────
app = Flask(__name__, static_folder='templates', static_url_path='/templates')
app.secret_key = os.environ.get('SECRET_KEY', 'kesehatan_mental_super_secret_key_998877')

# Inisialisasi model FER sekali saat startup agar tidak reload setiap request
detector = FER(mtcnn=False)  # Ubah ke True untuk akurasi lebih tinggi (lebih lambat)


# ── Decorator Auth ─────────────────────────────────────────────────────────────
def siswa_required(f):
    """Proteksi route — hanya bisa diakses jika siswa sudah terdaftar di sesi aktif."""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'siswa_id' not in session:
            flash('Silakan isi identitas Anda terlebih dahulu.', 'warning')
            return redirect(url_for('portal'))
        return f(*args, **kwargs)
    return decorated_function


def admin_required(f):
    """Proteksi route — hanya bisa diakses oleh admin yang sudah login."""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'admin_id' not in session:
            flash('Silakan login terlebih dahulu sebagai Admin/Guru.', 'danger')
            return redirect(url_for('admin_login'))
        return f(*args, **kwargs)
    return decorated_function


# ── Halaman Gerbang Utama ──────────────────────────────────────────────────────
@app.route('/')
def portal():
    """
    Landing page dengan dua pilihan: Siswa atau Admin.
    Jika sudah punya sesi aktif, langsung redirect ke halaman yang sesuai.
    """
    if 'siswa_id' in session:
        return redirect(url_for('index'))
    if 'admin_id' in session:
        return redirect(url_for('admin_dashboard'))
    return render_template('portal.html')


# ── Alur Siswa ─────────────────────────────────────────────────────────────────
@app.route('/siswa/register', methods=['GET', 'POST'])
def siswa_register():
    """
    Form pendaftaran identitas siswa.
    Setiap pendaftaran selalu membuat sesi BARU yang bersih untuk mencegah
    data antar-siswa tercampur.
    """
    if 'siswa_id' in session:
        return redirect(url_for('index'))

    if request.method == 'POST':
        nama    = request.form.get('nama', '').strip()
        kelas   = request.form.get('kelas', '').strip()
        jurusan = request.form.get('jurusan', '').strip()
        sekolah = request.form.get('sekolah', '').strip()

        if not (nama and kelas and jurusan and sekolah):
            flash('Semua field wajib diisi!', 'danger')
            return render_template('siswa_register.html')

        try:
            conn   = get_db_connection()
            cursor = conn.cursor()
            cursor.execute(
                'INSERT INTO siswa (nama, kelas, jurusan, sekolah) VALUES (?, ?, ?, ?)',
                (nama, kelas, jurusan, sekolah)
            )
            siswa_id = cursor.lastrowid
            conn.commit()
            conn.close()

            # Bersihkan sesi lama sebelum menyimpan sesi baru
            session.clear()
            session['siswa_id']   = siswa_id
            session['siswa_nama'] = nama
            flash(f'Selamat datang, {nama}! Silakan mulai asesmen.', 'success')
            return redirect(url_for('index'))

        except Exception as e:
            flash(f'Gagal mendaftarkan siswa: {str(e)}', 'danger')

    return render_template('siswa_register.html')


# ── Alur Admin ─────────────────────────────────────────────────────────────────
@app.route('/admin/login', methods=['GET', 'POST'])
def admin_login():
    """Form login admin. Setelah sukses, redirect ke dashboard."""
    if 'admin_id' in session:
        return redirect(url_for('admin_dashboard'))

    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '')

        if not (username and password):
            flash('Username dan password wajib diisi!', 'danger')
            return render_template('admin_login.html')

        try:
            conn       = get_db_connection()
            admin_user = conn.execute(
                'SELECT * FROM admin WHERE username = ?', (username,)
            ).fetchone()
            conn.close()

            if admin_user and check_password_hash(admin_user['password_hash'], password):
                session.clear()
                session['admin_id']       = admin_user['id']
                session['admin_username'] = admin_user['username']
                return redirect(url_for('admin_dashboard'))
            else:
                flash('Username atau password salah!', 'danger')

        except Exception as e:
            flash(f'Koneksi database gagal: {str(e)}', 'danger')

    return render_template('admin_login.html')


@app.route('/logout')
def logout():
    session.clear()
    flash('Sesi berhasil diakhiri.', 'success')
    return redirect(url_for('portal'))


# ── Halaman Asesmen Siswa (Protected) ─────────────────────────────────────────
@app.route('/index')
@siswa_required
def index():
    return render_template('index.html')


@app.route('/deteksi-fokus')
@siswa_required
def deteksi_fokus():
    return render_template('deteksi-fokus.html')


@app.route('/deteksi-emosi')
@siswa_required
def deteksi_emosi():
    return render_template('deteksi-emosi.html')


@app.route('/form-uji')
@siswa_required
def form_uji():
    return render_template('form-uji.html')


@app.route('/kuesioner-dass')
@siswa_required
def kuesioner_dass():
    return render_template('kuesioner-DASS.html')


@app.route('/kuesioner-afek-negatif')
@siswa_required
def kuesioner_afek_negatif():
    return render_template('kuesioner_SkalaAfekNegatif.html')


@app.route('/kuesioner-afek-positif')
@siswa_required
def kuesioner_afek_positif():
    return render_template('kuesioner_SkalaAfekPositif.html')


@app.route('/hasil-kuesioner')
@siswa_required
def hasil_kuesioner():
    return render_template('hasil-kuesioner.html')


# ── API: Submit Hasil Kuesioner ────────────────────────────────────────────────
@app.route('/submit-kuesioner', methods=['POST'])
@siswa_required
def submit_kuesioner():
    """
    Menerima hasil kuesioner dari frontend (JSON) dan menyimpannya ke DB.
    Siswa harus punya sesi aktif. Data disimpan terkait dengan siswa_id sesi.
    """
    data = request.get_json(silent=True)
    if not data:
        return jsonify({'error': 'Body request tidak valid atau bukan JSON.'}), 400

    siswa_id       = session['siswa_id']
    kuesioner_type = data.get('kuesioner_type', '').strip()
    label          = data.get('label', '').strip()

    if not (kuesioner_type and label):
        return jsonify({'error': 'Field kuesioner_type dan label wajib diisi.'}), 400

    scores  = json.dumps(data.get('scores', {}))
    answers = json.dumps(data.get('answers', {}))
    total   = data.get('total')
    category = data.get('category')

    try:
        conn = get_db_connection()
        conn.execute(
            """INSERT INTO hasil_kuesioner
               (siswa_id, kuesioner_type, label, scores, answers, total, category)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (siswa_id, kuesioner_type, label, scores, answers, total, category)
        )
        conn.commit()
        conn.close()
        return jsonify({'success': True, 'message': 'Kuesioner berhasil disimpan.'})

    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500


# ── API: Analisis Video & Simpan Hasil Deteksi Emosi ──────────────────────────
@app.route('/analyze', methods=['POST'])
@siswa_required
def analyze_video():
    """
    Menerima file video dari frontend, menjalankan deteksi emosi wajah (FER),
    menyimpan video secara permanen ke disk, dan mencatat hasilnya ke DB.
    """
    if 'video' not in request.files:
        return jsonify({'error': 'File video tidak ditemukan dalam request.'}), 400

    video_file = request.files['video']
    if not video_file or video_file.filename == '':
        return jsonify({'error': 'File video tidak valid.'}), 400

    siswa_id = session['siswa_id']

    # ── Persiapan direktori penyimpanan permanen ───────────────────────────────
    upload_dir = os.path.join(app.static_folder, 'uploads', 'videos')
    try:
        os.makedirs(upload_dir, exist_ok=True)
    except Exception as e:
        return jsonify({'error': f'Gagal membuat direktori upload: {str(e)}'}), 500

    filename  = f"video_{siswa_id}_{int(time.time())}.webm"
    save_path = os.path.join(upload_dir, filename)

    # ── Simpan video ke disk ───────────────────────────────────────────────────
    try:
        video_file.save(save_path)
    except Exception as e:
        return jsonify({'error': f'Gagal menyimpan file video: {str(e)}'}), 500

    if not os.path.exists(save_path) or os.path.getsize(save_path) == 0:
        _safe_remove(save_path)
        return jsonify({'error': 'File video kosong atau gagal disimpan.'}), 400

    # ── Hitung total frame (grab-only, tanpa decode penuh) ────────────────────
    cap = cv2.VideoCapture(save_path)
    if not cap.isOpened():
        _safe_remove(save_path)
        return jsonify({'error': 'Format video tidak didukung atau file corrupt.'}), 400

    total_frames = 0
    while cap.isOpened():
        ret = cap.grab()
        if not ret:
            break
        total_frames += 1
    cap.release()

    if total_frames == 0:
        _safe_remove(save_path)
        return jsonify({'error': 'Video tidak memiliki frame yang valid.'}), 400

    # ── Sampling frame (target ≤100 frame) ────────────────────────────────────
    target_samples = 100
    step = max(1, total_frames // target_samples)

    cap = cv2.VideoCapture(save_path)
    sampled, frame_idx = [], 0

    while cap.isOpened():
        if frame_idx % step == 0 and len(sampled) < target_samples:
            ret, frame = cap.read()
            if not ret:
                break
            h, w = frame.shape[:2]
            if w > 400:
                frame = cv2.resize(frame, (400, int(h * 400 / w)))
            sampled.append(frame)
        else:
            if not cap.grab():
                break
        frame_idx += 1

    cap.release()

    if not sampled:
        _safe_remove(save_path)
        return jsonify({'error': 'Gagal memproses frame dari video.'}), 400

    # ── Deteksi emosi per frame ────────────────────────────────────────────────
    try:
        results = [detector.detect_emotions(f) for f in sampled]
    except Exception as e:
        _safe_remove(save_path)
        return jsonify({'error': f'Error saat menjalankan deteksi emosi: {str(e)}'}), 500

    valid_emotions = [res[0]['emotions'] for res in results if res]

    if not valid_emotions:
        _safe_remove(save_path)
        return jsonify({
            'error': 'Tidak ada wajah yang terdeteksi. Pastikan pencahayaan cukup dan posisi wajah menghadap kamera.'
        }), 400

    # ── Kalkulasi rata-rata & normalisasi ─────────────────────────────────────
    keys      = valid_emotions[0].keys()
    avg       = {k: sum(e[k] for e in valid_emotions) / len(valid_emotions) for k in keys}
    tot       = sum(avg.values()) or 1  # hindari div-by-zero
    pct       = {k: round((v / tot) * 100, 2) for k, v in avg.items()}
    dominant  = max(pct, key=pct.get)

    # ── Simpan hasil ke DB ────────────────────────────────────────────────────
    db_video_path = f"templates/uploads/videos/{filename}"
    try:
        conn = get_db_connection()
        conn.execute(
            """INSERT INTO hasil_deteksi
               (siswa_id, video_path, dominant_emotion, emotion_data)
               VALUES (?, ?, ?, ?)""",
            (siswa_id, db_video_path, dominant, json.dumps(pct))
        )
        conn.commit()
        conn.close()
    except Exception as e:
        # Jika DB gagal, hapus video agar tidak ada file orphan
        _safe_remove(save_path)
        return jsonify({'error': f'Gagal mencatat ke database: {str(e)}'}), 500

    return jsonify({'dominant': dominant, 'percentages': pct})


def _safe_remove(path: str):
    """Hapus file tanpa melempar exception jika file tidak ditemukan."""
    try:
        if path and os.path.exists(path):
            os.remove(path)
    except Exception:
        pass


# ── Admin Dashboard ────────────────────────────────────────────────────────────
@app.route('/admin/dashboard')
@admin_required
def admin_dashboard():
    """
    Halaman dashboard admin. Mendukung:
    - Pencarian berdasarkan nama, kelas, jurusan, sekolah
    - Filter berdasarkan kelengkapan data (semua / kuesioner / deteksi / kedua)
    """
    search        = request.args.get('search', '').strip()
    status_filter = request.args.get('filter', 'semua').strip()

    conn = get_db_connection()

    query = """
        SELECT s.*,
               (SELECT COUNT(*) FROM hasil_kuesioner hk WHERE hk.siswa_id = s.id) AS count_kuesioner,
               (SELECT COUNT(*) FROM hasil_deteksi   hd WHERE hd.siswa_id = s.id) AS count_deteksi
        FROM siswa s
        WHERE 1=1
    """
    params = []

    if search:
        query += " AND (s.nama LIKE ? OR s.kelas LIKE ? OR s.jurusan LIKE ? OR s.sekolah LIKE ?)"
        p = f"%{search}%"
        params.extend([p, p, p, p])

    query += " ORDER BY s.created_at DESC"
    all_students = conn.execute(query, params).fetchall()
    conn.close()

    filtered = []
    for s in all_students:
        has_k = s['count_kuesioner'] > 0
        has_d = s['count_deteksi']   > 0

        if status_filter == 'kuesioner' and not has_k:
            continue
        if status_filter == 'deteksi'   and not has_d:
            continue
        if status_filter == 'kedua'     and not (has_k and has_d):
            continue

        filtered.append(s)

    return render_template(
        'dashboard.html',
        students=filtered,
        search=search,
        status_filter=status_filter
    )


# ── Admin API: Detail Siswa (AJAX) ────────────────────────────────────────────
@app.route('/admin/siswa-detail/<int:siswa_id>')
@admin_required
def admin_siswa_detail(siswa_id):
    """
    Endpoint JSON untuk modal detail siswa di dashboard admin.
    Selalu mengembalikan key 'kuesioner' dan 'deteksi' sebagai list (minimal []).
    Setiap json.loads() dibungkus try-except agar data corrupt tidak crash endpoint.
    """
    conn  = get_db_connection()
    siswa = conn.execute('SELECT * FROM siswa WHERE id = ?', (siswa_id,)).fetchone()

    if not siswa:
        conn.close()
        return jsonify({'status': 'error', 'error': 'Siswa tidak ditemukan.'}), 404

    kuesioner_rows = conn.execute(
        'SELECT * FROM hasil_kuesioner WHERE siswa_id = ? ORDER BY created_at DESC',
        (siswa_id,)
    ).fetchall()

    deteksi_rows = conn.execute(
        'SELECT * FROM hasil_deteksi WHERE siswa_id = ? ORDER BY created_at DESC',
        (siswa_id,)
    ).fetchall()

    conn.close()

    def safe_json(val):
        """Parse JSON string dengan fallback {} agar tidak pernah crash."""
        if not val:
            return {}
        try:
            return json.loads(val)
        except (json.JSONDecodeError, TypeError):
            return {}

    kuesioner_list = [
        {
            'id':             r['id'],
            'kuesioner_type': r['kuesioner_type'],
            'label':          r['label'],
            'scores':         safe_json(r['scores']),
            'answers':        safe_json(r['answers']),
            'total':          r['total'],
            'category':       r['category'],
            'created_at':     r['created_at'],
        }
        for r in kuesioner_rows
    ]

    deteksi_list = [
        {
            'id':               r['id'],
            'video_path':       r['video_path'],
            'dominant_emotion': r['dominant_emotion'],
            'emotion_data':     safe_json(r['emotion_data']),
            'created_at':       r['created_at'],
        }
        for r in deteksi_rows
    ]

    return jsonify({
        'status': 'success',
        'siswa': {
            'id':         siswa['id'],
            'nama':       siswa['nama'],
            'kelas':      siswa['kelas'],
            'jurusan':    siswa['jurusan'],
            'sekolah':    siswa['sekolah'],
            'created_at': siswa['created_at'],
        },
        'kuesioner': kuesioner_list,   # Selalu list, minimal []
        'deteksi':   deteksi_list,     # Selalu list, minimal []
    })


# ── Admin API: Hapus Siswa ────────────────────────────────────────────────────
@app.route('/admin/siswa-delete/<int:siswa_id>', methods=['POST'])
@admin_required
def admin_siswa_delete(siswa_id):
    """
    Hapus siswa beserta semua data turunannya (CASCADE) dan file video fisik di disk.
    """
    conn = get_db_connection()
    try:
        # Ambil semua path video sebelum dihapus dari DB
        deteksi_rows = conn.execute(
            'SELECT video_path FROM hasil_deteksi WHERE siswa_id = ?', (siswa_id,)
        ).fetchall()

        # Hapus file video fisik
        for r in deteksi_rows:
            if r['video_path']:
                abs_path = os.path.join(app.root_path, r['video_path'])
                _safe_remove(abs_path)

        # Hapus data siswa (CASCADE akan hapus kuesioner & deteksi otomatis)
        conn.execute('DELETE FROM siswa WHERE id = ?', (siswa_id,))
        conn.commit()
        conn.close()

        return jsonify({
            'success': True,
            'message': 'Data siswa beserta riwayat asesmen dan video berhasil dihapus.'
        })

    except Exception as e:
        conn.close()
        return jsonify({'error': f'Gagal menghapus data siswa: {str(e)}'}), 500


# ── Entry Point ───────────────────────────────────────────────────────────────
if __name__ == '__main__':
    init_db()
    app.run(debug=True, port=5001)