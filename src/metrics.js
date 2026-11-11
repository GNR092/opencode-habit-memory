import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { storePath } from "./store.js"
import { recordCollectorFlush, recordCollectorPending } from "./plugin-stats.js"

// F2 contract: OpenCode v2.2.7 events are `{ id, created, type, data }`.
// normalizeEvent also tolerates `properties` / `createdAt` / `eventID` so a
// future or alternate runtime does not silently drop data. Live ingestion uses
// session.step.ended and session.usage.recorded; backfill uses Session.Info
// (one approximate row per session, source = backfill).
export const metricsPath = join(dirname(storePath), "metrics.db")
export const retentionDays = 90
const stepKinds = ["primary", "subagent", "title", "compaction", "generate", "other"]
const sources = ["live", "backfill"]
const defaultRangeDays = 30
const maxRangeDays = 90
const topLimit = 50

const schema = `
CREATE TABLE IF NOT EXISTS steps (
  id INTEGER PRIMARY KEY,
  day TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- sha256("message:" + assistantMessageID) for steps; sha256("event:" + event.id) for usage events.
  message_hash TEXT NOT NULL UNIQUE,
  session_hash TEXT NOT NULL,
  parent_hash TEXT,
  project_hash TEXT,
  directory TEXT,
  agent TEXT,
  provider TEXT,
  model TEXT,
  variant TEXT,
  kind TEXT NOT NULL CHECK (kind IN (${stepKinds.map((kind) => `'${kind}'`).join(", ")})),
  source TEXT NOT NULL DEFAULT 'live' CHECK (source IN (${sources.map((source) => `'${source}'`).join(", ")})),
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  -- 1 when the runtime reported a positive cost; 0 means missing/free.
  priced INTEGER NOT NULL DEFAULT 0 CHECK (priced IN (0, 1))
);
CREATE INDEX IF NOT EXISTS steps_day_idx ON steps(day);
CREATE INDEX IF NOT EXISTS steps_session_idx ON steps(session_hash);
CREATE TABLE IF NOT EXISTS monthly (
  month TEXT NOT NULL,
  project_hash TEXT NOT NULL DEFAULT '',
  agent TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  steps INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  cost REAL NOT NULL,
  priced_steps INTEGER NOT NULL,
  PRIMARY KEY (month, project_hash, agent, provider, model, kind)
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

const hash = (value) => createHash("sha256").update(value).digest("hex")
const isId = (value) => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value)
const requiredId = (value, name) => {
  if (!isId(value)) throw new Error(`Invalid metrics ${name}`)
  return value
}
const count = (value) => {
  if (value === undefined) return 0
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid token count")
  return value
}
const money = (value) => {
  if (value === undefined) return 0
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid cost")
  return value
}
const label = (value, max, allowSlash) => {
  if (value === undefined || value === null) return null
  if (typeof value !== "string") throw new Error("Invalid metrics label")
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.length > max || /[\u0000-\u001f\u007f]/.test(trimmed) || trimmed.includes("://") || trimmed.startsWith("/") || trimmed.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.includes("..")) throw new Error("Invalid metrics label")
  const pattern = allowSlash ? /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/ : /^[A-Za-z0-9][A-Za-z0-9._-]*$/
  if (!pattern.test(trimmed)) throw new Error("Invalid metrics label")
  return trimmed
}
const directoryName = (value) => {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 4096) return null
  const name = basename(trimmed)
  return name && name !== "." && name !== ".." && name.length <= 128 && !/[\\/\u0000-\u001f\u007f]/.test(name) ? name : null
}
const tokenUsage = (value) => {
  if (value === undefined) return { input: 0, output: 0, reasoning: 0, read: 0, write: 0 }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid token usage")
  const cache = value.cache === undefined ? {} : value.cache
  if (!cache || typeof cache !== "object" || Array.isArray(cache)) throw new Error("Invalid token cache usage")
  return { input: count(value.input), output: count(value.output), reasoning: count(value.reasoning), read: count(cache.read), write: count(cache.write) }
}
const eventData = (event) => event?.data ?? event?.properties?.data ?? event?.properties

function buildRow({ sessionID, messageHash, created, tokens, cost, kind, source, session }) {
  const dimensions = session && typeof session === "object" && !Array.isArray(session) ? session : {}
  const model = dimensions.model
  const modelID = typeof model === "string" ? model : model?.id
  const providerID = typeof model === "string" ? undefined : model?.providerID
  const variant = typeof model === "string" ? undefined : model?.variant
  return {
    day: new Date(created).toISOString().slice(0, 10),
    created_at: created,
    message_hash: messageHash,
    session_hash: hash(sessionID),
    parent_hash: isId(dimensions.parentID) ? hash(dimensions.parentID) : null,
    project_hash: isId(dimensions.projectID) ? hash(dimensions.projectID) : null,
    directory: directoryName(dimensions.location?.directory),
    agent: label(dimensions.agent, 64, false),
    provider: label(providerID, 64, true),
    model: label(modelID, 128, true),
    variant: label(variant, 64, true),
    kind,
    source,
    input_tokens: tokens.input,
    output_tokens: tokens.output,
    reasoning_tokens: tokens.reasoning,
    cache_read_tokens: tokens.read,
    cache_write_tokens: tokens.write,
    cost,
    priced: cost > 0 ? 1 : 0,
  }
}

export function normalizeEvent(event, { session, now = Date.now } = {}) {
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("Invalid metrics event")
  if (event.type !== "session.step.ended" && event.type !== "session.usage.recorded") return undefined
  const data = eventData(event)
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid metrics event data")
  const sessionID = requiredId(data.sessionID, "sessionID")
  const created = event.created ?? event.createdAt ?? now()
  if (!Number.isSafeInteger(created) || created < 0) throw new Error("Invalid metrics timestamp")
  const tokens = tokenUsage(data.tokens)
  const cost = money(data.cost)
  const step = event.type === "session.step.ended"
  const messageHash = step
    ? hash(`message:${requiredId(data.assistantMessageID, "assistantMessageID")}`)
    : hash(`event:${requiredId(event.id ?? event.eventID ?? `${sessionID}:${data.source}:${created}`, "event id")}`)
  const kind = step
    ? (isId(session?.parentID) ? "subagent" : "primary")
    : (["title", "compaction", "generate"].includes(data.source) ? data.source : "other")
  return buildRow({ sessionID, messageHash, created, tokens, cost, kind, source: "live", session })
}

export function normalizeSession(session, { now = Date.now } = {}) {
  if (!session || typeof session !== "object" || Array.isArray(session)) throw new Error("Invalid metrics session")
  const sessionID = requiredId(session.id, "session id")
  const created = session.time?.updated ?? session.time?.created ?? now()
  if (!Number.isSafeInteger(created) || created < 0) throw new Error("Invalid metrics timestamp")
  return buildRow({
    sessionID,
    messageHash: hash(`session:${sessionID}`),
    created,
    tokens: tokenUsage(session.tokens),
    cost: money(session.cost),
    kind: isId(session.parentID) ? "subagent" : "primary",
    source: "backfill",
    session,
  })
}

function migrate(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(steps)").all().map((column) => column.name))
  if (!columns.has("source")) db.exec("ALTER TABLE steps ADD COLUMN source TEXT NOT NULL DEFAULT 'live'")
  db.exec("CREATE INDEX IF NOT EXISTS steps_session_source_idx ON steps(session_hash, source)")
}

function openDatabase(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(path)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec("PRAGMA synchronous = NORMAL")
  db.exec(schema)
  migrate(db)
  secure(path)
  return db
}

function secure(path) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { chmodSync(`${path}${suffix}`, 0o600) } catch (error) { if (error.code !== "ENOENT") throw error }
  }
}

export function createMetricsStore({ path = metricsPath, now = Date.now } = {}) {
  if (typeof path !== "string" || !path) throw new Error("metrics path is required")
  if (typeof now !== "function") throw new Error("now must be a function")
  const db = openDatabase(path)
  const insert = db.prepare(`INSERT INTO steps (
    day, created_at, message_hash, session_hash, parent_hash, project_hash, directory,
    agent, provider, model, variant, kind, source, input_tokens, output_tokens, reasoning_tokens,
    cache_read_tokens, cache_write_tokens, cost, priced
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(message_hash) DO NOTHING`)
  const deleteOld = db.prepare("DELETE FROM steps WHERE day < ?")
  const liveSession = db.prepare("SELECT 1 AS found FROM steps WHERE session_hash = ? AND source = 'live' LIMIT 1")
  const getMetaStatement = db.prepare("SELECT value FROM meta WHERE key = ?")
  const setMetaStatement = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
  let closed = false

  const ensureOpen = () => { if (closed) throw new Error("Metrics store is closed") }
  const cutoffDay = () => {
    const date = new Date(now())
    if (!Number.isSafeInteger(date.getTime())) throw new Error("Invalid metrics clock")
    const cutoff = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
    cutoff.setUTCDate(cutoff.getUTCDate() - (retentionDays - 1))
    return cutoff.toISOString().slice(0, 10)
  }
  const insertRows = (rows, { skipLive = false } = {}) => {
    ensureOpen()
    if (!rows.length) return 0
    let inserted = 0
    db.exec("BEGIN IMMEDIATE")
    try {
      for (const row of rows) {
        if (skipLive && liveSession.get(row.session_hash)) continue
        inserted += Number(insert.run(
          row.day, row.created_at, row.message_hash, row.session_hash, row.parent_hash, row.project_hash, row.directory,
          row.agent, row.provider, row.model, row.variant, row.kind, row.source, row.input_tokens, row.output_tokens, row.reasoning_tokens,
          row.cache_read_tokens, row.cache_write_tokens, row.cost, row.priced,
        ).changes)
      }
      deleteOld.run(cutoffDay())
      db.exec("COMMIT")
      secure(path)
    } catch (error) {
      try { db.exec("ROLLBACK") } catch {}
      throw error
    }
    return inserted
  }
  const normalizeSessions = (sessions) => {
    const rows = []
    for (const session of sessions) {
      try {
        const row = normalizeSession(session, { now })
        if (row) rows.push(row)
      } catch {}
    }
    return rows
  }

  return {
    path,
    ingestEvent(event, { session } = {}) {
      const row = normalizeEvent(event, { session, now })
      return row ? insertRows([row]) : 0
    },
    ingestEvents(events, { sessions } = {}) {
      if (!Array.isArray(events)) throw new Error("events must be an array")
      const rows = []
      for (const event of events) {
        try {
          const data = eventData(event)
          const session = sessions instanceof Map ? sessions.get(data?.sessionID) : undefined
          const row = normalizeEvent(event, { session, now })
          if (row) rows.push(row)
        } catch {}
      }
      return insertRows(rows)
    },
    ingestSessions(sessions) {
      if (!Array.isArray(sessions)) throw new Error("sessions must be an array")
      return insertRows(normalizeSessions(sessions), { skipLive: true })
    },
    getMeta(key) {
      ensureOpen()
      if (typeof key !== "string" || !key || key.length > 128) throw new Error("Invalid metrics meta key")
      return getMetaStatement.get(key)?.value
    },
    setMeta(key, value) {
      ensureOpen()
      if (typeof key !== "string" || !key || key.length > 128) throw new Error("Invalid metrics meta key")
      if (typeof value !== "string" || value.length > 512) throw new Error("Invalid metrics meta value")
      setMetaStatement.run(key, value)
    },
    prune() {
      ensureOpen()
      const changes = Number(deleteOld.run(cutoffDay()).changes)
      secure(path)
      return changes
    },
    rebuildMonthly() {
      ensureOpen()
      db.exec("BEGIN IMMEDIATE")
      try {
        db.exec("DELETE FROM monthly")
        db.exec(`INSERT INTO monthly (
          month, project_hash, agent, provider, model, kind, steps, input_tokens, output_tokens,
          reasoning_tokens, cache_read_tokens, cache_write_tokens, cost, priced_steps
        ) SELECT substr(day, 1, 7), coalesce(project_hash, ''), coalesce(agent, ''), coalesce(provider, ''),
          coalesce(model, ''), kind, count(*), sum(input_tokens), sum(output_tokens), sum(reasoning_tokens),
          sum(cache_read_tokens), sum(cache_write_tokens), sum(cost), sum(priced)
          FROM steps
          GROUP BY substr(day, 1, 7), coalesce(project_hash, ''), coalesce(agent, ''), coalesce(provider, ''), coalesce(model, ''), kind`)
        db.exec("COMMIT")
      } catch (error) {
        try { db.exec("ROLLBACK") } catch {}
        throw error
      }
    },
    close() {
      if (closed) return
      closed = true
      db.close()
    },
  }
}

export function createMetricsCollector({
  store,
  subscribe,
  getSession,
  now = Date.now,
  flushInterval = 15_000,
  flushSize = 500,
  cacheSize = 512,
} = {}) {
  if (!store || typeof store.ingestEvents !== "function" || typeof store.getMeta !== "function" || typeof store.setMeta !== "function") throw new Error("metrics store is required")
  if (typeof subscribe !== "function") throw new Error("subscribe is required")
  if (!Number.isSafeInteger(flushInterval) || flushInterval < 0) throw new Error("flushInterval must be a non-negative integer")
  if (!Number.isSafeInteger(flushSize) || flushSize < 1) throw new Error("flushSize must be a positive integer")
  if (!Number.isSafeInteger(cacheSize) || cacheSize < 1) throw new Error("cacheSize must be a positive integer")

  const sessions = new Map()
  const pending = []
  const controller = new AbortController()
  let timer
  let closed = false
  let lastError

  const remember = (sessionID, session) => {
    if (sessions.has(sessionID)) sessions.delete(sessionID)
    else if (sessions.size >= cacheSize) sessions.delete(sessions.keys().next().value)
    sessions.set(sessionID, session)
  }
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = undefined }
    if (!pending.length) return 0
    const batch = pending.splice(0)
    const sessionMap = new Map()
    for (const { event, session } of batch) {
      const sessionID = eventData(event)?.sessionID
      if (typeof sessionID === "string" && session) sessionMap.set(sessionID, session)
    }
    try {
      const inserted = store.ingestEvents(batch.map(({ event }) => event), { sessions: sessionMap })
      recordCollectorFlush(0, false)
      return inserted
    } catch (error) {
      recordCollectorFlush(batch.length, true)
      throw error
    }
  }
  const schedule = () => {
    if (closed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = undefined; try { flush() } catch {} }, flushInterval)
    timer.unref?.()
  }
  const run = async () => {
    try {
      if (!store.getMeta("source.liveFrom")) store.setMeta("source.liveFrom", new Date(now()).toISOString())
    } catch {}
    try {
      for await (const event of subscribe({ types: ["session.step.ended", "session.usage.recorded"], signal: controller.signal })) {
        if (closed) break
        const sessionID = eventData(event)?.sessionID
        let session
        if (typeof sessionID === "string" && sessionID) {
          if (sessions.has(sessionID)) session = sessions.get(sessionID)
          else if (typeof getSession === "function") {
            try { session = await getSession(sessionID) } catch {}
          }
          if (session) remember(sessionID, session)
        }
        pending.push({ event, session })
        recordCollectorPending(pending.length)
        if (pending.length >= flushSize) { try { flush() } catch {} }
        else schedule()
      }
    } catch (error) {
      if (!controller.signal.aborted) lastError = error
    } finally {
      try { flush() } catch {}
    }
  }
  const done = run()

  return {
    done,
    flush,
    stop: async () => {
      if (closed) return
      closed = true
      controller.abort()
      if (timer) { clearTimeout(timer); timer = undefined }
      try { flush() } catch {}
      await done
    },
    get error() { return lastError },
  }
}

export async function backfillMetrics({ store, listSessions, now = Date.now, limit = 5000 } = {}) {
  if (!store || typeof store.ingestSessions !== "function" || typeof store.getMeta !== "function" || typeof store.setMeta !== "function") throw new Error("metrics store is required")
  if (typeof listSessions !== "function") throw new Error("listSessions is required")
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("limit must be a positive integer")
  let inserted = 0
  let seen = 0
  try {
    if (store.getMeta("source.backfillAt")) return { skipped: true, inserted: 0, seen: 0 }
    const current = now()
    if (!Number.isSafeInteger(current) || current < 0) throw new Error("Invalid metrics clock")
    const cutoff = current - retentionDays * 86_400_000
    let cursor
    while (seen < limit) {
      const result = await listSessions({ limit: 100, order: "desc", cursor })
      const sessions = Array.isArray(result?.data) ? result.data : Array.isArray(result) ? result : []
      if (!sessions.length) break
      const page = []
      let stop = false
      for (const session of sessions) {
        seen++
        const updated = session?.time?.updated ?? session?.time?.created
        if (Number.isFinite(updated) && updated < cutoff) { stop = true; break }
        if (session?.id) page.push(session)
        if (seen >= limit) { stop = true; break }
      }
      if (page.length) inserted += store.ingestSessions(page)
      if (stop) break
      cursor = result?.cursor?.next
      if (!cursor) break
    }
    store.setMeta("source.backfillAt", new Date(current).toISOString())
    return { skipped: false, inserted, seen }
  } catch (error) {
    return { skipped: false, inserted, seen, error: error instanceof Error ? error.message : "Backfill failed" }
  }
}

export class MetricsQueryError extends Error {
  constructor(message) {
    super(message)
    this.name = "MetricsQueryError"
    this.code = "INVALID_METRICS_QUERY"
  }
}

const kindSet = new Set(stepKinds)
const validDay = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value
const dayOf = (timestamp) => {
  const date = new Date(timestamp)
  if (!Number.isSafeInteger(date.getTime())) throw new MetricsQueryError("Invalid metrics clock")
  return date.toISOString().slice(0, 10)
}
const shiftDay = (day, delta) => {
  const date = new Date(`${day}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + delta)
  return date.toISOString().slice(0, 10)
}
const ratio = (value, total) => total > 0 ? Number((value / total).toFixed(4)) : 0
const cacheHitRate = (tokens) => ratio(tokens.cacheRead, tokens.input + tokens.cacheRead + tokens.cacheWrite)
const zeroTokens = () => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
const tokensFrom = (row) => ({
  input: Number(row.input),
  output: Number(row.output),
  reasoning: Number(row.reasoning),
  cacheRead: Number(row.cache_read),
  cacheWrite: Number(row.cache_write),
})
const rowSummary = (row, extra = {}) => {
  const steps = Number(row.steps)
  const tokens = tokensFrom(row)
  const pricedSteps = Number(row.priced_steps)
  return {
    key: row.key || null,
    ...extra,
    steps,
    tokens,
    cost: Number(row.cost),
    pricedSteps,
    costCoverage: ratio(pricedSteps, steps),
    cacheHitRate: cacheHitRate(tokens),
  }
}
const emptyResult = (from, to) => {
  const days = Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000) + 1
  const series = []
  for (let day = from; day <= to; day = shiftDay(day, 1)) {
    series.push({ day, steps: 0, tokens: zeroTokens(), cost: 0, pricedSteps: 0, costCoverage: 0, cacheHitRate: 0 })
    if (series.length >= days) break
  }
  return {
    range: { from, to, days },
    totals: { steps: 0, tokens: zeroTokens(), cost: 0, pricedSteps: 0, costCoverage: 0, cacheHitRate: 0 },
    series,
    byAgent: [],
    byModel: [],
    byProject: [],
    byKind: [],
  }
}
const filterText = (value, name, allowSlash = true) => {
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new MetricsQueryError(`Invalid ${name}`)
  try { return label(value, name === "agent" ? 64 : 128, allowSlash) ?? undefined } catch { throw new MetricsQueryError(`Invalid ${name}`) }
}
const filterProject = (value) => {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) throw new MetricsQueryError("Invalid project")
  return { hash: /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : hash(value), directory: value }
}

