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
    
    # Ekstrak frame dari video
    cap = cv2.VideoCapture(path)
    frames = []
    while cap.isOpened():
        ret, frame = cap.read()
        if not ret: break
        frames.append(frame)
    cap.release()
    os.remove(path)

    # Ambil sampel ~180 frame merata
    sampled = frames[::max(1, len(frames)//180)][:180] if frames else []
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