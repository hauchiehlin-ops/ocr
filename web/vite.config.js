import { createReadStream, existsSync, rmSync, statSync, cpSync } from 'node:fs'
import { dirname, extname, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const __dirname = dirname(fileURLToPath(import.meta.url))
const docsDir = resolve(__dirname, '../docs')
const docsOutDir = resolve(__dirname, 'dist/docs')

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
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

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), docsPlugin()],
})
