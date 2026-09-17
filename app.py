from flask import Flask, render_template, request, jsonify, redirect, url_for, session, flash, send_file
from werkzeug.security import check_password_hash
from functools import wraps
import mimetypes
import cv2
import os
import time
import json
import html
import logging
import re
import math
from io import BytesIO
from fer.fer import FER
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from database import get_db_connection, init_db

logger = logging.getLogger(__name__)

# Pastikan MIME type file MediaPipe tersaji benar (WebAssembly butuh application/wasm)
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/javascript", ".js")

# ── Inisialisasi Aplikasi ──────────────────────────────────────────────────────
app = Flask(__name__, static_folder='templates', static_url_path='/templates')
app.secret_key = os.environ.get('SECRET_KEY', 'kesehatan_mental_super_secret_key_998877')
init_db()

# Inisialisasi model FER sekali saat startup agar tidak reload setiap request.
# Gunakan Haar cascade yang di-bundle bersama proyek — OpenCV 5.x tidak lagi
# menyertakan file haarcascade bawaan sehingga FER gagal memuatnya
# (error: "!empty() in function 'detectMultiScale'").
def _build_fer_detector():
    cascade_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "haarcascade_frontalface_default.xml")
    if os.path.exists(cascade_path):
        detector = FER(mtcnn=False, cascade_file=cascade_path)
    else:
        # fallback ke path bawaan cv2 (OpenCV < 5)
        detector = FER(mtcnn=False)
    # Validasi: pastikan cascade benar-benar termuat, jika tidak cari kandidat lain
    if getattr(detector, '_FER__face_detector', None) is not None:
        face_detector = detector._FER__face_detector
        if hasattr(face_detector, 'empty') and face_detector.empty():
            for cand in (
                os.path.join(os.path.dirname(cv2.__file__), "data", "haarcascades",
                             "haarcascade_frontalface_default.xml"),
                cascade_path,
            ):
                try:
                    cc = cv2.CascadeClassifier(cand)
                    if not cc.empty():
                        detector._FER__face_detector = cc
                        print(f"[FER] Menggunakan cascade: {cand}")
                        break
                except Exception:
                    continue
            else:
                print("[PERINGATAN] Haar cascade wajah tidak tersedia — "
                      "letakkan haarcascade_frontalface_default.xml di folder aplikasi.")
    return detector

detector = _build_fer_detector()


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
                session['admin_school']   = admin_user['sekolah']
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
    siswa_id = session['siswa_id']
    conn = get_db_connection()
    
    # Ambil hasil kuesioner terbaru milik siswa yang sedang login
    # Mengambil record paling akhir untuk masing-masing kuesioner_type
    rows = conn.execute("""
        SELECT h1.* FROM hasil_kuesioner h1
        INNER JOIN (
            SELECT kuesioner_type, MAX(id) as max_id
            FROM hasil_kuesioner
            WHERE siswa_id = ?
            GROUP BY kuesioner_type
        ) h2 ON h1.id = h2.max_id
    """, (siswa_id,)).fetchall()
    conn.close()

    # Format data DB ke dictionary agar mudah diproses di Jinja / JS
    kuesioner_db = {}
    for row in rows:
        kuesioner_db[row['kuesioner_type']] = {
            'id': row['id'],
            'kuesioner_type': row['kuesioner_type'],
            'label': row['label'],
            'scores': json.loads(row['scores']) if row['scores'] else {},
            'answers': json.loads(row['answers']) if row['answers'] else {},
            'total': row['total'],
            'category': row['category'],
            'submitted_at': row['created_at'] if 'created_at' in row.keys() else row.get('submitted_at', '')
        }

    return render_template('hasil-kuesioner.html', kuesioner_db=kuesioner_db)


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

    # ── Baca video satu kali dan ambil sampel yang tersebar ───────────────────
    cap = cv2.VideoCapture(save_path)
    if not cap.isOpened():
        _safe_remove(save_path)
        return jsonify({'error': 'Format video tidak didukung atau file corrupt.'}), 400

    # Metadata frame menghindari lintasan grab() kedua yang sebelumnya hanya
    # digunakan untuk menghitung jumlah frame.
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if total_frames <= 0:
        fps = cap.get(cv2.CAP_PROP_FPS) or 0
        duration_hint = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000
        total_frames = int(fps * duration_hint) if fps > 0 and duration_hint > 0 else 0

    target_samples = 60
    step = max(1, math.ceil(total_frames / target_samples)) if total_frames else 3
    sampled, frame_idx = [], 0

    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            break
        if frame_idx % step == 0 and len(sampled) < target_samples:
            h, w = frame.shape[:2]
            if w > 400:
                frame = cv2.resize(frame, (400, int(h * 400 / w)))
            sampled.append(frame)
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


