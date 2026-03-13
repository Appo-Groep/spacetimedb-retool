/**
 * spacetimedb-retool
 *
 * Generic SpacetimeDB adapter for Retool.
 * HTTP REST API for queries/reducers + optional WebSocket (JSON protocol) for live subscriptions.
 *
 * Exposes window.SpacetimeDB after loading as an external library in Retool.
 *
 * Usage in Retool JS queries:
 *   await window.SpacetimeDB.call('refill_location', { product_location_id: '5', quantity_added: 100 })
 *   const rows = await window.SpacetimeDB.sql('SELECT * FROM devices WHERE is_active = true')
 *
 * Live subscriptions:
 *   window.SpacetimeDB.live.connect(['SELECT * FROM crates', 'SELECT * FROM devices'])
 *   window.SpacetimeDB.live.onChange((table, rows) => { ... })
 *   window.SpacetimeDB.live.getTable('crates')  // current cached rows
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SpacetimeConfig {
  /** Base URL of the SpacetimeDB instance, e.g. https://host/spacetimedb/module */
  httpBase: string
  /** Database / module name, e.g. 'warehouse-scanner' */
  database: string
  /** Base URL of the auth server, e.g. https://host/auth-server */
  authBase: string
}

export interface LoginResult {
  token:       string
  expiresAt:   string
  employeeTag: string
  deviceId:    string
  role?:       string
}

// ─── State ────────────────────────────────────────────────────────────────────

let _config: SpacetimeConfig | null = null
let _token:  string | null          = null

function assertConfig(): SpacetimeConfig {
  if (!_config) throw new Error('[SpacetimeDB] Call configure() before making any requests.')
  return _config
}

function assertToken(): string {
  if (!_token) throw new Error('[SpacetimeDB] Not authenticated. Call auth.login() or setToken() first.')
  return _token
}

// ─── Configuration ────────────────────────────────────────────────────────────

function configure(config: SpacetimeConfig): void {
  _config = config
}

function setToken(token: string): void {
  _token = token
}

function getToken(): string | null {
  return _token
}

// ─── Status + user info ───────────────────────────────────────────────────────

export interface ConnectedUser {
  username:         string
  employeeTag:      string
  role:             string
  /** Unix timestamp (seconds) when the token expires */
  expiresAt:        number | null
  /** Seconds remaining until expiry (0 if already expired) */
  expiresInSeconds: number | null
}

