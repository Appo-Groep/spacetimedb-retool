# spacetimedb-retool

Generic SpacetimeDB adapter for [Retool](https://retool.com).

Uses SpacetimeDB's HTTP REST API — no WebSocket, no BSATN, no generated bindings.
Exposes `window.SpacetimeDB` after being loaded as an [external library](https://docs.retool.com/apps/web/guides/scripts-and-libraries) in Retool.

---

## Quick start

### 1. Add to Retool as an external library

In your Retool app → **Settings → Libraries → Add library**:

```
https://cdn.jsdelivr.net/gh/<your-github-user>/spacetimedb-retool@0.1.0/dist/spacetimedb-retool.js
```

### 2. Create a Setup JS query (run on page load)

```js
window.SpacetimeDB.configure({
  httpBase: 'https://your-host/spacetimedb/instance',
  database: 'your-database-name',
  authBase: 'https://your-host/auth-server',
})

// Login with username/password
const result = await window.SpacetimeDB.auth.login(
  retoolContext.currentUser.email,
  loginPasswordInput.value,
)
return result

// Or set a pre-existing token
// window.SpacetimeDB.setToken(tokenState.value)
```

### 3. Call reducers

```js
return await window.SpacetimeDB.call('refill_location', {
  product_location_id: '5',
  quantity_added: 100,
})
```

### 4. Query tables

```js
return await window.SpacetimeDB.sql('SELECT * FROM devices WHERE is_active = true')
```

---

## API

| Method | Description |
|--------|-------------|
| `configure(config)` | Set httpBase, database, authBase |
| `setToken(token)` | Set auth token manually |
| `getToken()` | Get current token |
| `auth.login(username, password)` | Login via auth server, stores token |
| `auth.refresh()` | Refresh current token |
| `sql(query)` | Run SQL, returns `Record<string, unknown>[]` |
| `call(reducer, args?)` | Call a reducer (camelCase or snake_case) |
| `admin.listUsers(apiKey)` | List all users |
| `admin.createUser(apiKey, user)` | Create user |
| `admin.updateUser(apiKey, username, changes)` | Update user |
| `admin.deleteUser(apiKey, username)` | Delete user |

---

## Codegen

Generate Retool-ready JS query stubs from your SpacetimeDB module source:

```bash
npm install
npx ts-node codegen/index.ts ../module/src/index.ts ./queries your-database-name
```

Outputs:
- `queries/00_setup.js` — configure + login template
- `queries/reducers/<reducer>.js` — one file per reducer
- `queries/tables/<table>.js` — one file per table

---

## Build

```bash
npm install
npm run build   # → dist/spacetimedb-retool.js
```

To publish a new version:

```bash
git tag v0.1.0
git push origin v0.1.0
```

jsDelivr serves the bundle within ~24 hours of tagging.

---

## Notes

- `u64`/`i64` values must be passed as strings (JSON has no bigint)
- SpacetimeDB accepts numeric strings for u64/i64 reducer arguments
- The library assumes your auth server follows the `POST /auth/login` → `{ token }` convention
