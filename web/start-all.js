import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log("\n============================================================");
console.log("🚀 Starting React Frontend & Local OCR Server in background...");
console.log("============================================================\n");

const serverPath = path.join(__dirname, '../ocr_server.py');

// Prefer the project venv: Homebrew/system Python blocks pip installs
// (PEP 668 externally-managed-environment), so ocr_server.py's auto-install
// only works inside a virtual environment.
const venvPython = process.platform === 'win32'
  ? path.join(__dirname, '../venv/Scripts/python.exe')
  : path.join(__dirname, '../venv/bin/python');
const pythonCmd = fs.existsSync(venvPython) ? venvPython : 'python3';

if (pythonCmd === 'python3') {
  console.log("⚠️  No venv found at ../venv — using system python3.");
  console.log("   If the OCR server fails to install dependencies, run:");
  console.log("   python3 -m venv venv && venv/bin/pip install flask flask-cors pyobjc-framework-Vision pyobjc-framework-Quartz\n");
}

// 1. Spawn Python OCR Server
const ocrServer = spawn(pythonCmd, [serverPath], { stdio: 'inherit', shell: true });

ocrServer.on('error', () => {
  console.log("Failed to launch with venv/python3, trying python...");
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