function decodeJwt(token: string): Record<string, unknown> {
  try {
    const b64 = token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(b64)) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * 'unconfigured'    — configure() has not been called
 * 'unauthenticated' — configured but no token
 * 'ready'           — configured + token present
 */
function getStatus(): 'unconfigured' | 'unauthenticated' | 'ready' {
  if (!_config) return 'unconfigured'
  if (!_token)  return 'unauthenticated'
  return 'ready'
}

/** Returns decoded fields from the current JWT, or null if not authenticated. */
function getUser(): ConnectedUser | null {
  if (!_token) return null
  const p         = decodeJwt(_token)
  const expiresAt = typeof p['exp'] === 'number' ? (p['exp'] as number) : null
  return {
    username:         (p['username']     as string) ?? (p['sub'] as string) ?? '',
    employeeTag:      (p['employee_tag'] as string) ?? '',
    role:             (p['role']         as string) ?? 'employee',
    expiresAt,
    expiresInSeconds: expiresAt !== null ? Math.max(0, expiresAt - Math.floor(Date.now() / 1000)) : null,
  }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

type AuthEvent    = 'login' | 'refresh' | 'logout' | 'expired'
type AuthListener = (event: AuthEvent, user: ConnectedUser | null) => void

const _authListeners = new Set<AuthListener>()

function _fireAuth(event: AuthEvent): void {
  _authListeners.forEach(fn => fn(event, getUser()))
}

async function login(username: string, password: string): Promise<LoginResult> {
  const { authBase } = assertConfig()
  const res = await fetch(`${authBase}/auth/login`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ username, password }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, string>
    throw new Error(body['error'] ?? `Login failed (${res.status})`)
  }
  const data = await res.json() as LoginResult
  _token = data.token
  _fireAuth('login')
  return data
}

async function refresh(): Promise<LoginResult> {
  const { authBase } = assertConfig()
  const token = assertToken()
  const res = await fetch(`${authBase}/auth/refresh`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error('Token refresh failed — please log in again')
  const data = await res.json() as LoginResult
  _token = data.token
  _fireAuth('refresh')
  return data
}

function logout(): void {
  _token = null
  stopAutoRefresh()
  // Disconnect live WS — imported below as live.disconnect(), but we call the
  // internal state directly to avoid a forward-reference cycle.
  _wsEnabled = false
  if (_wsReconnectTimer) { clearTimeout(_wsReconnectTimer); _wsReconnectTimer = null }
  if (_ws) { _ws.onclose = null; _ws.close(); _ws = null }
  _fireAuth('logout')
}

// ─── Background auto-refresh ──────────────────────────────────────────────────
//
// Checks token expiry every minute and on every tab/device wake.
// Refreshes silently when within REFRESH_BEFORE_MS of expiry.
// Calls logout() (fires 'expired') if the server rejects the refresh.
// The live WebSocket is NOT reconnected — SpacetimeDB validates tokens only at
// connect time, so the existing socket continues working after a token refresh.

const REFRESH_BEFORE_MS = 5  * 60 * 1000   // refresh when 5 min remaining
const REFRESH_CHECK_MS  = 60 * 1000         // poll every 60 s

let _autoRefreshCleanup: (() => void) | null = null

function stopAutoRefresh(): void {
  if (_autoRefreshCleanup) { _autoRefreshCleanup(); _autoRefreshCleanup = null }
}

function startAutoRefresh(): void {
  stopAutoRefresh()

  const tryRefresh = async () => {
    if (!_token || !_config) return
    const p = decodeJwt(_token)
    if (typeof p['exp'] !== 'number') return

    const msLeft = (p['exp'] as number) * 1000 - Date.now()

    if (msLeft <= 0) {
      console.warn('[SpacetimeDB] Token expired — logging out')
      logout()
      _fireAuth('expired')
      return
    }

    if (msLeft > REFRESH_BEFORE_MS) return   // plenty of time left

    console.log('[SpacetimeDB] Token expires in', Math.round(msLeft / 1000), 's — refreshing')
    try {
      await refresh()   // sets _token + fires 'refresh'
    } catch (err) {
      console.warn('[SpacetimeDB] Refresh failed — logging out:', err)
      logout()
    }
  }

  const timer     = setInterval(tryRefresh, REFRESH_CHECK_MS)
  const onVisible = () => { if (document.visibilityState === 'visible') void tryRefresh() }
  document.addEventListener('visibilitychange', onVisible)
  void tryRefresh()   // check immediately

  _autoRefreshCleanup = () => {
    clearInterval(timer)
    document.removeEventListener('visibilitychange', onVisible)
  }
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function dbUrl(path: string): string {
  const { httpBase, database } = assertConfig()
  return `${httpBase}/v1/database/${encodeURIComponent(database)}${path}`
}

function authHeaders(): Record<string, string> {
  return {
    Authorization:  `Bearer ${assertToken()}`,
    'Content-Type': 'application/json',
  }
}

// ─── SQL queries ──────────────────────────────────────────────────────────────
//
// SpacetimeDB SQL response shape (v1):
//   { schema: { elements: [{ name: string | { some: string }, algebraic_type }] },
//     rows: [[val, val, ...], ...] }
//
// Column names are serialised from Rust's Option<String> so they arrive as
// either a plain string "col" or a wrapped object { "some": "col" }.
// We normalise both forms before building the result objects.

interface SqlElement {
  name: string | { some: string } | null
}

interface SqlResponse {
  schema?: { elements?: SqlElement[] }
  rows?:   unknown[][]
}

function elementName(e: SqlElement): string {
  if (!e.name) return ''
  if (typeof e.name === 'string') return e.name
  return (e.name as { some: string }).some ?? String(e.name)
}

// SpacetimeDB encodes sum types (Option, enums) as discriminant arrays:
//   Some(x) → [0, x]
//   None    → [1]
// Unwrap these recursively so callers get plain JS values.
function unwrapValue(v: unknown): unknown {
  if (Array.isArray(v)) {
    if (v.length === 2 && v[0] === 0) return unwrapValue(v[1])  // Some(x)
    if (v.length === 1 && v[0] === 1) return null               // None
    return v.map(unwrapValue)
  }
  if (v !== null && typeof v === 'object') {
    // { "some": x } form (alternative encoding)
    if ('some' in v) return unwrapValue((v as Record<string, unknown>)['some'])
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, unwrapValue(val)])
    )
  }
  return v
}

