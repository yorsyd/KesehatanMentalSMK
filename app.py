from flask import Flask, render_template, request, jsonify
import cv2, os, tempfile
from fer.fer import FER

app = Flask(__name__, static_folder='templates', static_url_path='/templates')

# Inisialisasi model FER di awal agar tidak me-load ulang setiap kali request
detector = FER(mtcnn=False) # mtcnn=False pakai Haar Cascade (lebih cepat). Ubah ke True kalau butuh lebih akurat.

@app.route('/')
def index(): 
    return render_template('index.html')

@app.route('/deteksi-fokus', methods=['GET'])
def deteksi_fokus():
    return render_template('deteksi-fokus.html')

@app.route('/deteksi-emosi', methods=['GET'])
def deteksi_emosi():
    return render_template('deteksi-emosi.html')

@app.route('/form-uji', methods=['GET'])
def form_uji():
    return render_template('form-uji.html')

@app.route('/kuesioner-dass', methods=['GET'])
def kuesioner_dass():
    return render_template('kuesioner-DASS.html')

@app.route('/kuesioner-afek-negatif', methods=['GET'])
def kuesioner_afek_negatif():
    return render_template('kuesioner_SkalaAfekNegatif.html')

@app.route('/kuesioner-afek-positif', methods=['GET'])
def kuesioner_afek_positif():
    return render_template('kuesioner_SkalaAfekPositif.html')

@app.route('/hasil-kuesioner', methods=['GET'])
def hasil_kuesioner():
    return render_template('hasil-kuesioner.html')

@app.route('/analyze', methods=['POST'])
def analyze_video():
    if 'video' not in request.files: 
        return jsonify({'error': 'Video tidak ditemukan'}), 400
    
    # Simpan sementara
    path = os.path.join(tempfile.gettempdir(), 'fer_video.webm')
    request.files['video'].save(path)
    
    # Hitung total frame secara cepat (hanya grab metadata, tanpa decoding penuh)
    cap = cv2.VideoCapture(path)
    total_frames = 0
    while cap.isOpened():
        ret = cap.grab()
        if not ret: break
        total_frames += 1
    cap.release()
    
    # Hitung interval sampling (target ~60 frame agar hemat CPU dan RAM di hosting)
    target_samples = 100
    step = max(1, total_frames // target_samples)
    
    # Baca ulang video untuk mengambil frame pilihan
    cap = cv2.VideoCapture(path)
    sampled = []
    frame_idx = 0
    
    while cap.isOpened():
        if frame_idx % step == 0 and len(sampled) < target_samples:
            ret, frame = cap.read()
            if not ret: break
            
            # Resize frame ke lebar 400px untuk menghemat RAM dan mempercepat deteksi emosi
            h, w = frame.shape[:2]
            target_width = 400
            if w > target_width:
                scale = target_width / w
                frame_resized = cv2.resize(frame, (target_width, int(h * scale)))
                sampled.append(frame_resized)
            else:
                sampled.append(frame)
        else:
            # Lewati frame tanpa didecode untuk menghemat CPU
            ret = cap.grab()
            if not ret: break
            
        frame_idx += 1
        
    cap.release()
    
    try:
        os.remove(path)
    except Exception:
        pass

    if not sampled: 
        return jsonify({'error': 'Video kosong atau gagal dibaca'}), 400

    # Proses deteksi emosi per frame
    results = [detector.detect_emotions(f) for f in sampled]
    
    # Ambil emosi dari wajah pertama (jika terdeteksi)
    valid_emotions = [res[0]['emotions'] for res in results if res]

    if not valid_emotions: 
        return jsonify({'error': 'Tidak ada wajah yang terdeteksi dari video'}), 400

    # Kalkulasi rata-rata & normalisasi ke persentase
    keys = valid_emotions[0].keys()
    avg = {k: sum(e[k] for e in valid_emotions) / len(valid_emotions) for k in keys}
    tot = sum(avg.values())
    pct = {k: round((v/tot)*100, 2) for k, v in avg.items()}

    return jsonify({
        'dominant': max(pct, key=pct.get), 
        'percentages': pct
    })

if __name__ == '__main__': 
    # Jalan di port 5001 biar nggak bentrok kalau lu running deepface di 5000
    app.run(debug=True, port=5001)