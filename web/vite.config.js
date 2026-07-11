import { createReadStream, existsSync, rmSync, statSync, cpSync, mkdirSync, copyFileSync } from 'node:fs'
import { dirname, extname, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const __dirname = dirname(fileURLToPath(import.meta.url))
const docsDir = resolve(__dirname, '../docs')
const docsOutDir = resolve(__dirname, 'dist/docs')
const ortDistDir = resolve(__dirname, 'node_modules/onnxruntime-web/dist')
const ortOutDir = resolve(__dirname, 'dist/ort')
const ortAssetNames = [
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.jspi.mjs',
  'ort-wasm-simd-threaded.jspi.wasm',
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm'
]

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png'
}

const docsPlugin = () => ({
  name: 'ocr-docs-static',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith('/docs/')) {
        next()
        return
      }

      const requestedPath = decodeURIComponent(req.url.split('?')[0].replace(/^\/docs\/?/, ''))
      const safePath = normalize(requestedPath || 'index.html')
      const filePath = resolve(docsDir, safePath)
      const docsRoot = `${docsDir}${sep}`
      if (filePath !== docsDir && !filePath.startsWith(docsRoot)) {
        res.statusCode = 403
        res.end('Forbidden')
        return
      }

      if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
        next()
        return
      }

      res.setHeader('Content-Type', mimeTypes[extname(filePath).toLowerCase()] || 'application/octet-stream')
      createReadStream(filePath).pipe(res)
    })
  },
  closeBundle() {
    if (!existsSync(docsDir)) return
    rmSync(docsOutDir, { recursive: true, force: true })
    cpSync(docsDir, docsOutDir, { recursive: true })
  }
})

const ortAssetsPlugin = () => ({
  name: 'onnxruntime-web-assets',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const requestedName = decodeURIComponent(req.url?.split('?')[0].replace(/^\/ort\//, '') || '')
      if (!req.url?.startsWith('/ort/') || !ortAssetNames.includes(requestedName)) {
        next()
        return
      }
      const filePath = resolve(ortDistDir, requestedName)
      if (!existsSync(filePath)) {
        next()
        return
      }
      res.setHeader('Content-Type', mimeTypes[extname(filePath).toLowerCase()] || 'application/octet-stream')
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      createReadStream(filePath).pipe(res)
    })
  },
  closeBundle() {
    rmSync(ortOutDir, { recursive: true, force: true })
    mkdirSync(ortOutDir, { recursive: true })
    for (const assetName of ortAssetNames) {
      const source = resolve(ortDistDir, assetName)
      if (!existsSync(source)) throw new Error(`Missing ONNX Runtime asset: ${assetName}`)
      copyFileSync(source, resolve(ortOutDir, assetName))
    }
  }
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), docsPlugin(), ortAssetsPlugin()],
  // Select ORT's external-WASM entrypoint. The runtime URL is configured by
  // VITE_ORT_WASM_BASE_URL and large binaries never enter the Pages artifact.
  resolve: {
    conditions: ['onnxruntime-web-use-extern-wasm']
  },
})
