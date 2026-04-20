import { useEffect, useMemo, useState } from 'react'
import { divIcon } from 'leaflet'
import { CircleMarker, MapContainer, Marker, Popup, TileLayer, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import './App.css'
import { locationsByKey } from './data/locations'

const CSV_URL = '/planning-zandbakken.csv'
const ROWS_API_URL = '/api/rows'
const STORAGE_KEY = 'zandbak-dashboard-rows'
const MAP_CENTER = [52.466, 4.81]
const MOBILE_QUERY = '(max-width: 760px)'
const ADMIN_PASSWORD = 'Sturm1505!'
const UNKNOWN_VALUES = new Set(['', '?', '-'])
const EQUIPMENT_COLORS = {
  Mobiel: { fill: '#2563eb', stroke: '#1e3a8a' },
  Kraan: { fill: '#f97316', stroke: '#9a3412' },
  Knijper: { fill: '#9333ea', stroke: '#581c87' },
  Knikmops: { fill: '#0d9488', stroke: '#115e59' },
  Onbekend: { fill: '#64748b', stroke: '#334155' },
}
const STATUS_OPTIONS = [
  { label: 'Alle voortgang', value: 'all' },
  { label: 'Afgerond', value: 'done' },
  { label: 'Niet afgerond', value: 'open' },
]
const MAX_REVISION_PHOTOS = 3
const PHOTO_MAX_DIMENSION = 1280
const PHOTO_TARGET_BYTES = 250 * 1024
const PHOTO_QUALITY_START = 0.72
const PHOTO_QUALITY_MIN = 0.42
const PHOTO_QUALITY_STEP = 0.08

function cleanValue(value) {
  return String(value ?? '').trim()
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean)
  const headers = lines[0].split(';').map(cleanValue)

  return lines.slice(1).map((line, index) => {
    const values = line.split(';').map(cleanValue)
    const row = headers.reduce((record, header, headerIndex) => {
      record[header] = values[headerIndex] ?? ''
      return record
    }, {})

    return normalizeRow(row, index)
  })
}

function parseDutchNumber(value) {
  const cleaned = cleanValue(value)

  if (UNKNOWN_VALUES.has(cleaned)) {
    return null
  }

  const parsed = Number(cleaned.replace(',', '.'))
  return Number.isFinite(parsed) ? parsed : null
}

function parseCoordinate(value) {
  const parsed = Number(cleanValue(value).replace(',', '.'))
  return Number.isFinite(parsed) ? parsed : null
}

function formatVolume(value) {
  if (value === null) {
    return 'Onbekend'
  }

  return value.toLocaleString('nl-NL', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function formatTimestamp(value) {
  if (!value) {
    return 'Onbekend'
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return 'Onbekend'
  }

  return parsed.toLocaleString('nl-NL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return '0 KB'
  }

  return `${Math.round(value / 1024)} KB`
}

function equipmentLabel(equipment) {
  return UNKNOWN_VALUES.has(equipment) ? 'Onbekend' : equipment
}

function equipmentColor(equipment) {
  return EQUIPMENT_COLORS[equipmentLabel(equipment)] ?? EQUIPMENT_COLORS.Onbekend
}

function googleMapsRouteUrl(row) {
  if (row.location?.lat != null && row.location?.lng != null) {
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
      `${row.location.lat},${row.location.lng}`,
    )}`
  }

  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
    `${row.street}, ${row.city}, Nederland`,
  )}`
}

function makeLocationKey(row) {
  return `${cleanValue(row.school)}|${cleanValue(row.street)}|${cleanValue(row.city)}`
}

function estimateDataUrlBytes(dataUrl) {
  if (typeof dataUrl !== 'string') {
    return 0
  }

  const [, base64 = ''] = dataUrl.split(',', 2)
  const padding = (base64.match(/=*$/)?.[0].length ?? 0)
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
}

function normalizeRevisionPhotos(photos) {
  if (!Array.isArray(photos)) {
    return []
  }

  return photos
    .slice(0, MAX_REVISION_PHOTOS)
    .map((photo, index) => {
      const dataUrl = typeof photo?.dataUrl === 'string' ? photo.dataUrl : ''

      if (!dataUrl.startsWith('data:image/')) {
        return null
      }

      return {
        id: cleanValue(photo?.id) || `photo-${Date.now()}-${index}`,
        dataUrl,
        mimeType: cleanValue(photo?.mimeType) || 'image/webp',
        width: Number.isFinite(photo?.width) ? Number(photo.width) : 0,
        height: Number.isFinite(photo?.height) ? Number(photo.height) : 0,
        sizeBytes: Number.isFinite(photo?.sizeBytes) ? Number(photo.sizeBytes) : estimateDataUrlBytes(dataUrl),
        createdAt: photo?.createdAt ? String(photo.createdAt) : new Date().toISOString(),
      }
    })
    .filter(Boolean)
}

function readFileAsImage(file) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    const objectUrl = URL.createObjectURL(file)

    image.onload = () => {
      URL.revokeObjectURL(objectUrl)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('Bestand kon niet als afbeelding worden gelezen.'))
    }

    image.src = objectUrl
  })
}

function canvasToWebpBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob)
          return
        }

        reject(new Error('Afbeelding kon niet worden gecomprimeerd.'))
      },
      'image/webp',
      quality,
    )
  })
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('Afbeelding kon niet worden omgezet naar data.'))
    reader.readAsDataURL(blob)
  })
}

