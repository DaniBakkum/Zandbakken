import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

const dataDirectory = path.resolve('data')
const rowsFile = path.join(dataDirectory, 'planning-overrides.json')
const UNKNOWN_VALUES = new Set(['', '?', '-'])
const EQUIPMENT_CANONICAL = {
  UNKNOWN: 'Onbekend',
  MOBILE_GRAB: 'mobiel/knijper',
  CRANE_SHOVEL: 'kraantje/shovel',
}

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

function cleanValue(value) {
  return String(value ?? '').trim()
}

function normalizeEquipmentValue(equipment) {
  const cleaned = cleanValue(equipment)

  if (UNKNOWN_VALUES.has(cleaned)) {
    return EQUIPMENT_CANONICAL.UNKNOWN
  }

  if (cleaned === EQUIPMENT_CANONICAL.MOBILE_GRAB || cleaned === 'Mobiel' || cleaned === 'Knijper') {
    return EQUIPMENT_CANONICAL.MOBILE_GRAB
  }

  if (cleaned === EQUIPMENT_CANONICAL.CRANE_SHOVEL || cleaned === 'Kraan' || cleaned === 'Knikmops') {
    return EQUIPMENT_CANONICAL.CRANE_SHOVEL
  }

  if (cleaned === EQUIPMENT_CANONICAL.UNKNOWN || cleaned === 'Onbekend') {
    return EQUIPMENT_CANONICAL.UNKNOWN
  }

  return EQUIPMENT_CANONICAL.UNKNOWN
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) {
    return { rows: null, changed: false }
  }

  let changed = false
  const normalizedRows = rows.map((row) => {
    const equipment = normalizeEquipmentValue(row?.equipment)
    if (equipment !== cleanValue(row?.equipment)) {
      changed = true
    }

    let revision = row?.revision
    if (revision && typeof revision === 'object') {
      const revisionEquipment = normalizeEquipmentValue(revision.equipment)
      if (revisionEquipment !== cleanValue(revision.equipment)) {
        changed = true
      }
      revision = { ...revision, equipment: revisionEquipment }
    }

    return { ...row, equipment, revision }
  })

  return { rows: normalizedRows, changed }
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
            const normalized = normalizeRows(rows)

            if (normalized.changed) {
              await fs.writeFile(rowsFile, `${JSON.stringify(normalized.rows, null, 2)}\n`, 'utf8')
            }

            sendJson(response, 200, { rows: normalized.rows })
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

            const normalized = normalizeRows(body.rows)
            await fs.mkdir(dataDirectory, { recursive: true })
            await fs.writeFile(rowsFile, `${JSON.stringify(normalized.rows, null, 2)}\n`, 'utf8')
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
