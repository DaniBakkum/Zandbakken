import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

const dataDirectory = path.resolve('data')
const rowsFile = path.join(dataDirectory, 'planning-overrides.json')
const planningFile = path.join(dataDirectory, 'planning-data.json')
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

function makeRowKey(row) {
  const existing = cleanValue(row?.rowKey)
  if (existing) {
    return existing
  }

  const customId = cleanValue(row?.id)
  if (customId.startsWith('custom-')) {
    return customId
  }

  return [row?.school, row?.street, row?.city]
    .map(cleanValue)
    .map((part) => part.toLowerCase())
    .join('|')
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
    const rowKey = makeRowKey(row)
    if (equipment !== cleanValue(row?.equipment)) {
      changed = true
    }
    if (rowKey !== cleanValue(row?.rowKey)) {
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

    return { ...row, rowKey, equipment, revision }
  })

  return { rows: normalizedRows, changed }
}

function normalizePlanning(planning) {
  if (!Array.isArray(planning)) {
    return { planning: null, changed: false }
  }

  let changed = false
  const seen = new Set()
  const normalizedPlanning = planning
    .map((item) => {
      const date = cleanValue(item?.date)
      const rowKey = cleanValue(item?.rowKey)

      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !rowKey) {
        changed = true
        return null
      }

      const id = cleanValue(item?.id) || `planning-${date}-${rowKey}`
      const createdAt = item?.createdAt ? String(item.createdAt) : new Date().toISOString()
      const updatedAt = item?.updatedAt ? String(item.updatedAt) : createdAt
      const duplicateKey = `${date}|${rowKey}`

      if (seen.has(duplicateKey)) {
        changed = true
        return null
      }

      seen.add(duplicateKey)
      if (
        id !== cleanValue(item?.id) ||
        createdAt !== item?.createdAt ||
        updatedAt !== item?.updatedAt
      ) {
        changed = true
      }

      return { id, date, rowKey, createdAt, updatedAt }
    })
    .filter(Boolean)

  return { planning: normalizedPlanning, changed }
}

async function readPlanningFile() {
  if (!existsSync(planningFile)) {
    return { planning: null, persisted: false }
  }

  const planning = JSON.parse(await fs.readFile(planningFile, 'utf8'))
  const normalized = normalizePlanning(planning)

  if (normalized.changed) {
    await fs.writeFile(planningFile, `${JSON.stringify(normalized.planning, null, 2)}\n`, 'utf8')
  }

  return { planning: normalized.planning, persisted: true }
}

function persistedRowsPlugin() {
  return {
    name: 'persisted-zandbak-rows',
    configureServer(server) {
      server.middlewares.use('/api/rows', async (request, response, next) => {
        if (request.method === 'GET') {
          try {
            let rows = null
            let rowsPersisted = false

            if (existsSync(rowsFile)) {
              const storedRows = JSON.parse(await fs.readFile(rowsFile, 'utf8'))
              const normalized = normalizeRows(storedRows)
              rows = normalized.rows
              rowsPersisted = true

              if (normalized.changed) {
                await fs.writeFile(rowsFile, `${JSON.stringify(normalized.rows, null, 2)}\n`, 'utf8')
              }
            }

            const planning = await readPlanningFile()

            sendJson(response, 200, {
              rows,
              planning: planning.planning,
              persisted: rowsPersisted,
              planningPersisted: planning.persisted,
            })
          } catch {
            sendJson(response, 500, { error: 'Opgeslagen data kon niet worden gelezen.' })
          }

          return
        }

        if (request.method === 'PUT') {
          try {
            const body = JSON.parse(await readRequestBody(request))
            const hasRows = Object.hasOwn(body, 'rows')
            const hasPlanning = Object.hasOwn(body, 'planning')

            if (!hasRows && !hasPlanning) {
              sendJson(response, 400, { error: 'rows of planning moet aanwezig zijn.' })
              return
            }

            if (hasRows && !Array.isArray(body.rows)) {
              sendJson(response, 400, { error: 'rows moet een array zijn.' })
              return
            }

            await fs.mkdir(dataDirectory, { recursive: true })

            if (hasRows) {
              const normalized = normalizeRows(body.rows)
              await fs.writeFile(rowsFile, `${JSON.stringify(normalized.rows, null, 2)}\n`, 'utf8')
            }

            if (hasPlanning) {
              const normalized = normalizePlanning(body.planning)
              if (!normalized.planning) {
                sendJson(response, 400, { error: 'planning moet een array zijn.' })
                return
              }

              await fs.writeFile(planningFile, `${JSON.stringify(normalized.planning, null, 2)}\n`, 'utf8')
            }

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
