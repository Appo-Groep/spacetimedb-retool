/**
 * spacetimedb-retool
 *
 * Generic SpacetimeDB adapter for Retool.
 * Uses SpacetimeDB's HTTP REST API — no generated bindings, no BSATN, no WebSocket.
 *
 * Exposes window.SpacetimeDB after loading as an external library in Retool.
 *
 * Usage in Retool JS queries:
 *   await window.SpacetimeDB.call('refill_location', { product_location_id: '5', quantity_added: 100 })
 *   const rows = await window.SpacetimeDB.sql('SELECT * FROM devices WHERE is_active = true')
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

// ─── Auth ─────────────────────────────────────────────────────────────────────

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
  return data
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
//   { schema: { elements: [{ name, algebraic_type }] }, rows: [[val, val, ...], ...] }
//
// We convert to an array of plain objects keyed by column name.

interface SqlResponse {
  schema?: { elements?: Array<{ name: string }> }
  rows?:   unknown[][]
}

export async function sql(query: string): Promise<Record<string, unknown>[]> {
  const res = await fetch(dbUrl('/sql'), {
    method:  'POST',
    headers: authHeaders(),
    body:    JSON.stringify({ query }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`SQL error (${res.status}): ${text}`)
  }

  const raw = await res.json() as SqlResponse | SqlResponse[]

  // Handle both single-result and multi-result responses
  const result: SqlResponse = Array.isArray(raw) ? raw[0] : raw
  if (!result) return []

  const cols = result.schema?.elements?.map(e => e.name) ?? []
  const rows = result.rows ?? []

  if (cols.length === 0) return rows as Record<string, unknown>[]

  return rows.map(row =>
    Object.fromEntries(cols.map((col, i) => [col, row[i]]))
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

// ─── Expose on window ─────────────────────────────────────────────────────────

const api = {
  configure,
  setToken,
  getToken,
  sql,
  call,
  admin,
  auth: { login, refresh },
}

;(window as any).SpacetimeDB = api

export default api