# ── API: Simpan Hasil Deteksi Fokus (Eye Tracking) ────────────────────────────
@app.route('/submit-fokus', methods=['POST'])
@siswa_required
def submit_fokus():
    """
    Menerima hasil sesi eye tracking dari frontend (JSON).
    gaze_data menyimpan seluruh riwayat gaze dalam format kompak
    (EyeViz.pack — Float32Array base64 + bitmask), tanpa downsampling.
    """
    data = request.get_json(silent=True)
    if not data:
        return jsonify({'error': 'Body request tidak valid atau bukan JSON.'}), 400

    siswa_id    = session['siswa_id']
    gaze_data   = data.get('gaze_data')
    session_id  = data.get('session_id', '')
    duration    = data.get('duration', 0)
    data_points = data.get('data_points', 0)
    avg_focus   = data.get('avg_focus', 0)
    status_counts = data.get('status_counts', {})

    if not gaze_data or not isinstance(gaze_data, dict):
        return jsonify({'error': 'Data gaze kosong atau tidak valid.'}), 400

    try:
        conn = get_db_connection()
        conn.execute(
            """INSERT INTO hasil_fokus
               (siswa_id, session_id, duration, data_points, avg_focus, status_counts, gaze_data)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (siswa_id, session_id, duration, data_points, avg_focus,
             json.dumps(status_counts), json.dumps(gaze_data))
        )
        conn.commit()
        conn.close()
        return jsonify({'success': True, 'message': 'Data fokus berhasil disimpan.'})
    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500


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
    admin_school  = session.get('admin_school')

    conn = get_db_connection()

    query = """
        SELECT s.*,
               (SELECT COUNT(*) FROM hasil_kuesioner hk WHERE hk.siswa_id = s.id) AS count_kuesioner,
               (SELECT COUNT(*) FROM hasil_deteksi   hd WHERE hd.siswa_id = s.id) AS count_deteksi,
               (SELECT COUNT(*) FROM hasil_fokus     hf WHERE hf.siswa_id = s.id) AS count_fokus
        FROM siswa s
        WHERE 1=1
    """
    params = []

    if admin_school:
        query += " AND s.sekolah = ?"
        params.append(admin_school)

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
        has_f = s['count_fokus']     > 0

        if status_filter == 'kuesioner' and not has_k:
            continue
        if status_filter == 'deteksi'   and not has_d:
            continue
        if status_filter == 'fokus'     and not has_f:
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

    if not siswa or (session.get('admin_school') and siswa['sekolah'] != session['admin_school']):
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

    fokus_rows = conn.execute(
        'SELECT * FROM hasil_fokus WHERE siswa_id = ? ORDER BY created_at DESC',
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

    fokus_list = [
        {
            'id':            r['id'],
            'session_id':    r['session_id'],
            'duration':      r['duration'],
            'data_points':   r['data_points'],
            'avg_focus':     r['avg_focus'],
            'status_counts': safe_json(r['status_counts']),
            'gaze_data':     safe_json(r['gaze_data']),
            'created_at':    r['created_at'],
        }
        for r in fokus_rows
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
        'fokus':     fokus_list,       # Selalu list, minimal []
    })


@app.route('/admin/siswa/<int:siswa_id>/pdf')
@admin_required
def admin_siswa_pdf(siswa_id):
    """Buat PDF ringkasan seluruh hasil asesmen siswa yang dipilih."""
    conn = get_db_connection()
    try:
        siswa = conn.execute('SELECT * FROM siswa WHERE id = ?', (siswa_id,)).fetchone()
        admin_school = session.get('admin_school')
        if not siswa or (admin_school and siswa['sekolah'] != admin_school):
            return jsonify({'error': 'Siswa tidak ditemukan.'}), 404

        kuesioner_rows = conn.execute(
            'SELECT * FROM hasil_kuesioner WHERE siswa_id = ? ORDER BY created_at DESC',
            (siswa_id,)
        ).fetchall()
        deteksi_rows = conn.execute(
            'SELECT * FROM hasil_deteksi WHERE siswa_id = ? ORDER BY created_at DESC',
            (siswa_id,)
        ).fetchall()
        fokus_rows = conn.execute(
            'SELECT * FROM hasil_fokus WHERE siswa_id = ? ORDER BY created_at DESC',
            (siswa_id,)
        ).fetchall()
    finally:
        conn.close()

    def parse_json(value):
        try:
            return json.loads(value) if value else {}
        except (json.JSONDecodeError, TypeError):
            return {}

    def value_text(value):
        return str(value) if value not in (None, '') else '-'

    def markup_text(value):
        """Escape data database sebelum dimasukkan ke Paragraph ReportLab."""
        return html.escape(value_text(value), quote=False)

    def number_text(value, suffix=''):
        try:
            return f'{float(value):.1f}{suffix}'
        except (TypeError, ValueError):
            return '-'

    styles = getSampleStyleSheet()
    body = ParagraphStyle('PdfBody', parent=styles['BodyText'], fontSize=8, leading=10)
    heading = ParagraphStyle('PdfHeading', parent=styles['Heading2'], fontSize=11,
                             leading=14, textColor=colors.HexColor('#0f6264'),
                             spaceBefore=10, spaceAfter=5)
    title = ParagraphStyle('PdfTitle', parent=styles['Title'], fontSize=16,
                           leading=20, alignment=1, spaceAfter=4)

    def cell(value):
        return Paragraph(markup_text(value), body)

    def make_table(rows, widths):
        table = Table(rows, colWidths=widths, repeatRows=1)
        table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#0f6264')),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, -1), 7.5),
            ('GRID', (0, 0), (-1, -1), 0.3, colors.HexColor('#ccd9da')),
            ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#f5f8f8')]),
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('TOPPADDING', (0, 0), (-1, -1), 5),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
        ]))
        return table

    story = [Paragraph('Laporan Hasil Asesmen Siswa', title),
             Paragraph(markup_text(siswa['nama']), body), Spacer(1, 8)]
    profile = [
        ['Nama', value_text(siswa['nama'])],
        ['Kelas / Jurusan', f"{value_text(siswa['kelas'])} / {value_text(siswa['jurusan'])}"],
        ['Sekolah', value_text(siswa['sekolah'])],
        ['Terdaftar', value_text(siswa['created_at'])],
    ]
    profile_table = Table(profile, colWidths=[42 * mm, 133 * mm])
    profile_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (0, -1), colors.HexColor('#eef5f5')),
        ('GRID', (0, 0), (-1, -1), 0.3, colors.HexColor('#ccd9da')),
        ('FONTNAME', (0, 0), (0, -1), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, -1), 8),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('TOPPADDING', (0, 0), (-1, -1), 5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
    ]))
    story.append(profile_table)

    story.append(Paragraph('Hasil Kuesioner', heading))
    if kuesioner_rows:
        rows = [['Tanggal', 'Jenis', 'Label', 'Skor / Rincian', 'Kategori']]
        for row in kuesioner_rows:
            scores = parse_json(row['scores'])
            score_text = ', '.join(
                f'{key.title()}: {value_text(value)}' for key, value in scores.items()
            )
            if row['kuesioner_type'] != 'dass21':
                score_text = value_text(row['total'])
            rows.append([cell(row['created_at']), cell(row['kuesioner_type']),
                          cell(row['label']), cell(score_text), cell(row['category'])])
        story.append(make_table(rows, [28 * mm, 25 * mm, 35 * mm, 52 * mm, 35 * mm]))
    else:
        story.append(Paragraph('Belum ada data kuesioner.', body))

    story.append(Paragraph('Hasil Deteksi Emosi', heading))
    if deteksi_rows:
        rows = [['Tanggal', 'Emosi Dominan', 'Persentase Emosi']]
        for row in deteksi_rows:
            emotions = parse_json(row['emotion_data'])
            numeric_emotions = []
            for key, amount in emotions.items():
                try:
                    numeric_emotions.append((key, float(amount)))
                except (TypeError, ValueError):
                    continue
            numeric_emotions.sort(key=lambda item: item[1], reverse=True)
            emotion_text = ', '.join(
                f'{key.title()}: {amount:.1f}%' for key, amount in numeric_emotions
            ) or '-'
            rows.append([cell(row['created_at']), cell(row['dominant_emotion']), cell(emotion_text)])
        story.append(make_table(rows, [38 * mm, 38 * mm, 99 * mm]))
    else:
        story.append(Paragraph('Belum ada data deteksi emosi.', body))

    story.append(Paragraph('Hasil Deteksi Fokus', heading))
    if fokus_rows:
        rows = [['Tanggal', 'Durasi', 'Jumlah Data', 'Rata-rata Fokus', 'Status Fokus']]
        for row in fokus_rows:
            statuses = parse_json(row['status_counts'])
            status_text = ', '.join(f'{key}: {amount}' for key, amount in statuses.items())
            rows.append([cell(row['created_at']), cell(f"{value_text(row['duration'])} detik"),
                         cell(row['data_points']), cell(number_text(row['avg_focus'], '%')), cell(status_text)])
        story.append(make_table(rows, [38 * mm, 28 * mm, 27 * mm, 32 * mm, 50 * mm]))
    else:
        story.append(Paragraph('Belum ada data deteksi fokus.', body))

    output = BytesIO()
    try:
        SimpleDocTemplate(output, pagesize=A4, rightMargin=15 * mm, leftMargin=15 * mm,
                          topMargin=15 * mm, bottomMargin=15 * mm).build(story)
    except Exception:
        logger.exception('Gagal membuat PDF siswa_id=%s', siswa_id)
        return jsonify({'error': 'PDF gagal dibuat. Periksa log server untuk detailnya.'}), 500
    output.seek(0)
    safe_name = re.sub(r'[^A-Za-z0-9._-]+', '-', value_text(siswa['nama'])).strip('-._') or 'siswa'
    filename = f"laporan-asesmen-{safe_name}.pdf"
    return send_file(output, as_attachment=True, download_name=filename,
                     mimetype='application/pdf')


# ── Admin API: Hapus Siswa ────────────────────────────────────────────────────
@app.route('/admin/siswa-delete/<int:siswa_id>', methods=['POST'])
@admin_required
def admin_siswa_delete(siswa_id):
    """
    Hapus siswa beserta semua data turunannya (CASCADE) dan file video fisik di disk.
    """
    conn = get_db_connection()
    try:
        admin_school = session.get('admin_school')
        # Ambil semua path video sebelum dihapus dari DB
        deteksi_rows = conn.execute(
            """SELECT hd.video_path
               FROM hasil_deteksi hd
               INNER JOIN siswa s ON s.id = hd.siswa_id
               WHERE hd.siswa_id = ? AND (? IS NULL OR s.sekolah = ?)""",
            (siswa_id, admin_school, admin_school)
        ).fetchall()

        if not deteksi_rows and not conn.execute(
            'SELECT 1 FROM siswa WHERE id = ? AND (? IS NULL OR sekolah = ?)',
            (siswa_id, admin_school, admin_school)
        ).fetchone():
            conn.close()
            return jsonify({'error': 'Siswa tidak ditemukan.'}), 404

        # Hapus file video fisik
        for r in deteksi_rows:
            if r['video_path']:
                abs_path = os.path.join(app.root_path, r['video_path'])
                _safe_remove(abs_path)

        # Hapus data siswa (CASCADE akan hapus kuesioner & deteksi otomatis)
        conn.execute(
            'DELETE FROM siswa WHERE id = ? AND (? IS NULL OR sekolah = ?)',
            (siswa_id, admin_school, admin_school)
        )
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
    app.run(debug=True, port=5001)