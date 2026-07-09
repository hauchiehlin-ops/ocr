import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log("\n============================================================");
console.log("🚀 Starting React Frontend & Local OCR Server in background...");
console.log("============================================================\n");

const serverPath = path.join(__dirname, '../ocr_server.py');

// 1. Spawn Python OCR Server
const ocrServer = spawn('python3', [serverPath], { stdio: 'inherit', shell: true });

ocrServer.on('error', () => {
  console.log("Failed to launch with python3, trying python...");
  spawn('python', [serverPath], { stdio: 'inherit', shell: true });
});

// 2. Spawn Vite Web Server
const vite = spawn('npx', ['vite'], { stdio: 'inherit', shell: true });

// Handle termination signals to cleanly shut down both processes
process.on('SIGINT', () => {
  ocrServer.kill();
  vite.kill();
  process.exit();
});

process.on('SIGTERM', () => {
  ocrServer.kill();
  vite.kill();
  process.exit();
});