export async function sql(query: string): Promise<Record<string, unknown>[]> {
  const { Authorization } = authHeaders()
  const res = await fetch(dbUrl('/sql'), {
    method:  'POST',
    headers: { Authorization, 'Content-Type': 'text/plain' },
    body:    query,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`SQL error (${res.status}): ${text}`)
  }

  const raw = await res.json() as SqlResponse | SqlResponse[]

  // Handle both single-result and multi-result responses
  const result: SqlResponse = Array.isArray(raw) ? raw[0] : raw
  if (!result) return []

  const cols = result.schema?.elements?.map(elementName) ?? []
  const rows = result.rows ?? []

  if (cols.length === 0) return rows as Record<string, unknown>[]

  return rows.map(row =>
    Object.fromEntries(cols.map((col, i) => [col, unwrapValue(row[i])]))
  )
}

// ─── Reducer calls ────────────────────────────────────────────────────────────
//
// Accepts camelCase or snake_case reducer names — normalises to snake_case.
// SpacetimeDB HTTP API: POST /v1/database/:name/call/:reducer
//   Body: JSON object matching the reducer's argument struct.
//
// bigint fields should be passed as strings from Retool (JSON doesn't support bigint).
// SpacetimeDB accepts numeric strings for u64/i64 fields.

function toSnakeCase(name: string): string {
  return name.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '')
}

export async function call(
  reducerName: string,
  args: Record<string, unknown> = {}
): Promise<null> {
  const snake = toSnakeCase(reducerName)
  const res = await fetch(dbUrl(`/call/${encodeURIComponent(snake)}`), {
    method:  'POST',
    headers: authHeaders(),
    body:    JSON.stringify(args),
  })

  // 200 or 204 = success
  if (res.ok) return null

  const text = await res.text()
  throw new Error(`Reducer '${snake}' failed (${res.status}): ${text}`)
}

// ─── Admin: user management (wraps auth server CRUD API) ─────────────────────

export interface UserRecord {
  username:    string
  employeeTag: string
  deviceId:    string
  role:        string
}

function adminHeaders(apiKey: string): Record<string, string> {
  return {
    'X-Api-Key':    apiKey,
    'Content-Type': 'application/json',
  }
}

async function adminRequest(
  method: string,
  path: string,
  apiKey: string,
  body?: unknown
): Promise<unknown> {
  const { authBase } = assertConfig()
  const res = await fetch(`${authBase}${path}`, {
    method,
    headers: adminHeaders(apiKey),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as Record<string, string>)['error'] ?? `Request failed (${res.status})`)
  return data
}

export const admin = {
  listUsers:   (apiKey: string)                                     => adminRequest('GET',    '/auth/admin/users',         apiKey)           as Promise<UserRecord[]>,
  createUser:  (apiKey: string, user: Omit<UserRecord, never> & { password: string }) => adminRequest('POST',   '/auth/admin/users',         apiKey, user)    as Promise<UserRecord>,
  updateUser:  (apiKey: string, username: string, changes: Partial<UserRecord> & { password?: string }) => adminRequest('PUT',    `/auth/admin/users/${username}`, apiKey, changes) as Promise<UserRecord>,
  deleteUser:  (apiKey: string, username: string)                   => adminRequest('DELETE', `/auth/admin/users/${username}`, apiKey)       as Promise<{ deleted: string }>,
}

