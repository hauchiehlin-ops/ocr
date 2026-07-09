import * as ort from 'onnxruntime-web';

// Set WASM paths if necessary (usually they are loaded relative to the public folder)
ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/';

let detSession = null;
let recSession = null;

async function initModels() {
    if (detSession && recSession) return;
    
    // In a real app, these ONNX models would be downloaded and stored in the /public folder
    // For this demonstration, we are setting up the structure that will run them via WASM.
    
    try {
        // detSession = await ort.InferenceSession.create('/models/ppocr_det.onnx');
        // recSession = await ort.InferenceSession.create('/models/ppocr_rec.onnx');
        console.log("OCR Models (Mock) initialized in Web Worker via ONNX Runtime Web");
    } catch (e) {
        console.error("Failed to load OCR models:", e);
    }
}

self.onmessage = async (e) => {
    const { type, payload } = e.data;
    
    if (type === 'INIT') {
        await initModels();
        self.postMessage({ type: 'INIT_DONE' });
    }
    else if (type === 'RECOGNIZE') {
        // Here we would:
        // 1. Preprocess payload.imageData
        // 2. Run detSession.run(...)
        // 3. Crop bounding boxes
        // 4. Run recSession.run(...) on each crop
        // 5. Postprocess into JSON format matching the original C++ output
        
        console.log("Worker received RECOGNIZE command");
        
        // Mock result after a delay simulating inference
        setTimeout(() => {
            const mockResult = {
                blocks: [
                    {
                        id: "block_1",
                        text: "WebAssembly OCR Mock",
                        confidence: 0.99,
                        bbox: { x: 100, y: 150, w: 300, h: 40 }
                    }
                ]
            };
            self.postMessage({ type: 'RECOGNIZE_DONE', payload: mockResult });
        }, 2000);
    }
};