async function compressRevisionPhoto(file) {
  if (!(file instanceof File) || !file.type.startsWith('image/')) {
    throw new Error('Alleen afbeeldingsbestanden zijn toegestaan.')
  }

  const image = await readFileAsImage(file)
  const sourceWidth = Number(image.naturalWidth) || Number(image.width) || 0
  const sourceHeight = Number(image.naturalHeight) || Number(image.height) || 0

  if (sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error('Afbeeldingsafmetingen zijn ongeldig.')
  }

  const scale = Math.min(1, PHOTO_MAX_DIMENSION / Math.max(sourceWidth, sourceHeight))
  const width = Math.max(1, Math.round(sourceWidth * scale))
  const height = Math.max(1, Math.round(sourceHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Canvas wordt niet ondersteund door deze browser.')
  }

  context.drawImage(image, 0, 0, width, height)

  let quality = PHOTO_QUALITY_START
  let blob = await canvasToWebpBlob(canvas, quality)

  while (blob.size > PHOTO_TARGET_BYTES && quality > PHOTO_QUALITY_MIN) {
    quality = Math.max(PHOTO_QUALITY_MIN, quality - PHOTO_QUALITY_STEP)
    blob = await canvasToWebpBlob(canvas, quality)
  }

  if (blob.size > PHOTO_TARGET_BYTES) {
    throw new Error('Foto is na compressie nog te groot. Kies een kleinere afbeelding.')
  }

  return {
    id: `photo-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    dataUrl: await blobToDataUrl(blob),
    mimeType: 'image/webp',
    width,
    height,
    sizeBytes: blob.size,
    createdAt: new Date().toISOString(),
  }
}

function normalizeRevision(revision) {
  return {
    completed: Boolean(revision?.completed),
    outgoingRaw: cleanValue(revision?.outgoingRaw),
    incomingRaw: cleanValue(revision?.incomingRaw),
    equipment: cleanValue(revision?.equipment),
    notes: cleanValue(revision?.notes),
    completedAt: revision?.completedAt ? String(revision.completedAt) : null,
    photos: normalizeRevisionPhotos(revision?.photos),
  }
}

function normalizeRow(row, index) {
  const normalized = {
    id: `${index}-${cleanValue(row.School)}-${cleanValue(row.Straatnaam)}`,
    school: cleanValue(row.School),
    board: cleanValue(row.Bestuur),
    street: cleanValue(row.Straatnaam),
    city: cleanValue(row.Plaats),
    outgoingRaw: cleanValue(row['m3 uit']),
    incomingRaw: cleanValue(row['m3 in']),
    equipment: cleanValue(row.Materieel),
  }
  const location = locationsByKey[makeLocationKey(normalized)]
  const revision = normalizeRevision(row.revision)

  normalized.outgoing = parseDutchNumber(normalized.outgoingRaw)
  normalized.incoming = parseDutchNumber(normalized.incomingRaw)
  normalized.location = location ?? null
  normalized.needsCheck = !location
  normalized.revision = revision

  return normalized
}

function serializeRows(rows) {
  return rows.map((row) => ({
    id: row.id,
    school: row.school,
    board: row.board,
    street: row.street,
    city: row.city,
    outgoingRaw: row.outgoingRaw,
    incomingRaw: row.incomingRaw,
    equipment: row.equipment,
    location: row.location,
    revision: row.revision ?? normalizeRevision(null),
  }))
}

function reviveStoredRow(row) {
  const revived = {
    ...row,
    school: cleanValue(row.school),
    board: cleanValue(row.board),
    street: cleanValue(row.street),
    city: cleanValue(row.city),
    outgoingRaw: cleanValue(row.outgoingRaw),
    incomingRaw: cleanValue(row.incomingRaw),
    equipment: cleanValue(row.equipment),
    location: row.location ?? null,
    revision: normalizeRevision(row.revision),
  }

  revived.outgoing = parseDutchNumber(revived.outgoingRaw)
  revived.incoming = parseDutchNumber(revived.incomingRaw)
  revived.needsCheck = !revived.location
  revived.revision = normalizeRevision(revived.revision)

  return revived
}

function rowToDraft(row) {
  return {
    id: row.id,
    school: row.school,
    board: row.board,
    street: row.street,
    city: row.city,
    outgoingRaw: row.outgoingRaw,
    incomingRaw: row.incomingRaw,
    equipment: equipmentLabel(row.equipment),
    lat: row.location?.lat?.toString() ?? '',
    lng: row.location?.lng?.toString() ?? '',
  }
}

function createSchoolDraft() {
  return {
    school: '',
    board: '',
    street: '',
    city: '',
    outgoingRaw: '',
    incomingRaw: '',
    equipment: 'Onbekend',
    lat: '',
    lng: '',
  }
}

function draftToRow(currentRow, draft) {
  const lat = parseCoordinate(draft.lat)
  const lng = parseCoordinate(draft.lng)
  const location =
    lat === null || lng === null
      ? null
      : {
          lat,
          lng,
          source: `${cleanValue(draft.street)}, ${cleanValue(draft.city)}`,
        }
  const row = {
    ...currentRow,
    school: cleanValue(draft.school),
    board: cleanValue(draft.board),
    street: cleanValue(draft.street),
    city: cleanValue(draft.city),
    outgoingRaw: cleanValue(draft.outgoingRaw),
    incomingRaw: cleanValue(draft.incomingRaw),
    equipment: cleanValue(draft.equipment) || '?',
    location,
  }

  row.outgoing = parseDutchNumber(row.outgoingRaw)
  row.incoming = parseDutchNumber(row.incomingRaw)
  row.needsCheck = !row.location

  return row
}

function createRowFromDraft(draft) {
  const lat = parseCoordinate(draft.lat)
  const lng = parseCoordinate(draft.lng)
  const row = {
    id: `custom-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    school: cleanValue(draft.school),
    board: cleanValue(draft.board),
    street: cleanValue(draft.street),
    city: cleanValue(draft.city),
    outgoingRaw: cleanValue(draft.outgoingRaw),
    incomingRaw: cleanValue(draft.incomingRaw),
    equipment: cleanValue(draft.equipment) || '?',
    location:
      lat === null || lng === null
        ? null
        : {
            lat,
            lng,
            source: `${cleanValue(draft.street)}, ${cleanValue(draft.city)}`,
          },
    revision: normalizeRevision(null),
  }

  row.outgoing = parseDutchNumber(row.outgoingRaw)
  row.incoming = parseDutchNumber(row.incomingRaw)
  row.needsCheck = !row.location

  return row
}

function rowToRevisionDraft(row) {
  return {
    id: row.id,
    school: row.school,
    outgoingRaw: row.revision.outgoingRaw || row.outgoingRaw,
    incomingRaw: row.revision.incomingRaw || row.incomingRaw,
    equipment: row.revision.equipment || equipmentLabel(row.equipment),
    notes: row.revision.notes,
    photos: normalizeRevisionPhotos(row.revision.photos),
  }
}

function revisionDraftToRow(currentRow, draft) {
  return {
    ...currentRow,
    revision: {
      completed: true,
      outgoingRaw: cleanValue(draft.outgoingRaw),
      incomingRaw: cleanValue(draft.incomingRaw),
      equipment: cleanValue(draft.equipment),
      notes: cleanValue(draft.notes),
      completedAt: new Date().toISOString(),
      photos: normalizeRevisionPhotos(draft.photos),
    },
  }
}

function rowMarkerIcon(row, isSelected) {
  const color = equipmentColor(row.equipment)
  const selectedClass = isSelected ? 'selected' : ''
  const completeClass = row.revision.completed ? 'completed' : ''
  const html = `<span class="school-marker-core ${selectedClass} ${completeClass}" style="--marker-fill:${color.fill};--marker-stroke:${color.stroke};"></span>`

  return divIcon({
    className: 'school-marker-icon',
    html,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    popupAnchor: [0, -14],
  })
}

function loadStoredRows() {
  try {
    const storedRows = window.localStorage.getItem(STORAGE_KEY)
    return storedRows ? JSON.parse(storedRows).map(reviveStoredRow) : null
  } catch {
    window.localStorage.removeItem(STORAGE_KEY)
    return null
  }
}

async function loadServerRows() {
  try {
    const response = await fetch(ROWS_API_URL)

    if (!response.ok) {
      return null
    }

    const payload = await response.json()
    return Array.isArray(payload.rows) ? payload.rows.map(reviveStoredRow) : null
  } catch {
    return null
  }
}

async function saveRowsToServer(rows) {
  const response = await fetch(ROWS_API_URL, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows: serializeRows(rows) }),
  })

  if (!response.ok) {
    throw new Error('Opslaan naar server is mislukt.')
  }

  return response.json()
}

