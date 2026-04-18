import { useEffect, useMemo, useState } from 'react'
import { CircleMarker, MapContainer, Popup, TileLayer, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import './App.css'
import { locationsByKey } from './data/locations'

const CSV_URL = '/planning-zandbakken.csv'
const ROWS_API_URL = '/api/rows'
const STORAGE_KEY = 'zandbak-dashboard-rows'
const MAP_CENTER = [52.466, 4.81]
const MOBILE_QUERY = '(max-width: 760px)'
const UNKNOWN_VALUES = new Set(['', '?', '-'])
const EQUIPMENT_COLORS = {
  Mobiel: { fill: '#2563eb', stroke: '#1e3a8a' },
  Kraan: { fill: '#f97316', stroke: '#9a3412' },
  Knijper: { fill: '#9333ea', stroke: '#581c87' },
  Knikmops: { fill: '#0d9488', stroke: '#115e59' },
  Onbekend: { fill: '#64748b', stroke: '#334155' },
}
const STATUS_OPTIONS = [
  { label: 'Alle statussen', value: 'all' },
  { label: 'Compleet', value: 'complete' },
  { label: 'Gegevens controleren', value: 'check' },
]

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

function equipmentLabel(equipment) {
  return UNKNOWN_VALUES.has(equipment) ? 'Onbekend' : equipment
}

function equipmentColor(equipment) {
  return EQUIPMENT_COLORS[equipmentLabel(equipment)] ?? EQUIPMENT_COLORS.Onbekend
}

function googleMapsRouteUrl(row) {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
    `${row.street}, ${row.city}, Nederland`,
  )}`
}

function makeLocationKey(row) {
  return `${cleanValue(row.school)}|${cleanValue(row.street)}|${cleanValue(row.city)}`
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

  normalized.outgoing = parseDutchNumber(normalized.outgoingRaw)
  normalized.incoming = parseDutchNumber(normalized.incomingRaw)
  normalized.location = location ?? null
  normalized.needsCheck = !location

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
  }

  revived.outgoing = parseDutchNumber(revived.outgoingRaw)
  revived.incoming = parseDutchNumber(revived.incomingRaw)
  revived.needsCheck = !revived.location

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
}

function getOptionValues(rows, field) {
  return [...new Set(rows.map((row) => row[field]).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, 'nl'),
  )
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
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState({
    board: 'all',
    city: 'all',
    equipment: [],
    status: 'all',
  })
  const [sortConfig, setSortConfig] = useState({ key: 'school', direction: 'asc' })
  const [selectedId, setSelectedId] = useState(null)
  const [isPanelOpen, setIsPanelOpen] = useState(false)
  const [editDraft, setEditDraft] = useState(null)
  const [isEquipmentMenuOpen, setIsEquipmentMenuOpen] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [mobileView, setMobileView] = useState('map')
  const [isMobileFiltersOpen, setIsMobileFiltersOpen] = useState(false)

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

        if (!serverRows && storedRows) {
          saveRowsToServer(storedRows).catch(() => {})
        }

        setRows(parsedRows)
        setSelectedId(parsedRows[0]?.id ?? null)
        setLoadState('ready')
      } catch {
        setLoadState('error')
      }
    }

    loadRows()
  }, [])

  useEffect(() => {
    if (!editDraft) {
      return undefined
    }

    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        setEditDraft(null)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [editDraft])

  const boardOptions = useMemo(() => getOptionValues(rows, 'board'), [rows])
  const cityOptions = useMemo(() => getOptionValues(rows, 'city'), [rows])
  const equipmentOptions = useMemo(() => getOptionValues(rows, 'equipment'), [rows])

  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase()

    return rows.filter((row) => {
      const matchesSearch =
        !query ||
        [row.school, row.board, row.street, row.city, row.equipment]
          .join(' ')
          .toLowerCase()
          .includes(query)
      const matchesBoard = filters.board === 'all' || row.board === filters.board
      const matchesCity = filters.city === 'all' || row.city === filters.city
      const matchesEquipment =
        filters.equipment.length === 0 || filters.equipment.includes(equipmentLabel(row.equipment))
      const matchesStatus =
        filters.status === 'all' ||
        (filters.status === 'complete' && !row.needsCheck) ||
        (filters.status === 'check' && row.needsCheck)

      return matchesSearch && matchesBoard && matchesCity && matchesEquipment && matchesStatus
    })
  }, [filters, rows, search])

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
      const equipment = current.equipment.includes(value)
        ? current.equipment.filter((item) => item !== value)
        : [...current.equipment, value]

      return { ...current, equipment }
    })
  }

  function equipmentFilterLabel() {
    if (filters.equipment.length === 0) {
      return 'Alle materieel'
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
    setSelectedId(row.id)
    setEditDraft(rowToDraft(row))
  }

  function selectMobileLocation(row) {
    setSelectedId(row.id)
    setMobileView('map')
  }

  function updateDraft(name, value) {
    setEditDraft((current) => ({ ...current, [name]: value }))
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

    try {
      await saveRowsToServer(nextRows)
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeRows(nextRows)))
    } catch {
      setSaveError('Opslaan naar de server is niet gelukt. Controleer of de devserver draait.')
      setIsSaving(false)
      return
    }

    setRows(nextRows)
    setSelectedId(nextRow.id)
    setEditDraft(null)
    setIsSaving(false)
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
        <div className="source-pill">Bron: public/planning-zandbakken.csv</div>
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
            <label className="field search-field">
              <span>Zoeken</span>
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="School, adres, plaats of materieel"
              />
            </label>

            <label className="field">
              <span>Bestuur</span>
              <select value={filters.board} onChange={(event) => updateFilter('board', event.target.value)}>
                <option value="all">Alle besturen</option>
                {boardOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Plaats</span>
              <select value={filters.city} onChange={(event) => updateFilter('city', event.target.value)}>
                <option value="all">Alle plaatsen</option>
                {cityOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>

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
                      const label = equipmentLabel(option)

                      return (
                        <label key={option} className="check-option">
                          <input
                            type="checkbox"
                            checked={filters.equipment.includes(label)}
                            onChange={() => toggleEquipmentFilter(label)}
                          />
                          <i
                            className="equipment-dot"
                            style={{
                              backgroundColor: equipmentColor(option).fill,
                              borderColor: equipmentColor(option).stroke,
                            }}
                            aria-hidden="true"
                          />
                          <span>{label}</span>
                        </label>
                      )
                    })}
                    {filters.equipment.length > 0 && (
                      <button
                        type="button"
                        className="clear-filter"
                        onClick={() => updateFilter('equipment', [])}
                      >
                        Alles tonen
                      </button>
                    )}
                  </div>
                )}
              </div>
            </label>

            <label className="field">
              <span>Status</span>
              <select value={filters.status} onChange={(event) => updateFilter('status', event.target.value)}>
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
              {loadState === 'loading' ? (
                <div className="state-message compact">CSV laden...</div>
              ) : (
                <MapContainer center={MAP_CENTER} zoom={12} scrollWheelZoom className="map">
                  <TileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  />
                  <MapFocus selectedRow={selectedRow} />
                  {sortedRows
                    .filter((row) => row.location)
                    .map((row) => (
                      <CircleMarker
                        key={row.id}
                        center={[row.location.lat, row.location.lng]}
                        pathOptions={{
                          color: row.id === selectedRow?.id ? '#172554' : equipmentColor(row.equipment).stroke,
                          fillColor: equipmentColor(row.equipment).fill,
                          fillOpacity: row.id === selectedRow?.id ? 0.95 : 0.72,
                          weight: row.id === selectedRow?.id ? 4 : 2,
                        }}
                        radius={row.id === selectedRow?.id ? 11 : 8}
                        eventHandlers={{
                          click: () => setSelectedId(row.id),
                          contextmenu: (event) => {
                            event.originalEvent.preventDefault()
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
                          <div className="popup-actions">
                            <a
                              className="route-link"
                              href={googleMapsRouteUrl(row)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Routebeschrijving
                            </a>
                            <button type="button" className="popup-edit-button" onClick={() => openEditor(row)}>
                              Bewerken
                            </button>
                          </div>
                          {row.needsCheck && <em>Gegevens controleren</em>}
                        </Popup>
                      </CircleMarker>
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
                <span>
                  {sortedRows.length} van {rows.length}
                </span>
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
                      <button type="button" className="secondary-button compact" onClick={() => openEditor(row)}>
                        Bewerken
                      </button>
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
        </>
      )}
    </main>
  )
}

export default App
