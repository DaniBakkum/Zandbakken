import { readFile } from 'node:fs/promises'

const ROWS_KEY = 'zandbak-dashboard-rows'
const fallbackRowsUrl = new URL('../data/planning-overrides.json', import.meta.url)

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify(payload))
}

async function readFallbackRows() {
  const rows = JSON.parse(await readFile(fallbackRowsUrl, 'utf8'))
  return Array.isArray(rows) ? rows : null
}

function getRedisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN

  return url && token ? { token, url: url.replace(/\/$/, '') } : null
}

function getStorageStatus() {
  return {
    hasUpstashUrl: Boolean(process.env.UPSTASH_REDIS_REST_URL),
    hasUpstashToken: Boolean(process.env.UPSTASH_REDIS_REST_TOKEN),
    hasKvUrl: Boolean(process.env.KV_REST_API_URL),
    hasKvToken: Boolean(process.env.KV_REST_API_TOKEN),
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

      sendJson(response, 200, {
        rows: Array.isArray(redisRows) ? redisRows : await readFallbackRows(),
        persisted: Boolean(redisRows),
        storage: getStorageStatus(),
      })
    } catch {
      sendJson(response, 200, {
        rows: await readFallbackRows(),
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
      const redisResponse = await redisRequest(['SET', ROWS_KEY, JSON.stringify(body.rows)])

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