// ─── Live WebSocket subscriptions ────────────────────────────────────────────
//
// Uses SpacetimeDB's JSON WebSocket protocol (v1.json.spacetimedb) so no
// binary BSATN decoding is needed.
//
// Server → client message shapes we care about:
//
//   IdentityToken      { identity, token, address }
//   InitialSubscription { database_update: { tables: [{ table_name, updates: { inserts, deletes } }] } }
//   TransactionUpdate  { database_update: { tables: [...] }, status: { Committed? } }
//
// Each row in inserts/deletes is a plain JSON array (one element per column).
// The schema (column names) is provided in the same table object.
//
// Reconnect strategy: automatic exponential back-off (1s → 2s → 4s … 30s cap).

type ChangeListener = (table: string, rows: Record<string, unknown>[]) => void

interface WsTableSchema {
  elements: SqlElement[]
}

interface WsTableUpdate {
  table_id:   number
  table_name: string
  schema?:    WsTableSchema
  updates: {
    inserts: unknown[][]
    deletes: unknown[][]
  }
}

interface WsDatabaseUpdate {
  tables: WsTableUpdate[]
}

interface WsServerMessage {
  IdentityToken?:       { identity: string; token: string; address: string }
  InitialSubscription?: { database_update: WsDatabaseUpdate; request_id: number }
  TransactionUpdate?:   { database_update: WsDatabaseUpdate; status: Record<string, unknown> }
}

// Per-table schema cache: populated from the first InitialSubscription that includes a schema
const _schemaCache: Record<string, string[]> = {}
// Per-table row cache keyed by primary-key position [0] stringified
const _tableCache:  Record<string, Map<string, Record<string, unknown>>> = {}

let _ws:               WebSocket | null   = null
let _wsQueries:        string[]           = []
let _wsListeners:      Set<ChangeListener> = new Set()
let _wsReconnectTimer: ReturnType<typeof setTimeout> | null = null
let _wsReconnectDelay  = 1000
let _wsEnabled         = false

function wsBaseUrl(): string {
  const { httpBase, database } = assertConfig()
  // http(s) → ws(s), strip trailing slash
  const base = httpBase.replace(/^http/, 'ws').replace(/\/$/, '')
  return `${base}/v1/database/${encodeURIComponent(database)}/subscribe`
}

function applyTableUpdate(update: WsTableUpdate): Record<string, unknown>[] {
  const name = update.table_name

  // Update schema cache if provided
  if (update.schema?.elements) {
    _schemaCache[name] = update.schema.elements.map(elementName)
  }
  const cols = _schemaCache[name] ?? []

  if (!_tableCache[name]) _tableCache[name] = new Map()
  const cache = _tableCache[name]!

  const toObj = (row: unknown[]): Record<string, unknown> =>
    cols.length > 0
      ? Object.fromEntries(cols.map((col, i) => [col, unwrapValue(row[i])]))
      : { _row: row.map(unwrapValue) }

  // Apply deletes first
  for (const row of (update.updates.deletes ?? [])) {
    const obj = toObj(row as unknown[])
    const pk  = String(obj[cols[0] ?? '_row'] ?? JSON.stringify(obj))
    cache.delete(pk)
  }

  // Apply inserts / upserts
  for (const row of (update.updates.inserts ?? [])) {
    const obj = toObj(row as unknown[])
    const pk  = String(obj[cols[0] ?? '_row'] ?? JSON.stringify(obj))
    cache.set(pk, obj)
  }

  return Array.from(cache.values())
}

