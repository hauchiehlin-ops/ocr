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
const pythonCmd = fs.existsSync(venvPython)
  ? venvPython
  : process.platform === 'win32'
    ? 'python'
    : 'python3';

if (!fs.existsSync(venvPython)) {
  console.log(`⚠️  No venv found at ../venv — using system ${pythonCmd}.`);
  console.log("   For a reliable native OCR setup, run setup_and_run_ocr.bat on Windows");
  console.log("   or setup_and_run_ocr.sh on macOS/Linux.\n");
}

// 1. Spawn Python OCR Server
const ocrServer = spawn(pythonCmd, [serverPath], { stdio: 'inherit', shell: true });

ocrServer.on('exit', (code) => {
  if (code && code !== 0) {
    console.error(`OCR server exited with code ${code}. Run the platform setup script to install its dependencies.`);
  }
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
