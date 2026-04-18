import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

const dataDirectory = path.resolve('data')
const rowsFile = path.join(dataDirectory, 'planning-overrides.json')

async function readRequestBody(request) {
  const chunks = []

  for await (const chunk of request) {
    chunks.push(chunk)
  }

  return Buffer.concat(chunks).toString('utf8')
}

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify(payload))
}

function persistedRowsPlugin() {
  return {
    name: 'persisted-zandbak-rows',
    configureServer(server) {
      server.middlewares.use('/api/rows', async (request, response, next) => {
        if (request.method === 'GET') {
          if (!existsSync(rowsFile)) {
            sendJson(response, 200, { rows: null })
            return
          }

          try {
            const rows = JSON.parse(await fs.readFile(rowsFile, 'utf8'))
            sendJson(response, 200, { rows })
          } catch {
            sendJson(response, 500, { error: 'Opgeslagen data kon niet worden gelezen.' })
          }

          return
        }

        if (request.method === 'PUT') {
          try {
            const body = JSON.parse(await readRequestBody(request))

            if (!Array.isArray(body.rows)) {
              sendJson(response, 400, { error: 'rows moet een array zijn.' })
              return
            }

            await fs.mkdir(dataDirectory, { recursive: true })
            await fs.writeFile(rowsFile, `${JSON.stringify(body.rows, null, 2)}\n`, 'utf8')
            sendJson(response, 200, { ok: true })
          } catch {
            sendJson(response, 400, { error: 'Data kon niet worden opgeslagen.' })
          }

          return
        }

        next()
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), persistedRowsPlugin()],
})