function handleWsMessage(raw: string): void {
  let msg: WsServerMessage
  try { msg = JSON.parse(raw) } catch { return }

  if (msg.IdentityToken) {
    console.log('[SpacetimeDB WS] Connected, identity:', msg.IdentityToken.identity)
    _wsReconnectDelay = 1000
    // Send subscription
    const sub = JSON.stringify({ Subscribe: { query_strings: _wsQueries } })
    _ws?.send(sub)
    return
  }

  const dbUpdate =
    msg.InitialSubscription?.database_update ??
    msg.TransactionUpdate?.database_update

  if (!dbUpdate) return

  // Skip failed transactions
  if (msg.TransactionUpdate && !msg.TransactionUpdate.status?.['Committed']) return

  for (const tableUpdate of (dbUpdate.tables ?? [])) {
    const rows = applyTableUpdate(tableUpdate)
    _wsListeners.forEach(fn => fn(tableUpdate.table_name, rows))
  }
}

function wsConnect(): void {
  if (_ws) { _ws.onclose = null; _ws.close() }

  const token = _token
  const url   = wsBaseUrl() + (token ? `?token=${encodeURIComponent(token)}` : '')

  const socket = new WebSocket(url, ['v1.json.spacetimedb'])
  _ws = socket

  socket.onmessage = (e) => handleWsMessage(e.data as string)

  socket.onerror = (e) => console.warn('[SpacetimeDB WS] Error:', e)

  socket.onclose = (e) => {
    _ws = null
    if (!_wsEnabled) return
    console.warn(`[SpacetimeDB WS] Closed (${e.code}) — reconnecting in ${_wsReconnectDelay}ms`)
    _wsReconnectTimer = setTimeout(() => {
      _wsReconnectDelay = Math.min(_wsReconnectDelay * 2, 30_000)
      wsConnect()
    }, _wsReconnectDelay)
  }
}

export const live = {
  /**
   * Open a WebSocket subscription. Automatically reconnects on disconnect.
   * @param queries  SQL SELECT queries to subscribe to, e.g. ['SELECT * FROM crates']
   */
  connect(queries: string[]): void {
    if (_wsReconnectTimer) { clearTimeout(_wsReconnectTimer); _wsReconnectTimer = null }
    _wsEnabled   = true
    _wsQueries   = queries
    _tableCache  // keep existing cache across reconnects
    wsConnect()
  },

  /** Close the WebSocket and stop reconnecting. */
  disconnect(): void {
    _wsEnabled = false
    if (_wsReconnectTimer) { clearTimeout(_wsReconnectTimer); _wsReconnectTimer = null }
    if (_ws) { _ws.onclose = null; _ws.close(); _ws = null }
  },

  /** True when the WebSocket is open and ready. */
  isConnected(): boolean {
    return _ws?.readyState === WebSocket.OPEN
  },

  /**
   * Get the current cached rows for a subscribed table.
   * Returns [] before the initial subscription arrives.
   */
  getTable(name: string): Record<string, unknown>[] {
    return _tableCache[name] ? Array.from(_tableCache[name]!.values()) : []
  },

  /**
   * Register a callback fired whenever subscribed table data changes.
   * Returns an unsubscribe function.
   *
   * @example
   * const unsub = window.SpacetimeDB.live.onChange((table, rows) => {
   *   if (table === 'crates') cratesState.setValue(rows)
   * })
   */
  onChange(fn: ChangeListener): () => void {
    _wsListeners.add(fn)
    return () => _wsListeners.delete(fn)
  },
}

// ─── Expose on window ─────────────────────────────────────────────────────────

const api = {
  configure,
  setToken,
  getToken,
  getStatus,
  getUser,
  sql,
  call,
  live,
  admin,
  auth: {
    login,
    refresh,
    logout,
    startAutoRefresh,
    stopAutoRefresh,
    /** Subscribe to auth lifecycle events: 'login' | 'refresh' | 'logout' | 'expired' */
    onChange(fn: AuthListener): () => void {
      _authListeners.add(fn)
      return () => _authListeners.delete(fn)
    },
  },
}

;(window as any).SpacetimeDB = api

export default api
