import { readFile } from 'node:fs/promises'

const ROWS_KEY = 'zandbak-dashboard-rows'
const fallbackRowsUrl = new URL('../data/planning-overrides.json', import.meta.url)
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
      const redisRows = redisResponse?.result ? JSON.parse(redisResponse.result) : null
      const sourceRows = Array.isArray(redisRows) ? redisRows : await readFallbackRows()
      const normalized = normalizeRows(sourceRows)
      let persisted = Array.isArray(redisRows)

      if (normalized.changed) {
        const migrateResponse = await redisRequest(['SET', ROWS_KEY, JSON.stringify(normalized.rows)])
        if (migrateResponse) {
          persisted = true
        }
      }

      sendJson(response, 200, {
        rows: normalized.rows,
        persisted,
        storage: getStorageStatus(),
      })
    } catch {
      const fallbackRows = await readFallbackRows()
      const normalized = normalizeRows(fallbackRows)

      sendJson(response, 200, {
        rows: normalized.rows,
        persisted: false,
        storage: getStorageStatus(),
      })
    }

    return
  }

  if (request.method === 'PUT') {
    const body = parseRowsBody(request.body)

    if (!Array.isArray(body?.rows)) {
      sendJson(response, 400, { error: 'rows moet een array zijn.' })
      return
    }

    try {
      const normalized = normalizeRows(body.rows)
      const redisResponse = await redisRequest(['SET', ROWS_KEY, JSON.stringify(normalized.rows)])

      if (!redisResponse) {
        sendJson(response, 200, {
          ok: true,
          persisted: false,
          storage: getStorageStatus(),
          warning: 'Geen Upstash Redis configuratie gevonden; alleen browseropslag is beschikbaar.',
        })
        return
      }

      sendJson(response, 200, { ok: true, persisted: true, storage: getStorageStatus() })
    } catch {
      sendJson(response, 500, { error: 'Data kon niet worden opgeslagen.' })
    }

    return
  }

  response.setHeader('Allow', 'GET, PUT')
  sendJson(response, 405, { error: 'Methode niet toegestaan.' })
}
