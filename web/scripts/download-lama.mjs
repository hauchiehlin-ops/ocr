import { createHash } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';

const url = 'https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx';
const expectedSha256 = '1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6';
const destination = new URL('../public/models/lama_fp32.onnx', import.meta.url);
const temporary = new URL('../public/models/lama_fp32.onnx.download', import.meta.url);

await mkdir(new URL('../public/models/', import.meta.url), { recursive: true });
const response = await fetch(url);
if (!response.ok) throw new Error(`LaMa download failed: HTTP ${response.status}`);
const bytes = new Uint8Array(await response.arrayBuffer());
const actualSha256 = createHash('sha256').update(bytes).digest('hex');
if (actualSha256 !== expectedSha256) {
  throw new Error(`LaMa checksum mismatch: expected ${expectedSha256}, received ${actualSha256}`);
}
await writeFile(temporary, bytes);
await rm(destination, { force: true });
await rename(temporary, destination);
console.log(`Installed LaMa ONNX (${(bytes.length / 1024 / 1024).toFixed(1)} MiB).`);