export function queryMetrics(filters = {}, { path = metricsPath, now = Date.now } = {}) {
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) throw new MetricsQueryError("Invalid filters")
  const today = dayOf(now())
  const from = filters.from ?? shiftDay(today, -(defaultRangeDays - 1))
  const to = filters.to ?? today
  if (!validDay(from) || !validDay(to)) throw new MetricsQueryError("Invalid date range")
  const fromMs = Date.parse(`${from}T00:00:00.000Z`)
  const toMs = Date.parse(`${to}T00:00:00.000Z`)
  const days = Math.round((toMs - fromMs) / 86_400_000) + 1
  if (days < 1 || days > maxRangeDays) throw new MetricsQueryError("Invalid date range")
  const agent = filterText(filters.agent, "agent", false)
  const provider = filterText(filters.provider, "provider", true)
  const model = filterText(filters.model, "model", true)
  const project = filterProject(filters.project)
  const kind = filters.kind
  if (kind !== undefined && !kindSet.has(kind)) throw new MetricsQueryError("Invalid kind")
  if (!existsSync(path)) return emptyResult(from, to)

  const params = [from, to]
  let where = "WHERE day >= ? AND day <= ?"
  const add = (clause, ...values) => { where += ` AND ${clause}`; params.push(...values) }
  if (agent !== undefined) add("agent = ?", agent)
  if (provider !== undefined) add("provider = ?", provider)
  if (model !== undefined) add("model = ?", model)
  if (project !== undefined) add("(project_hash = ? OR directory = ?)", project.hash, project.directory)
  if (kind !== undefined) add("kind = ?", kind)

  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec("PRAGMA busy_timeout = 5000")
    const total = db.prepare(`SELECT count(*) AS steps,
      coalesce(sum(input_tokens), 0) AS input, coalesce(sum(output_tokens), 0) AS output,
      coalesce(sum(reasoning_tokens), 0) AS reasoning, coalesce(sum(cache_read_tokens), 0) AS cache_read,
      coalesce(sum(cache_write_tokens), 0) AS cache_write, coalesce(sum(cost), 0) AS cost,
      coalesce(sum(priced), 0) AS priced_steps FROM steps ${where}`).get(...params)
    const totalTokens = tokensFrom(total)
    const totals = {
      steps: Number(total.steps),
      tokens: totalTokens,
      cost: Number(total.cost),
      pricedSteps: Number(total.priced_steps),
      costCoverage: ratio(Number(total.priced_steps), Number(total.steps)),
      cacheHitRate: cacheHitRate(totalTokens),
    }
    const daily = new Map(db.prepare(`SELECT day, count(*) AS steps,
      coalesce(sum(input_tokens), 0) AS input, coalesce(sum(output_tokens), 0) AS output,
      coalesce(sum(reasoning_tokens), 0) AS reasoning, coalesce(sum(cache_read_tokens), 0) AS cache_read,
      coalesce(sum(cache_write_tokens), 0) AS cache_write, coalesce(sum(cost), 0) AS cost,
      coalesce(sum(priced), 0) AS priced_steps FROM steps ${where} GROUP BY day ORDER BY day`).all(...params).map((row) => {
      const summary = rowSummary(row)
      delete summary.key
      return [row.day, { day: row.day, ...summary }]
    }))
    const series = []
    for (let day = from; day <= to; day = shiftDay(day, 1)) {
      series.push(daily.get(day) ?? { day, steps: 0, tokens: zeroTokens(), cost: 0, pricedSteps: 0, costCoverage: 0, cacheHitRate: 0 })
      if (series.length >= days) break
    }
    const group = (select, groupBy, extra) => db.prepare(`SELECT ${select}, count(*) AS steps,
      coalesce(sum(input_tokens), 0) AS input, coalesce(sum(output_tokens), 0) AS output,
      coalesce(sum(reasoning_tokens), 0) AS reasoning, coalesce(sum(cache_read_tokens), 0) AS cache_read,
      coalesce(sum(cache_write_tokens), 0) AS cache_write, coalesce(sum(cost), 0) AS cost,
      coalesce(sum(priced), 0) AS priced_steps,
      (coalesce(sum(input_tokens), 0) + coalesce(sum(output_tokens), 0) + coalesce(sum(reasoning_tokens), 0)
        + coalesce(sum(cache_read_tokens), 0) + coalesce(sum(cache_write_tokens), 0)) AS total_tokens
      FROM steps ${where} GROUP BY ${groupBy} ORDER BY total_tokens DESC, steps DESC LIMIT ${topLimit}`)
      .all(...params)
      .map((row) => rowSummary(row, extra?.(row) ?? {}))
    return {
      range: { from, to, days },
      totals,
      series,
      byAgent: group("coalesce(agent, '') AS key", "coalesce(agent, '')"),
      byModel: group("coalesce(model, '') AS key, coalesce(provider, '') AS provider", "coalesce(model, ''), coalesce(provider, '')", (row) => ({ provider: row.provider || null })),
      byProject: group("coalesce(project_hash, '') AS key, max(directory) AS directory", "coalesce(project_hash, '')", (row) => ({ directory: row.directory || null })),
      byKind: group("kind AS key", "kind"),
    }
  } finally {
    db.close()
  }
}
