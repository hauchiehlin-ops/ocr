// Deterministic stub OCR server for verifying patch alignment in the web app.
// Speaks the same protocol as ocr_server.py: GET /status, POST /ocr.
// Returns fixed bboxes (normalized 0-1000, [ymin, xmin, ymax, xmax]) that match
// the synthetic test image drawn by the browser-side test script.
import http from 'http';

const PORT = 5001;

// Test image is 1000x700. Text lines drawn at:
//  line1: x 100..420, y 100..150  -> ymin 143, xmin 100, ymax 214, xmax 420
//  line2: x 500..820, y 400..450  -> ymin 571, xmin 500, ymax 643, xmax 820
const BLOCKS = [
  { text: '評估指標系統', bbox: [143, 100, 214, 420], confidence: 0.99 },
  { text: '第二行文字測試', bbox: [571, 500, 643, 820], confidence: 0.98 }
];

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'running', engine: 'stub' }));
    return;
  }

  if (req.method === 'POST' && req.url === '/ocr') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      console.log(`POST /ocr received (${body.length} bytes)`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(BLOCKS));
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => console.log(`Stub OCR server on :${PORT}`));