function sortRows(rows, sortConfig) {
  return [...rows].sort((a, b) => {
    const direction = sortConfig.direction === 'asc' ? 1 : -1
    const left = a[sortConfig.key]
    const right = b[sortConfig.key]

    if (typeof left === 'number' || typeof right === 'number' || left === null || right === null) {
      const leftValue = left ?? Number.NEGATIVE_INFINITY
      const rightValue = right ?? Number.NEGATIVE_INFINITY
      return (leftValue - rightValue) * direction
    }

    return String(left).localeCompare(String(right), 'nl') * direction
  })
}

function MapFocus({ selectedRow }) {
  const map = useMap()

  useEffect(() => {
    if (selectedRow?.location) {
      map.flyTo([selectedRow.location.lat, selectedRow.location.lng], 15, {
        duration: 0.75,
      })
    }
  }, [map, selectedRow])

  return null
}

function UserLocationFocus({ userLocation }) {
  const map = useMap()

  useEffect(() => {
    if (userLocation) {
      map.flyTo([userLocation.lat, userLocation.lng], 15, {
        duration: 0.75,
      })
    }
  }, [map, userLocation])

  return null
}

function useDeviceMode() {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(MOBILE_QUERY).matches,
  )

  useEffect(() => {
    const query = window.matchMedia(MOBILE_QUERY)
    const update = () => setIsMobile(query.matches)

    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  return isMobile ? 'mobile' : 'desktop'
}

function App() {
  const deviceMode = useDeviceMode()
  const isMobile = deviceMode === 'mobile'
  const [rows, setRows] = useState([])
  const [loadState, setLoadState] = useState('loading')
  const [filters, setFilters] = useState({
    equipment: [],
    completion: 'all',
  })
  const [sortConfig, setSortConfig] = useState({ key: 'school', direction: 'asc' })
  const [selectedId, setSelectedId] = useState(null)
  const [isPanelOpen, setIsPanelOpen] = useState(false)
  const [editDraft, setEditDraft] = useState(null)
  const [revisionDraft, setRevisionDraft] = useState(null)
  const [createDraft, setCreateDraft] = useState(null)
  const [dragTargetId, setDragTargetId] = useState(null)
  const [isEquipmentMenuOpen, setIsEquipmentMenuOpen] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [dragError, setDragError] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [createSaveError, setCreateSaveError] = useState('')
  const [revisionSaveError, setRevisionSaveError] = useState('')
  const [isCreateSaving, setIsCreateSaving] = useState(false)
  const [isRevisionSaving, setIsRevisionSaving] = useState(false)
  const [revisionPhotoError, setRevisionPhotoError] = useState('')
  const [isPhotoProcessing, setIsPhotoProcessing] = useState(false)
  const [photoPreview, setPhotoPreview] = useState(null)
  const [mobileView, setMobileView] = useState('map')
  const [isMobileFiltersOpen, setIsMobileFiltersOpen] = useState(false)
  const [userLocation, setUserLocation] = useState(null)
  const [locationState, setLocationState] = useState('idle')
  const [locationError, setLocationError] = useState('')
  const [isAdmin, setIsAdmin] = useState(false)
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false)
  const [adminPasswordInput, setAdminPasswordInput] = useState('')
  const [adminAuthError, setAdminAuthError] = useState('')

  useEffect(() => {
    async function loadRows() {
      try {
        const csvResponse = await fetch(CSV_URL)

        if (!csvResponse.ok) {
          throw new Error(`CSV kon niet worden geladen (${csvResponse.status})`)
        }

        const csvRows = parseCsv(await csvResponse.text())
        const serverRows = await loadServerRows()
        const storedRows = loadStoredRows()
        const parsedRows = serverRows ?? storedRows ?? csvRows
        const parsedEquipmentOptions = [
          ...new Set(parsedRows.map((row) => equipmentLabel(row.equipment)).filter(Boolean)),
        ].sort((a, b) => a.localeCompare(b, 'nl'))

        if (!serverRows && storedRows) {
          saveRowsToServer(storedRows).catch(() => {})
        }

        setRows(parsedRows)
        setFilters((current) => ({ ...current, equipment: parsedEquipmentOptions }))
        setSelectedId(parsedRows[0]?.id ?? null)
        setLoadState('ready')
      } catch {
        setLoadState('error')
      }
    }

    loadRows()
  }, [])

  useEffect(() => {
    if (!editDraft && !revisionDraft && !createDraft && !isAuthModalOpen && !photoPreview) {
      return undefined
    }

    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        setEditDraft(null)
        setRevisionDraft(null)
        setCreateDraft(null)
        setDragTargetId(null)
        setCreateSaveError('')
        setRevisionSaveError('')
        setRevisionPhotoError('')
        setPhotoPreview(null)
        setIsAuthModalOpen(false)
        setAdminPasswordInput('')
        setAdminAuthError('')
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [editDraft, revisionDraft, createDraft, isAuthModalOpen, photoPreview])

  const equipmentOptions = useMemo(
    () =>
      [...new Set(rows.map((row) => equipmentLabel(row.equipment)).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b, 'nl'),
      ),
    [rows],
  )
  const allEquipmentSelected =
    equipmentOptions.length > 0 && filters.equipment.length === equipmentOptions.length

  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      const matchesEquipment = filters.equipment.includes(equipmentLabel(row.equipment))
      const matchesCompletion =
        filters.completion === 'all' ||
        (filters.completion === 'done' && row.revision.completed) ||
        (filters.completion === 'open' && !row.revision.completed)

      return matchesEquipment && matchesCompletion
    })
  }, [filters.completion, filters.equipment, rows])

  const sortedRows = useMemo(() => sortRows(filteredRows, sortConfig), [filteredRows, sortConfig])
  const selectedRow = useMemo(
    () => sortedRows.find((row) => row.id === selectedId) ?? sortedRows[0],
    [selectedId, sortedRows],
  )

  function updateFilter(name, value) {
    setFilters((current) => ({ ...current, [name]: value }))
  }

  function toggleEquipmentFilter(value) {
    setFilters((current) => {
      const selected = current.equipment.length === 0 ? [...equipmentOptions] : [...current.equipment]
      const equipment = selected.includes(value)
        ? selected.filter((item) => item !== value)
        : [...selected, value]

      return { ...current, equipment }
    })
  }

  function equipmentFilterLabel() {
    if (allEquipmentSelected) {
      return 'Alle materieel'
    }

    if (filters.equipment.length === 0) {
      return 'Geen materieel'
    }

    if (filters.equipment.length === 1) {
      return filters.equipment[0]
    }

    return `${filters.equipment.length} geselecteerd`
  }

  function toggleSort(key) {
    setSortConfig((current) => ({
      key,
      direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc',
    }))
  }

  function openEditor(row) {
    if (!isAdmin) {
      return
    }

    setSelectedId(row.id)
    setRevisionDraft(null)
    setEditDraft(rowToDraft(row))
  }

  function openCreateSchool() {
    if (!isAdmin) {
      return
    }

    setRevisionDraft(null)
    setEditDraft(null)
    setDragTargetId(null)
    setCreateSaveError('')
    setCreateDraft(createSchoolDraft())
  }

  function openRevision(row) {
    setSelectedId(row.id)
    setSaveError('')
    setEditDraft(null)
    setRevisionSaveError('')
    setRevisionPhotoError('')
    setIsPhotoProcessing(false)
    setRevisionDraft(rowToRevisionDraft(row))
  }

  function openAdminAuthModal() {
    setAdminAuthError('')
    setAdminPasswordInput('')
    setIsAuthModalOpen(true)
  }

  function closeAdminAuthModal() {
    setIsAuthModalOpen(false)
    setAdminPasswordInput('')
    setAdminAuthError('')
  }

  function toggleAdminAccess() {
    if (isAdmin) {
      setIsAdmin(false)
      setEditDraft(null)
      setCreateDraft(null)
      setDragTargetId(null)
      return
    }

    openAdminAuthModal()
  }

  function submitAdminAuth(event) {
    event.preventDefault()

    if (adminPasswordInput === ADMIN_PASSWORD) {
      setIsAdmin(true)
      closeAdminAuthModal()
      return
    }

    setAdminAuthError('Onjuist wachtwoord. Probeer het opnieuw.')
  }

  function selectMobileLocation(row) {
    setSelectedId(row.id)
    setMobileView('map')
  }

  function locateUser() {
    if (!navigator.geolocation) {
      setLocationState('error')
      setLocationError('Locatie wordt niet ondersteund door deze browser.')
      return
    }

    setLocationState('loading')
    setLocationError('')
    setMobileView('map')

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setUserLocation({
          accuracy: position.coords.accuracy,
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        })
        setLocationState('ready')
      },
      () => {
        setLocationState('error')
        setLocationError('Locatie kon niet worden bepaald. Controleer de locatietoestemming.')
      },
      {
        enableHighAccuracy: true,
        maximumAge: 30000,
        timeout: 12000,
      },
    )
  }

  function updateDraft(name, value) {
    setEditDraft((current) => ({ ...current, [name]: value }))
  }

  function updateRevisionDraft(name, value) {
    setRevisionDraft((current) => ({ ...current, [name]: value }))
  }

  function closeRevisionModal() {
    setRevisionDraft(null)
    setRevisionSaveError('')
    setRevisionPhotoError('')
    setIsPhotoProcessing(false)
  }

  function closePhotoPreview() {
    setPhotoPreview(null)
  }

  function openPhotoPreview(photo, title) {
    setPhotoPreview({
      dataUrl: photo.dataUrl,
      label: title,
    })
  }

  async function addRevisionPhotos(fileList) {
    if (!revisionDraft || !fileList || fileList.length === 0) {
      return
    }

    const files = Array.from(fileList)
    const currentPhotos = normalizeRevisionPhotos(revisionDraft.photos)
    const remaining = Math.max(0, MAX_REVISION_PHOTOS - currentPhotos.length)

    if (remaining <= 0) {
      setRevisionPhotoError(`Je kunt maximaal ${MAX_REVISION_PHOTOS} foto's toevoegen.`)
      return
    }

    setRevisionPhotoError('')
    setIsPhotoProcessing(true)
    const pickedFiles = files.slice(0, remaining)
    const errors = []
    const appended = []

    for (const file of pickedFiles) {
      try {
        const photo = await compressRevisionPhoto(file)
        appended.push(photo)
      } catch (error) {
        errors.push(error instanceof Error ? error.message : 'Foto kon niet worden verwerkt.')
      }
    }

    if (files.length > remaining) {
      errors.push(`Maximaal ${MAX_REVISION_PHOTOS} foto's per revisie.`)
    }

    setRevisionDraft((current) => {
      if (!current) {
        return current
      }

      const nextPhotos = normalizeRevisionPhotos([...normalizeRevisionPhotos(current.photos), ...appended])
      return { ...current, photos: nextPhotos }
    })
    setRevisionPhotoError(errors.join(' '))
    setIsPhotoProcessing(false)
  }

  async function replaceRevisionPhoto(photoId, file) {
    if (!revisionDraft || !file) {
      return
    }

    setRevisionPhotoError('')
    setIsPhotoProcessing(true)

    try {
      const nextPhoto = await compressRevisionPhoto(file)
      setRevisionDraft((current) => {
        if (!current) {
          return current
        }

        const nextPhotos = normalizeRevisionPhotos(current.photos).map((photo) =>
          photo.id === photoId ? { ...nextPhoto, id: photo.id, createdAt: photo.createdAt } : photo,
        )
        return { ...current, photos: nextPhotos }
      })
    } catch (error) {
      setRevisionPhotoError(error instanceof Error ? error.message : 'Foto kon niet worden vervangen.')
    }

    setIsPhotoProcessing(false)
  }

  function removeRevisionPhoto(photoId) {
    setRevisionDraft((current) => {
      if (!current) {
        return current
      }

      const nextPhotos = normalizeRevisionPhotos(current.photos).filter((photo) => photo.id !== photoId)
      return { ...current, photos: nextPhotos }
    })
  }

  function updateCreateDraft(name, value) {
    setCreateDraft((current) => ({ ...current, [name]: value }))
  }

  function startMarkerRelocation() {
    if (!isAdmin || !editDraft) {
      return
    }

    setSelectedId(editDraft.id)
    setSaveError('')
    setDragError('')
    setEditDraft(null)
    setDragTargetId(editDraft.id)
  }

  async function persistRows(nextRows, onServerSaveFailed) {
    let serverSaveFailed = false

    try {
      await saveRowsToServer(nextRows)
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeRows(nextRows)))
    } catch {
      serverSaveFailed = true
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeRows(nextRows)))
      onServerSaveFailed?.()
    }

    setRows(nextRows)
    return serverSaveFailed
  }

  async function saveDraft(event) {
    event.preventDefault()
    const currentRow = rows.find((row) => row.id === editDraft.id)

    if (!currentRow) {
      return
    }

    const nextRow = draftToRow(currentRow, editDraft)
    const nextRows = rows.map((row) => (row.id === nextRow.id ? nextRow : row))

    setIsSaving(true)
    setSaveError('')
    const serverSaveFailed = await persistRows(nextRows, () => {
      setSaveError('Serveropslag is niet gelukt; deze wijziging is alleen in deze browser bewaard.')
    })

    setSelectedId(nextRow.id)
    setIsSaving(false)

    if (!serverSaveFailed) {
      setEditDraft(null)
    }
  }

  async function saveRevisionDraft(event) {
    event.preventDefault()
    const currentRow = rows.find((row) => row.id === revisionDraft.id)

    if (!currentRow) {
      return
    }

    const nextRow = revisionDraftToRow(currentRow, revisionDraft)
    const nextRows = rows.map((row) => (row.id === nextRow.id ? nextRow : row))

    setIsRevisionSaving(true)
    setRevisionSaveError('')
    const serverSaveFailed = await persistRows(nextRows, () => {
      setRevisionSaveError('Serveropslag is niet gelukt; deze revisie is alleen in deze browser bewaard.')
    })

    setSelectedId(nextRow.id)
    setIsRevisionSaving(false)

    if (!serverSaveFailed) {
      setRevisionDraft(null)
    }
  }

  async function saveCreateDraft(event) {
    event.preventDefault()
    const nextRow = createRowFromDraft(createDraft)
    const nextRows = [...rows, nextRow]

    setIsCreateSaving(true)
    setCreateSaveError('')
    const serverSaveFailed = await persistRows(nextRows, () => {
      setCreateSaveError('Serveropslag is niet gelukt; deze nieuwe school is alleen in deze browser bewaard.')
    })

    setSelectedId(nextRow.id)
    setIsCreateSaving(false)

    if (!serverSaveFailed) {
      setCreateDraft(null)
    }
  }

  async function deleteSchool() {
    if (!isAdmin || !editDraft) {
      return
    }

    const nextRows = rows.filter((row) => row.id !== editDraft.id)
    setSaveError('')
    const serverSaveFailed = await persistRows(nextRows, () => {
      setSaveError('Serveropslag is niet gelukt; verwijderen is alleen in deze browser bewaard.')
    })

    if (!serverSaveFailed) {
      setEditDraft(null)
    }

    setSelectedId(nextRows[0]?.id ?? null)
    setDragTargetId(null)
  }

  async function reopenRevision(row) {
    const nextRow = {
      ...row,
      revision: {
        ...normalizeRevision(row.revision),
        completed: false,
        completedAt: null,
      },
    }
    const nextRows = rows.map((item) => (item.id === row.id ? nextRow : item))

    setRevisionSaveError('')
    await persistRows(nextRows)
    setSelectedId(row.id)
  }

  async function handleMarkerDragEnd(row, event) {
    const latlng = event.target.getLatLng?.()
    if (!latlng) {
      return
    }

    const nextRow = {
      ...row,
      location: {
        ...(row.location ?? {}),
        lat: latlng.lat,
        lng: latlng.lng,
        source: row.location?.source ?? `${row.street}, ${row.city}`,
      },
    }
    const nextRows = rows.map((item) => (item.id === row.id ? nextRow : item))

    setDragError('')
    await persistRows(nextRows, () => {
      setDragError('Serveropslag is niet gelukt; nieuwe locatie is alleen in deze browser bewaard.')
    })
    setDragTargetId(null)
    setSelectedId(row.id)
  }

  function sortLabel(key) {
    if (sortConfig.key !== key) {
      return ''
    }

    return sortConfig.direction === 'asc' ? ' oplopend' : ' aflopend'
  }

  return (
    <main className={`dashboard ${isMobile ? 'mobile-dashboard' : 'desktop-dashboard'}`}>
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">Planning zandbakken</p>
          <h1>Zandbak dashboard</h1>
        </div>
        <button
          type="button"
          className={`source-pill ${isAdmin ? 'admin-active' : ''}`}
          onClick={toggleAdminAccess}
          aria-pressed={isAdmin}
        >
          {isAdmin ? 'Admin actief (klik om uit te loggen)' : 'Bron: public/planning-zandbakken.csv'}
        </button>
      </header>

      {loadState === 'error' ? (
        <section className="state-message">
          <h2>CSV niet gevonden</h2>
          <p>Controleer of public/planning-zandbakken.csv bestaat en start de app opnieuw.</p>
        </section>
      ) : (
        <>
          {isMobile && (
            <section className="mobile-controls" aria-label="Mobiele weergave">
              <div className="segmented-control">
                <button
                  type="button"
                  className={mobileView === 'map' ? 'active' : ''}
                  onClick={() => setMobileView('map')}
                  aria-pressed={mobileView === 'map'}
                >
                  Kaart
                </button>
                <button
                  type="button"
                  className={mobileView === 'locations' ? 'active' : ''}
                  onClick={() => setMobileView('locations')}
                  aria-pressed={mobileView === 'locations'}
                >
                  Locaties ({sortedRows.length})
                </button>
              </div>
              <button
                type="button"
                className="mobile-filter-toggle"
                onClick={() => setIsMobileFiltersOpen((current) => !current)}
                aria-expanded={isMobileFiltersOpen}
                aria-pressed={isMobileFiltersOpen}
              >
                Filters
              </button>
            </section>
          )}

          <section
            className={`filters ${isMobile && !isMobileFiltersOpen ? 'mobile-hidden' : ''}`}
            aria-label="Filters"
          >
            <label className="field">
              <span>Materieel</span>
              <div className="multi-dropdown">
                <button
                  type="button"
                  className="multi-dropdown-button"
                  onClick={() => setIsEquipmentMenuOpen((current) => !current)}
                  aria-expanded={isEquipmentMenuOpen}
                >
                  <span>{equipmentFilterLabel()}</span>
                  <span aria-hidden="true">v</span>
                </button>

                {isEquipmentMenuOpen && (
                  <div className="multi-dropdown-menu" role="group" aria-label="Materieel filter">
                    {equipmentOptions.map((option) => {
                      return (
                        <label key={option} className="check-option">
                          <input
                            type="checkbox"
                            checked={filters.equipment.includes(option)}
                            onChange={() => toggleEquipmentFilter(option)}
                          />
                          <i
                            className="equipment-dot"
                            style={{
                              backgroundColor: equipmentColor(option).fill,
                              borderColor: equipmentColor(option).stroke,
                            }}
                            aria-hidden="true"
                          />
                          <span>{option}</span>
                        </label>
                      )
                    })}
                    {equipmentOptions.length > 0 && (
                      <button
                        type="button"
                        className="clear-filter"
                        onClick={() =>
                          updateFilter('equipment', allEquipmentSelected ? [] : [...equipmentOptions])
                        }
                      >
                        {allEquipmentSelected ? 'Alles verbergen' : 'Alles tonen'}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </label>

            <label className="field">
              <span>Afronding</span>
              <select
                value={filters.completion}
                onChange={(event) => updateFilter('completion', event.target.value)}
              >
                {STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </section>

          <section
            className={`workbench ${isPanelOpen ? 'panel-open' : 'panel-closed'} mobile-${mobileView}`}
          >
            <div className="map-panel" aria-label="Kaart met scholen">
              <div className="map-actions">
                <button
                  type="button"
                  className="location-button"
                  onClick={locateUser}
                  aria-label="Toon mijn locatie op de kaart"
                  title="Toon mijn locatie"
                >
                  {locationState === 'loading' ? 'Locatie zoeken...' : 'Mijn locatie'}
                </button>
                {isAdmin && dragTargetId && (
                  <button
                    type="button"
                    className="location-button"
                    onClick={() => setDragTargetId(null)}
                    title="Stop marker verplaatsen"
                  >
                    Verplaatsen stoppen
                  </button>
                )}
                {locationError && <span className="location-error">{locationError}</span>}
                {isAdmin && dragTargetId && !locationError && (
                  <span className="location-error">Sleep het bolletje naar de juiste plek en laat los.</span>
                )}
                {dragError && <span className="location-error">{dragError}</span>}
              </div>
              {loadState === 'loading' ? (
                <div className="state-message compact">CSV laden...</div>
              ) : (
                <MapContainer center={MAP_CENTER} zoom={12} scrollWheelZoom className="map">
                  <TileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  />
                  <MapFocus selectedRow={selectedRow} />
                  <UserLocationFocus userLocation={userLocation} />
                  {userLocation && (
                    <CircleMarker
                      center={[userLocation.lat, userLocation.lng]}
                      className="user-location-marker"
                      pathOptions={{
                        color: '#1d4ed8',
                        fillColor: '#60a5fa',
                        fillOpacity: 0.9,
                        weight: 3,
                      }}
                      radius={10}
                    >
                      <Popup>
                        <strong>Jouw locatie</strong>
                        <span>
                          Nauwkeurigheid: circa {Math.round(userLocation.accuracy)} meter
                        </span>
                      </Popup>
                    </CircleMarker>
                  )}
                  {sortedRows
                    .filter((row) => row.location)
                    .map((row) => (
                      <Marker
                        key={row.id}
                        position={[row.location.lat, row.location.lng]}
                        icon={rowMarkerIcon(row, row.id === selectedRow?.id)}
                        draggable={isAdmin && dragTargetId === row.id}
                        eventHandlers={{
                          click: () => setSelectedId(row.id),
                          dragend: (event) => handleMarkerDragEnd(row, event),
                          contextmenu: (event) => {
                            event.originalEvent.preventDefault()
                            if (!isAdmin) {
                              return
                            }
                            openEditor(row)
                          },
                        }}
                      >
                        <Popup>
                          <strong>{row.school}</strong>
                          <span>
                            {row.street}, {row.city}
                          </span>
                          <span>{row.board}</span>
                          <span>m3 uit: {formatVolume(row.outgoing)}</span>
                          <span>m3 in: {formatVolume(row.incoming)}</span>
                          <span>Materieel: {equipmentLabel(row.equipment)}</span>
                          {row.revision.completed && (
                            <div className="revision-summary">
                              <strong>Revisie afgerond</strong>
                              <span>m3 uit uitgevoerd: {formatVolume(parseDutchNumber(row.revision.outgoingRaw))}</span>
                              <span>m3 in uitgevoerd: {formatVolume(parseDutchNumber(row.revision.incomingRaw))}</span>
                              <span>Materieel uitgevoerd: {equipmentLabel(row.revision.equipment)}</span>
                              {row.revision.notes && <span>Opmerkingen: {row.revision.notes}</span>}
                              {row.revision.photos.length > 0 && (
                                <div className="revision-photo-strip">
                                  {row.revision.photos.map((photo, index) => (
                                    <button
                                      key={photo.id}
                                      type="button"
                                      className="revision-photo-thumb-button"
                                      onClick={() => openPhotoPreview(photo, `${row.school} foto ${index + 1}`)}
                                      title="Foto vergroten"
                                    >
                                      <img
                                        className="revision-photo-thumb"
                                        src={photo.dataUrl}
                                        alt={`${row.school} revisie foto ${index + 1}`}
                                        loading="lazy"
                                      />
                                    </button>
                                  ))}
                                </div>
                              )}
                              <span>Afgerond op: {formatTimestamp(row.revision.completedAt)}</span>
                            </div>
                          )}
                          <div className="popup-actions">
                            <a
                              className="route-link"
                              href={googleMapsRouteUrl(row)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Routebeschrijving
                            </a>
                            <button
                              type="button"
                              className="popup-complete-button"
                              onClick={() => openRevision(row)}
                            >
                              {row.revision.completed ? 'Revisie aanpassen' : 'Zandbak afronden'}
                            </button>
                            {row.revision.completed && (
                              <button
                                type="button"
                                className="popup-reopen-button"
                                onClick={() => reopenRevision(row)}
                              >
                                Opnieuw openzetten
                              </button>
                            )}
                            {isAdmin && (
                              <button type="button" className="popup-edit-button" onClick={() => openEditor(row)}>
                                Bewerken
                              </button>
                            )}
                          </div>
                          {row.needsCheck && <em>Gegevens controleren</em>}
                        </Popup>
                      </Marker>
                    ))}
                </MapContainer>
              )}
            </div>

            <aside
              className="table-panel"
              id="location-panel"
              aria-label="Locatiepaneel"
              aria-hidden={!isPanelOpen}
            >
              <div className="table-toolbar">
                <h2>Locaties</h2>
                <div className="toolbar-actions">
                  {isAdmin && (
                    <button
                      type="button"
                      className="secondary-button compact"
                      onClick={openCreateSchool}
                    >
                      School toevoegen
                    </button>
                  )}
                  <span>
                    {sortedRows.length} van {rows.length}
                  </span>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => setIsPanelOpen(false)}
                    aria-label="Locatiepaneel sluiten"
                    title="Locatiepaneel sluiten"
                  >
                    &times;
                  </button>
                </div>
              </div>

              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>
                        <button type="button" onClick={() => toggleSort('school')}>
                          School{sortLabel('school')}
                        </button>
                      </th>
                      <th>
                        <button type="button" onClick={() => toggleSort('board')}>
                          Bestuur{sortLabel('board')}
                        </button>
                      </th>
                      <th>Adres</th>
                      <th>
                        <button type="button" onClick={() => toggleSort('city')}>
                          Plaats{sortLabel('city')}
                        </button>
                      </th>
                      <th className="numeric">
                        <button type="button" onClick={() => toggleSort('outgoing')}>
                          m3 uit{sortLabel('outgoing')}
                        </button>
                      </th>
                      <th className="numeric">
                        <button type="button" onClick={() => toggleSort('incoming')}>
                          m3 in{sortLabel('incoming')}
                        </button>
                      </th>
                      <th>
                        <button type="button" onClick={() => toggleSort('equipment')}>
                          Materieel{sortLabel('equipment')}
                        </button>
                      </th>
                      <th>Status</th>
                      <th>Route</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRows.map((row) => (
                      <tr
                        key={row.id}
                        className={row.id === selectedRow?.id ? 'selected' : ''}
                        onClick={() => setSelectedId(row.id)}
                      >
                        <td>{row.school}</td>
                        <td>{row.board}</td>
                        <td>{row.street}</td>
                        <td>{row.city}</td>
                        <td className="numeric">{formatVolume(row.outgoing)}</td>
                        <td className="numeric">{formatVolume(row.incoming)}</td>
                        <td>{equipmentLabel(row.equipment)}</td>
                        <td>
                          <span className={`status ${row.needsCheck ? 'check' : 'complete'}`}>
                            {row.needsCheck ? 'Controleren' : 'Compleet'}
                          </span>
                        </td>
                        <td>
                          <a
                            className="table-route-link"
                            href={googleMapsRouteUrl(row)}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(event) => event.stopPropagation()}
                          >
                            Route
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </aside>

            <section className="mobile-list-panel" aria-label="Mobiele locatielijst">
              <div className="mobile-list-header">
                <h2>Locaties</h2>
                <div className="mobile-header-actions">
                  {isAdmin && (
                    <button
                      type="button"
                      className="secondary-button compact"
                      onClick={openCreateSchool}
                    >
                      School toevoegen
                    </button>
                  )}
                  <span>
                    {sortedRows.length} van {rows.length}
                  </span>
                </div>
              </div>

              <div className="mobile-card-list">
                {sortedRows.map((row) => (
                  <article
                    key={row.id}
                    className={`location-card ${row.id === selectedRow?.id ? 'selected' : ''}`}
                  >
                    <button type="button" className="location-card-main" onClick={() => selectMobileLocation(row)}>
                      <span className="location-title">
                        <i
                          className="equipment-dot"
                          style={{
                            backgroundColor: equipmentColor(row.equipment).fill,
                            borderColor: equipmentColor(row.equipment).stroke,
                          }}
                          aria-hidden="true"
                        />
                        {row.school}
                      </span>
                      <span>{row.street}</span>
                      <span>{row.city}</span>
                      <span>
                        m3 uit: {formatVolume(row.outgoing)} | m3 in: {formatVolume(row.incoming)}
                      </span>
                      <span>Materieel: {equipmentLabel(row.equipment)}</span>
                    </button>
                    <div className="location-card-actions">
                      <a
                        className="table-route-link"
                        href={googleMapsRouteUrl(row)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Route
                      </a>
                      <button type="button" className="popup-complete-button" onClick={() => openRevision(row)}>
                        {row.revision.completed ? 'Revisie aanpassen' : 'Zandbak afronden'}
                      </button>
                      {row.revision.completed && (
                        <button type="button" className="popup-reopen-button" onClick={() => reopenRevision(row)}>
                          Opnieuw openzetten
                        </button>
                      )}
                      {isAdmin && (
                        <button type="button" className="secondary-button compact" onClick={() => openEditor(row)}>
                          Bewerken
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </section>

            <button
              type="button"
              className="panel-toggle"
              onClick={() => setIsPanelOpen((current) => !current)}
              aria-expanded={isPanelOpen}
              aria-controls="location-panel"
            >
              {isPanelOpen ? 'Kaart vergroten' : `Locaties (${sortedRows.length})`}
            </button>
          </section>

          {editDraft && (
            <div className="edit-overlay" role="presentation" onClick={() => setEditDraft(null)}>
              <form className="edit-panel" onSubmit={saveDraft} onClick={(event) => event.stopPropagation()}>
                <div className="edit-header">
                  <div>
                    <p className="eyebrow">Locatie bewerken</p>
                    <h2>{editDraft.school}</h2>
                  </div>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => setEditDraft(null)}
                    aria-label="Bewerken sluiten"
                    title="Bewerken sluiten"
                  >
                    &times;
                  </button>
                </div>

                <div className="edit-grid">
                  <label className="field">
                    <span>School</span>
                    <input value={editDraft.school} onChange={(event) => updateDraft('school', event.target.value)} />
                  </label>
                  <label className="field">
                    <span>Bestuur</span>
                    <input value={editDraft.board} onChange={(event) => updateDraft('board', event.target.value)} />
                  </label>
                  <label className="field wide">
                    <span>Straatnaam</span>
                    <input value={editDraft.street} onChange={(event) => updateDraft('street', event.target.value)} />
                  </label>
                  <label className="field">
                    <span>Plaats</span>
                    <input value={editDraft.city} onChange={(event) => updateDraft('city', event.target.value)} />
                  </label>
                  <label className="field">
                    <span>m3 uit</span>
                    <input
                      value={editDraft.outgoingRaw}
                      onChange={(event) => updateDraft('outgoingRaw', event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>m3 in</span>
                    <input
                      value={editDraft.incomingRaw}
                      onChange={(event) => updateDraft('incomingRaw', event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>Materieel</span>
                    <select
                      value={editDraft.equipment}
                      onChange={(event) => updateDraft('equipment', event.target.value)}
                    >
                      {Object.keys(EQUIPMENT_COLORS).map((equipment) => (
                        <option key={equipment} value={equipment}>
                          {equipment}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Latitude</span>
                    <input value={editDraft.lat} onChange={(event) => updateDraft('lat', event.target.value)} />
                  </label>
                  <label className="field">
                    <span>Longitude</span>
                    <input value={editDraft.lng} onChange={(event) => updateDraft('lng', event.target.value)} />
                  </label>
                </div>

                <div className="edit-actions">
                  {saveError && <p className="save-error">{saveError}</p>}
                  {isAdmin && (
                    <button type="button" className="secondary-button" onClick={startMarkerRelocation}>
                      Bolletje verplaatsen
                    </button>
                  )}
                  {isAdmin && (
                    <button type="button" className="popup-reopen-button" onClick={deleteSchool}>
                      School verwijderen
                    </button>
                  )}
                  <button type="button" className="secondary-button" onClick={() => setEditDraft(null)}>
                    Annuleren
                  </button>
                  <button type="submit" className="primary-button" disabled={isSaving}>
                    {isSaving ? 'Opslaan...' : 'Opslaan'}
                  </button>
                </div>
              </form>
            </div>
          )}

          {revisionDraft && (
            <div
              className="edit-overlay"
              role="presentation"
              onClick={closeRevisionModal}
            >
              <form
                className="revision-panel"
                onSubmit={saveRevisionDraft}
                onClick={(event) => event.stopPropagation()}
              >
                <div className="edit-header">
                  <div>
                    <p className="eyebrow">Revisie werkzaamheden</p>
                    <h2>{revisionDraft.school}</h2>
                  </div>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={closeRevisionModal}
                    aria-label="Revisie sluiten"
                    title="Revisie sluiten"
                  >
                    &times;
                  </button>
                </div>

                <div className="edit-grid">
                  <label className="field">
                    <span>m3 uit uitgevoerd</span>
                    <input
                      value={revisionDraft.outgoingRaw}
                      onChange={(event) => updateRevisionDraft('outgoingRaw', event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>m3 in uitgevoerd</span>
                    <input
                      value={revisionDraft.incomingRaw}
                      onChange={(event) => updateRevisionDraft('incomingRaw', event.target.value)}
                    />
                  </label>
                  <label className="field wide">
                    <span>Materieel uitgevoerd</span>
                    <select
                      value={revisionDraft.equipment}
                      onChange={(event) => updateRevisionDraft('equipment', event.target.value)}
                    >
                      {Object.keys(EQUIPMENT_COLORS).map((equipment) => (
                        <option key={equipment} value={equipment}>
                          {equipment}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field wide">
                    <span>Opmerkingen (optioneel)</span>
                    <textarea
                      rows={4}
                      value={revisionDraft.notes}
                      onChange={(event) => updateRevisionDraft('notes', event.target.value)}
                    />
                  </label>
                  <div className="field wide revision-photo-field">
                    <span>Foto's (max 3)</span>
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      disabled={isPhotoProcessing || revisionDraft.photos.length >= MAX_REVISION_PHOTOS}
                      onChange={(event) => {
                        addRevisionPhotos(event.target.files)
                        event.target.value = ''
                      }}
                    />
                    {isPhotoProcessing && <p className="photo-processing">Foto wordt gecomprimeerd...</p>}
                    {revisionPhotoError && <p className="save-error">{revisionPhotoError}</p>}
                    {revisionDraft.photos.length > 0 && (
                      <div className="revision-photo-grid">
                        {revisionDraft.photos.map((photo, index) => (
                          <article key={photo.id} className="revision-photo-card">
                            <button
                              type="button"
                              className="revision-photo-thumb-button"
                              onClick={() => openPhotoPreview(photo, `${revisionDraft.school} foto ${index + 1}`)}
                            >
                              <img
                                className="revision-photo-thumb"
                                src={photo.dataUrl}
                                alt={`${revisionDraft.school} revisie foto ${index + 1}`}
                                loading="lazy"
                              />
                            </button>
                            <p className="revision-photo-meta">
                              {photo.width}x{photo.height} | {formatBytes(photo.sizeBytes)}
                            </p>
                            <div className="photo-card-actions">
                              <label className="secondary-button compact file-button">
                                Vervangen
                                <input
                                  className="file-hidden"
                                  type="file"
                                  accept="image/*"
                                  disabled={isPhotoProcessing}
                                  onChange={(event) => {
                                    replaceRevisionPhoto(photo.id, event.target.files?.[0])
                                    event.target.value = ''
                                  }}
                                />
                              </label>
                              <button
                                type="button"
                                className="secondary-button compact"
                                onClick={() => removeRevisionPhoto(photo.id)}
                                disabled={isPhotoProcessing}
                              >
                                Verwijderen
                              </button>
                            </div>
                          </article>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="edit-actions">
                  {revisionSaveError && <p className="save-error">{revisionSaveError}</p>}
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={closeRevisionModal}
                  >
                    Annuleren
                  </button>
                  <button type="submit" className="primary-button" disabled={isRevisionSaving || isPhotoProcessing}>
                    {isRevisionSaving ? 'Opslaan...' : 'Afronden opslaan'}
                  </button>
                </div>
              </form>
            </div>
          )}

          {createDraft && (
            <div
              className="edit-overlay"
              role="presentation"
              onClick={() => {
                setCreateDraft(null)
                setCreateSaveError('')
              }}
            >
              <form className="edit-panel" onSubmit={saveCreateDraft} onClick={(event) => event.stopPropagation()}>
                <div className="edit-header">
                  <div>
                    <p className="eyebrow">Admin beheer</p>
                    <h2>Nieuwe school toevoegen</h2>
                  </div>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => {
                      setCreateDraft(null)
                      setCreateSaveError('')
                    }}
                    aria-label="Toevoegen sluiten"
                    title="Toevoegen sluiten"
                  >
                    &times;
                  </button>
                </div>

                <div className="edit-grid">
                  <label className="field">
                    <span>School</span>
                    <input value={createDraft.school} onChange={(event) => updateCreateDraft('school', event.target.value)} />
                  </label>
                  <label className="field">
                    <span>Bestuur</span>
                    <input value={createDraft.board} onChange={(event) => updateCreateDraft('board', event.target.value)} />
                  </label>
                  <label className="field wide">
                    <span>Straatnaam</span>
                    <input value={createDraft.street} onChange={(event) => updateCreateDraft('street', event.target.value)} />
                  </label>
                  <label className="field">
                    <span>Plaats</span>
                    <input value={createDraft.city} onChange={(event) => updateCreateDraft('city', event.target.value)} />
                  </label>
                  <label className="field">
                    <span>m3 uit</span>
                    <input
                      value={createDraft.outgoingRaw}
                      onChange={(event) => updateCreateDraft('outgoingRaw', event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>m3 in</span>
                    <input
                      value={createDraft.incomingRaw}
                      onChange={(event) => updateCreateDraft('incomingRaw', event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>Materieel</span>
                    <select
                      value={createDraft.equipment}
                      onChange={(event) => updateCreateDraft('equipment', event.target.value)}
                    >
                      {Object.keys(EQUIPMENT_COLORS).map((equipment) => (
                        <option key={equipment} value={equipment}>
                          {equipment}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Latitude</span>
                    <input value={createDraft.lat} onChange={(event) => updateCreateDraft('lat', event.target.value)} />
                  </label>
                  <label className="field">
                    <span>Longitude</span>
                    <input value={createDraft.lng} onChange={(event) => updateCreateDraft('lng', event.target.value)} />
                  </label>
                </div>

                <div className="edit-actions">
                  {createSaveError && <p className="save-error">{createSaveError}</p>}
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      setCreateDraft(null)
                      setCreateSaveError('')
                    }}
                  >
                    Annuleren
                  </button>
                  <button type="submit" className="primary-button" disabled={isCreateSaving}>
                    {isCreateSaving ? 'Opslaan...' : 'School toevoegen'}
                  </button>
                </div>
              </form>
            </div>
          )}

          {photoPreview && (
            <div className="edit-overlay photo-preview-overlay" role="presentation" onClick={closePhotoPreview}>
              <div className="photo-preview-panel" onClick={(event) => event.stopPropagation()}>
                <img className="photo-preview-image" src={photoPreview.dataUrl} alt={photoPreview.label} />
                <div className="edit-actions">
                  <button type="button" className="secondary-button" onClick={closePhotoPreview}>
                    Sluiten
                  </button>
                </div>
              </div>
            </div>
          )}

          {isAuthModalOpen && (
            <div className="edit-overlay" role="presentation" onClick={closeAdminAuthModal}>
              <form
                className="auth-panel"
                onSubmit={submitAdminAuth}
                onClick={(event) => event.stopPropagation()}
              >
                <div className="auth-header">
                  <p className="eyebrow">Beheerderstoegang</p>
                  <h2>Wachtwoord vereist</h2>
                </div>

                <label className="field">
                  <span>Wachtwoord</span>
                  <input
                    autoFocus
                    type="password"
                    value={adminPasswordInput}
                    onChange={(event) => setAdminPasswordInput(event.target.value)}
                  />
                </label>

                {adminAuthError && <p className="auth-error">{adminAuthError}</p>}

                <div className="edit-actions">
                  <button type="button" className="secondary-button" onClick={closeAdminAuthModal}>
                    Annuleren
                  </button>
                  <button type="submit" className="primary-button">
                    Inloggen
                  </button>
                </div>
              </form>
            </div>
          )}
        </>
      )}
    </main>
  )
}

export default App
