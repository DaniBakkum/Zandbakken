import { readFile } from 'node:fs/promises'

const ROWS_KEY = 'zandbak-dashboard-rows'
const PLANNING_KEY = 'zandbak-dashboard-planning'
const fallbackRowsUrl = new URL('../data/planning-overrides.json', import.meta.url)
const fallbackPlanningUrl = new URL('../data/planning-data.json', import.meta.url)
const UNKNOWN_VALUES = new Set(['', '?', '-'])
const EQUIPMENT_CANONICAL = {
  UNKNOWN: 'Onbekend',
  MOBILE_GRAB: 'mobiel/knijper',
  CRANE_SHOVEL: 'kraantje/shovel',
}

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify(payload))
}

async function readFallbackRows() {
  const rows = JSON.parse(await readFile(fallbackRowsUrl, 'utf8'))
  return Array.isArray(rows) ? rows : null
}

async function readFallbackPlanning() {
  try {
    const planning = JSON.parse(await readFile(fallbackPlanningUrl, 'utf8'))
    return Array.isArray(planning) ? planning : []
  } catch {
    return []
  }
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

function getRedisConfig() {
  const url =
    process.env.UPSTASH_REDIS_REST_URL ??
    process.env.KV_REST_API_URL ??
    process.env.KV_URL ??
    process.env.REDIS_URL
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ??
    process.env.KV_REST_API_TOKEN ??
    process.env.KV_REST_API_READ_ONLY_TOKEN

  return url && token ? { token, url: url.replace(/\/$/, '') } : null
}

function getStorageStatus() {
  return {
    hasUpstashUrl: Boolean(process.env.UPSTASH_REDIS_REST_URL),
    hasUpstashToken: Boolean(process.env.UPSTASH_REDIS_REST_TOKEN),
    hasKvUrl: Boolean(process.env.KV_REST_API_URL),
    hasKvToken: Boolean(process.env.KV_REST_API_TOKEN),
    hasKvReadOnlyToken: Boolean(process.env.KV_REST_API_READ_ONLY_TOKEN),
    hasKvRedisUrl: Boolean(process.env.KV_URL),
    hasRedisUrl: Boolean(process.env.REDIS_URL),
    hasWritableRestConfig: Boolean(
      (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL) &&
        (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN),
    ),
  }
}

function parseRowsBody(body) {
  if (typeof body === 'string') {
    return JSON.parse(body)
  }

  return body
}

async function redisRequest(command) {
  const config = getRedisConfig()

  if (!config) {
    return null
  }

  const response = await fetch(config.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  })

  if (!response.ok) {
    throw new Error(`Redis request failed: ${response.status}`)
  }

  return response.json()
}

export default async function handler(request, response) {
  if (request.method === 'GET') {
    try {
      const redisResponse = await redisRequest(['GET', ROWS_KEY])
      const planningResponse = await redisRequest(['GET', PLANNING_KEY])
      const redisRows = redisResponse?.result ? JSON.parse(redisResponse.result) : null
      const redisPlanning = planningResponse?.result ? JSON.parse(planningResponse.result) : null
      const sourceRows = Array.isArray(redisRows) ? redisRows : await readFallbackRows()
      const sourcePlanning = Array.isArray(redisPlanning) ? redisPlanning : await readFallbackPlanning()
      const normalized = normalizeRows(sourceRows)
      const normalizedPlanning = normalizePlanning(sourcePlanning)
      let persisted = Array.isArray(redisRows)
      let planningPersisted = Array.isArray(redisPlanning)

      if (normalized.changed) {
        const migrateResponse = await redisRequest(['SET', ROWS_KEY, JSON.stringify(normalized.rows)])
        if (migrateResponse) {
          persisted = true
        }
      }

      if (normalizedPlanning.changed) {
        const migrateResponse = await redisRequest([
          'SET',
          PLANNING_KEY,
          JSON.stringify(normalizedPlanning.planning),
        ])
        if (migrateResponse) {
          planningPersisted = true
        }
      }

      sendJson(response, 200, {
        rows: normalized.rows,
        planning: normalizedPlanning.planning,
        persisted,
        planningPersisted,
        storage: getStorageStatus(),
      })
    } catch {
      const fallbackRows = await readFallbackRows()
      const fallbackPlanning = await readFallbackPlanning()
      const normalized = normalizeRows(fallbackRows)
      const normalizedPlanning = normalizePlanning(fallbackPlanning)

      sendJson(response, 200, {
        rows: normalized.rows,
        planning: normalizedPlanning.planning,
        persisted: false,
        planningPersisted: false,
        storage: getStorageStatus(),
      })
    }

    return
  }

  if (request.method === 'PUT') {
    const body = parseRowsBody(request.body)
    const hasRows = Object.hasOwn(body ?? {}, 'rows')
    const hasPlanning = Object.hasOwn(body ?? {}, 'planning')

    if (!hasRows && !hasPlanning) {
      sendJson(response, 400, { error: 'rows of planning moet aanwezig zijn.' })
      return
    }

    if (hasRows && !Array.isArray(body?.rows)) {
      sendJson(response, 400, { error: 'rows moet een array zijn.' })
      return
    }

    if (hasPlanning && !Array.isArray(body?.planning)) {
      sendJson(response, 400, { error: 'planning moet een array zijn.' })
      return
    }

    try {
      const redisResponses = []

      if (hasRows) {
        const normalized = normalizeRows(body.rows)
        redisResponses.push(await redisRequest(['SET', ROWS_KEY, JSON.stringify(normalized.rows)]))
      }

      if (hasPlanning) {
        const normalized = normalizePlanning(body.planning)
        redisResponses.push(await redisRequest(['SET', PLANNING_KEY, JSON.stringify(normalized.planning)]))
      }

      if (redisResponses.every((redisResponse) => !redisResponse)) {
        sendJson(response, 200, {
          ok: true,
          persisted: false,
          storage: getStorageStatus(),
          warning: 'Geen Upstash Redis configuratie gevonden; alleen browseropslag is beschikbaar.',
        })
        return
      }

      sendJson(response, 200, {
        ok: true,
        persisted: redisResponses.every(Boolean),
        storage: getStorageStatus(),
      })
    } catch {
      sendJson(response, 500, { error: 'Data kon niet worden opgeslagen.' })
    }

    return
  }

  response.setHeader('Allow', 'GET, PUT')
  sendJson(response, 405, { error: 'Methode niet toegestaan.' })
}
