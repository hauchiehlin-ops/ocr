import sys
import base64
import platform

# Automatically check and install missing dependencies on first run
try:
    from flask import Flask, request, jsonify
    from flask_cors import CORS
except ImportError:
    print("Detected missing dependencies. Installing required Python packages...")
    import subprocess
    try:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "flask", "flask-cors"])
        from flask import Flask, request, jsonify
        from flask_cors import CORS
    except Exception as e:
        print(f"Error installing dependencies: {e}")
        print("Please run manually: pip install flask flask-cors")
        sys.exit(1)

app = Flask(__name__)
CORS(app)

IS_MACOS = platform.system() == "Darwin"

# ---------------------------------------------------------------------------
# Engine 1 — Apple Vision (macOS native, best Traditional Chinese accuracy)
# ---------------------------------------------------------------------------
vision_available = False
if IS_MACOS:
    try:
        import Vision
        from Foundation import NSData
        vision_available = True
    except ImportError:
        print("pyobjc Vision bindings not found. Installing (enables the native macOS OCR engine)...")
        import subprocess
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "install",
                                   "pyobjc-framework-Vision", "pyobjc-framework-Quartz"])
            import Vision
            from Foundation import NSData
            vision_available = True
        except Exception as e:
            print(f"Could not install Vision bindings ({e}); falling back to EasyOCR.")


def vision_ocr(img_bytes):
    """Run macOS native Vision OCR. Returns list of block dicts."""
    ns_data = NSData.dataWithBytes_length_(img_bytes, len(img_bytes))
    handler = Vision.VNImageRequestHandler.alloc().initWithData_options_(ns_data, None)
    req = Vision.VNRecognizeTextRequest.alloc().init()
    req.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    req.setRecognitionLanguages_(["zh-Hant", "en-US"])
    req.setUsesLanguageCorrection_(True)
    success, error = handler.performRequests_error_([req], None)
    if not success:
        raise RuntimeError(f"Vision request failed: {error}")

    blocks = []
    for obs in (req.results() or []):
        candidates = obs.topCandidates_(1)
        if not candidates or candidates.count() == 0:
            continue
        cand = candidates.objectAtIndex_(0)
        text = str(cand.string())
        conf = float(cand.confidence())
        if conf < 0.2 or not text.strip():
            continue
        # Vision bbox: normalized [0,1], origin at BOTTOM-left
        bb = obs.boundingBox()
        x = bb.origin.x
        y = bb.origin.y
        bw = bb.size.width
        bh = bb.size.height
        blocks.append({
            "text": text,
            "confidence": round(conf, 3),
            "bbox": [
                int((1 - y - bh) * 1000),  # ymin (flip to top-left origin)
                int(x * 1000),             # xmin
                int((1 - y) * 1000),       # ymax
                int((x + bw) * 1000)       # xmax
            ]
        })
    return blocks


# ---------------------------------------------------------------------------
# Engine 2 — EasyOCR (cross-platform fallback)
# ---------------------------------------------------------------------------
easyocr_reader = None


def get_easyocr_reader():
    global easyocr_reader
    if easyocr_reader is not None:
        return easyocr_reader
    try:
        import easyocr
    except ImportError:
        print("Installing EasyOCR engine dependencies...")
        import subprocess
        subprocess.check_call([sys.executable, "-m", "pip", "install",
                               "easyocr", "opencv-python", "numpy"])
        import easyocr
    print("\n------------------------------------------------------------")
    print("Initializing EasyOCR (Traditional Chinese & English)...")
    print("Note: On the first run, EasyOCR downloads models (~100MB).")
    print("------------------------------------------------------------\n")
    easyocr_reader = easyocr.Reader(['ch_tra', 'en'])
    return easyocr_reader


def easyocr_ocr(img_bytes):
    """Run EasyOCR. Returns list of block dicts."""
    import numpy as np
    import cv2
    reader = get_easyocr_reader()
    nparr = np.frombuffer(img_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ValueError("Failed to decode image")
    # Composite transparent PNGs onto white — otherwise text on transparency
    # becomes black-on-black and recognition fails completely
    if img.ndim == 3 and img.shape[2] == 4:
        alpha = img[:, :, 3:4].astype(np.float32) / 255.0
        rgb = img[:, :, :3].astype(np.float32)
        img = (rgb * alpha + 255.0 * (1 - alpha)).astype(np.uint8)
    elif img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)

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
    return blocks


ACTIVE_ENGINE = "AppleVision" if vision_available else "EasyOCR"

if ACTIVE_ENGINE == "EasyOCR":
    # Warm up EasyOCR at startup so the first request isn't slow
    get_easyocr_reader()
    print("EasyOCR Engine initialized successfully!")
else:
    print("Using macOS native Vision OCR engine (best Traditional Chinese accuracy).")


@app.route('/status', methods=['GET'])
def get_status():
    return jsonify({"status": "running", "engine": ACTIVE_ENGINE})


@app.route('/ocr', methods=['POST'])
def perform_ocr():
    try:
        data = request.json
        if not data or 'image' not in data:
            return jsonify({"error": "Missing image field"}), 400

        img_bytes = base64.b64decode(data['image'].split(',')[1])

        if ACTIVE_ENGINE == "AppleVision":
            blocks = vision_ocr(img_bytes)
        else:
            blocks = easyocr_ocr(img_bytes)
        return jsonify(blocks)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == '__main__':
    print(f"Starting Local OCR server ({ACTIVE_ENGINE}) on http://localhost:5001")
    app.run(host='0.0.0.0', port=5001, debug=False)
