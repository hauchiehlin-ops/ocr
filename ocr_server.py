import sys
import base64
import numpy as np

# Automatically check and install missing dependencies on first run
try:
    from flask import Flask, request, jsonify
    from flask_cors import CORS
    import cv2
    import easyocr
except ImportError:
    print("Detected missing dependencies. Installing required Python packages...")
    import subprocess
    try:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "flask", "flask-cors", "easyocr", "opencv-python", "numpy"])
        from flask import Flask, request, jsonify
        from flask_cors import CORS
        import cv2
        import easyocr
    except Exception as e:
        print(f"Error installing dependencies: {e}")
        print("Please run manually: pip install flask flask-cors easyocr opencv-python numpy")
        sys.exit(1)

app = Flask(__name__)
CORS(app)

print("\n------------------------------------------------------------")
print("Initializing EasyOCR (Traditional Chinese & English)...")
print("Note: On the first run, EasyOCR will download translation models (~100MB) which may take a minute.")
print("------------------------------------------------------------\n")

try:
    reader = easyocr.Reader(['ch_tra', 'en'])
    print("EasyOCR Engine initialized successfully!")
except Exception as e:
    print(f"Failed to initialize EasyOCR: {e}")
    sys.exit(1)

@app.route('/status', methods=['GET'])
def get_status():
    return jsonify({"status": "running", "engine": "EasyOCR"})

@app.route('/ocr', methods=['POST'])
def perform_ocr():
    try:
        data = request.json
        if not data or 'image' not in data:
            return jsonify({"error": "Missing image field"}), 400
        
        img_bytes = base64.b64decode(data['image'].split(',')[1])
        nparr = np.frombuffer(img_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img is None:
            return jsonify({"error": "Failed to decode image"}), 400
            
        h, w, _ = img.shape
        results = reader.readtext(
            img,
            canvas_size=2560,   # raise the detection canvas so dense screenshots are not downscaled
            mag_ratio=1.5,      # upscale before detection so small text survives
            text_threshold=0.6,
            low_text=0.3,
        )

        blocks = []
        for (bbox, text, prob) in results:
            # Drop low-confidence garbage and empty reads
            if prob < 0.25 or not text.strip():
                continue
            xs = [pt[0] for pt in bbox]
            ys = [pt[1] for pt in bbox]
            xmin, xmax = min(xs), max(xs)
            ymin, ymax = min(ys), max(ys)
            blocks.append({
                "text": text,
                "confidence": round(float(prob), 3),
                "bbox": [
                    int(ymin / h * 1000),
                    int(xmin / w * 1000),
                    int(ymax / h * 1000),
                    int(xmax / w * 1000)
                ]
            })
        return jsonify(blocks)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    print("Starting Local OCR server on http://localhost:5001")
    app.run(host='0.0.0.0', port=5001, debug=False)
