import assert from "node:assert/strict"
import test, { after, beforeEach } from "node:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

const previousDataHome = process.env.XDG_DATA_HOME
const testDataHome = await mkdtemp(join(tmpdir(), "habit-memory-metrics-api-"))
process.env.XDG_DATA_HOME = testDataHome
const { createMetricsStore, createMetricsCollector, backfillMetrics, queryMetrics, metricsPath } = await import("../src/metrics.js")
const { createUiServer } = await import("../src/ui-server.js")
const { resetPluginStats } = await import("../src/plugin-stats.js")

const sha = (value) => createHash("sha256").update(value).digest("hex")
const session = (overrides = {}) => ({
  id: "ses_raw_1",
  projectID: "project-raw",
  agent: "03-fix",
  model: { id: "deepseek-v4.1-flash", providerID: "opencode-go", variant: "max" },
  location: { directory: "/home/gener/secret-project" },
  cost: 0.5,
  tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 300, write: 10 } },
  time: { created: Date.UTC(2026, 10, 10, 12), updated: Date.UTC(2026, 10, 10, 12) },
  ...overrides,
})
const stepEvent = ({ data = {}, ...rest } = {}) => ({
  type: "session.step.ended",
  id: "evt-step-1",
  created: Date.UTC(2026, 10, 10, 12),
  data: {
    sessionID: "ses_raw_1",
    assistantMessageID: "msg_raw_1",
    finish: "stop",
    cost: 0.5,
    tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 300, write: 10 } },
    ...data,
  },
  ...rest,
})
const usageEvent = ({ data = {}, ...rest } = {}) => ({
  type: "session.usage.recorded",
  id: "evt-usage-1",
  created: Date.UTC(2026, 10, 11, 13),
  data: {
    sessionID: "ses_raw_1",
    source: "title",
    cost: 0.01,
    tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 5, write: 0 } },
    ...data,
  },
  ...rest,
})
const rows = (sql, ...params) => {
  const db = new DatabaseSync(metricsPath, { readOnly: true })
  try { return db.prepare(sql).all(...params) } finally { db.close() }
}
const waitFor = async (predicate) => {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("timed out waiting for metrics")
}
const seed = (store) => {
  const s1 = session({ id: "ses_raw_1" })
  const s2 = session({
    id: "ses_raw_2",
    parentID: "ses_parent",
    projectID: "project-2",
    agent: "04-test",
    model: { id: "other-model", providerID: "other-provider", variant: "low" },
    location: { directory: "/home/gener/other-project" },
    cost: 0,
    tokens: { input: 50, output: 10, reasoning: 0, cache: { read: 100, write: 0 } },
  })
  store.ingestEvents([
    stepEvent({ id: "evt_step_1", created: Date.UTC(2026, 10, 10, 12), data: { sessionID: "ses_raw_1", assistantMessageID: "msg_raw_1" } }),
    stepEvent({
      id: "evt_step_2",
      created: Date.UTC(2026, 10, 11, 12),
      data: {
        sessionID: "ses_raw_2",
        assistantMessageID: "msg_raw_2",
        cost: 0,
        tokens: { input: 50, output: 10, reasoning: 0, cache: { read: 100, write: 0 } },
      },
    }),
    usageEvent({ id: "evt_usage_1", created: Date.UTC(2026, 10, 11, 13), data: { sessionID: "ses_raw_1", source: "title", cost: 0.01 } }),
  ], { sessions: new Map([["ses_raw_1", s1], ["ses_raw_2", s2]]) })
}
const withServer = async (fn) => {
  const server = createUiServer()
  await new Promise((resolve) => server.once("listening", resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  try { await fn(origin, server) } finally { await new Promise((resolve) => server.close(resolve)) }
}

beforeEach(async () => {
  await rm(metricsPath, { force: true })
  await rm(`${metricsPath}-wal`, { force: true })
  await rm(`${metricsPath}-shm`, { force: true })
})
after(async () => {
  if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = previousDataHome
  await rm(testDataHome, { recursive: true, force: true })
})

test("GET /api/metrics returns totals, daily series and dimensions", async () => {
  const store = createMetricsStore()
  try { seed(store) } finally { store.close() }
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/api/metrics?from=2026-11-10&to=2026-11-11`)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(body.range, { from: "2026-11-10", to: "2026-11-11", days: 2 })
    assert.equal(body.totals.steps, 3)
    assert.deepEqual(body.totals.tokens, { input: 160, output: 32, reasoning: 5, cacheRead: 405, cacheWrite: 10 })
    assert.equal(body.totals.cost, 0.51)
    assert.equal(body.totals.pricedSteps, 2)
    assert.equal(body.totals.costCoverage, 0.6667)
    assert.equal(body.totals.cacheHitRate, 0.7043)
    assert.equal("total" in body.totals.tokens, false)
    assert.equal(body.series.length, 2)
    assert.equal(body.series[0].day, "2026-11-10")
    assert.equal(body.series[0].steps, 1)
    assert.equal("key" in body.series[0], false)
    assert.deepEqual(body.series[0].tokens, { input: 100, output: 20, reasoning: 5, cacheRead: 300, cacheWrite: 10 })
    assert.equal(body.series[1].day, "2026-11-11")
    assert.equal(body.series[1].steps, 2)
    assert.equal(body.byAgent[0].key, "03-fix")
    assert.equal(body.byAgent[0].steps, 2)
    assert.equal(body.byModel[0].key, "deepseek-v4.1-flash")
    assert.equal(body.byModel[0].provider, "opencode-go")
    assert.equal(body.byProject[0].key, sha("project-raw"))
    assert.equal(body.byProject[0].directory, "secret-project")
    assert.deepEqual(body.byKind.map((row) => row.key).sort(), ["primary", "subagent", "title"])
  })
})

test("GET /api/metrics applies filters and rejects invalid ranges", async () => {
  const store = createMetricsStore()
  try { seed(store) } finally { store.close() }
  await withServer(async (origin, server) => {
    const get = async (query) => {
      const response = await fetch(`${origin}/api/metrics?${query}`)
      return { status: response.status, body: await response.json() }
    }
    assert.equal((await get("from=2026-11-10&to=2026-11-11&agent=04-test")).body.totals.steps, 1)
    assert.equal((await get("from=2026-11-10&to=2026-11-11&project=secret-project")).body.totals.steps, 2)
    assert.equal((await get(`from=2026-11-10&to=2026-11-11&project=${sha("project-raw")}`)).body.totals.steps, 2)
    assert.equal((await get("from=2026-11-10&to=2026-11-11&kind=title")).body.totals.steps, 1)
    assert.equal((await get("from=2026-11-10&to=2026-11-11&model=other-model&provider=other-provider")).body.totals.steps, 1)
    assert.equal((await get("from=2026-02-30")).status, 400)
    assert.equal((await get("from=2026-01-01&to=2026-06-01")).status, 400)
    assert.equal((await get("from=2026-11-12&to=2026-11-11")).status, 400)
    assert.equal((await get("from=2026-11-10&to=2026-11-11&agent=../evil")).status, 400)
    assert.equal((await get("from=2026-11-10&to=2026-11-11&kind=bogus")).status, 400)
    assert.equal((await fetch(`${origin}/api/metrics/nope`)).status, 404)
    assert.equal((await fetch(`${origin}/api/metrics`, { method: "POST" })).status, 404)
    const wrongHost = await new Promise((resolve, reject) => {
      const port = server.address().port
      const request = httpRequest({ host: "127.0.0.1", port, path: "/api/metrics", headers: { host: `evil.invalid:${port}` } }, (response) => { response.resume(); resolve(response) })
      request.once("error", reject)
      request.end()
    })
    assert.equal(wrongHost.statusCode, 403)
  })
})

test("GET /api/metrics returns an empty 30-day range without a database", async () => {
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/api/metrics`)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.range.days, 30)
    assert.equal(body.totals.steps, 0)
    assert.equal(body.series.length, 30)
    assert.deepEqual(body.byAgent, [])
  })
})

test("GET /api/metrics returns 500 for an unreadable database", async () => {
  await writeFile(metricsPath, "not a database")
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/api/metrics`)
    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), { error: "Unable to read metrics" })
  })
})

test("collector flushes batches, deduplicates and flushes on end", async () => {
  const store = createMetricsStore()
  try {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const collector = createMetricsCollector({
      store,
      subscribe: async function* () {
        yield stepEvent({ id: "evt_c1", data: { assistantMessageID: "msg_c1" } })
        yield stepEvent({ id: "evt_c2", data: { assistantMessageID: "msg_c2" } })
        await gate
      },
      getSession: async (id) => session({ id }),
      flushInterval: 60_000,
      flushSize: 2,
    })
    await waitFor(() => rows("SELECT * FROM steps").length === 2)
    release()
    await collector.stop()
    assert.equal(rows("SELECT * FROM steps").length, 2)

    const final = createMetricsCollector({
      store,
      subscribe: async function* () {
        yield stepEvent({ id: "evt_c3", data: { assistantMessageID: "msg_c3" } })
        yield stepEvent({ id: "evt_c1", data: { assistantMessageID: "msg_c1" } })
      },
      getSession: async (id) => session({ id }),
      flushInterval: 60_000,
    })
    await final.done
    assert.equal(rows("SELECT * FROM steps").length, 3)
  } finally {
    store.close()
  }
})

test("backfill is approximate, skips live sessions and is idempotent", async () => {
  const store = createMetricsStore()
  try {
    const first = session({ id: "ses_back_1", time: { created: Date.UTC(2026, 9, 1), updated: Date.UTC(2026, 10, 10) } })
    const second = session({ id: "ses_back_2", parentID: "ses_parent", time: { created: Date.UTC(2026, 9, 2), updated: Date.UTC(2026, 10, 11) } })
    const old = session({ id: "ses_back_old", time: { created: Date.UTC(2026, 6, 1), updated: Date.UTC(2026, 6, 1) } })
    let calls = 0
    const listSessions = async () => {
      calls++
      if (calls > 1) return { data: [], cursor: {} }
      return { data: [first, second, old], cursor: { next: "next" } }
    }
    const result = await backfillMetrics({ store, listSessions, now: () => Date.UTC(2026, 10, 11), limit: 10 })
    assert.deepEqual(result, { skipped: false, inserted: 2, seen: 3 })
    const stored = rows("SELECT * FROM steps ORDER BY id")
    assert.equal(stored.length, 2)
    assert.equal(stored[0].source, "backfill")
    assert.equal(stored[0].message_hash, sha("session:ses_back_1"))
    assert.equal(stored[0].kind, "primary")
    assert.equal(stored[0].day, "2026-11-10")
    assert.equal(stored[1].kind, "subagent")
    assert.equal(store.getMeta("source.backfillAt"), new Date(Date.UTC(2026, 10, 11)).toISOString())
    const again = await backfillMetrics({ store, listSessions, now: () => Date.UTC(2026, 10, 11), limit: 10 })
    assert.deepEqual(again, { skipped: true, inserted: 0, seen: 0 })
    assert.equal(rows("SELECT * FROM steps").length, 2)
  } finally {
    store.close()
  }
})

test("backfill does not duplicate a session already covered by live events", async () => {
  const store = createMetricsStore()
  try {
    store.ingestEvent(stepEvent({ data: { sessionID: "ses_live", assistantMessageID: "msg_live" } }), { session: session({ id: "ses_live" }) })
    const live = session({ id: "ses_live" })
    const other = session({ id: "ses_other" })
    const result = await backfillMetrics({ store, listSessions: async () => ({ data: [live, other], cursor: {} }), now: () => Date.UTC(2026, 10, 11), limit: 10 })
    assert.deepEqual(result, { skipped: false, inserted: 1, seen: 2 })
    const stored = rows("SELECT session_hash, source FROM steps ORDER BY id")
    assert.equal(stored.length, 2)
    assert.equal(stored.some((row) => row.session_hash === sha("ses_live") && row.source === "backfill"), false)
    assert.equal(stored.some((row) => row.session_hash === sha("ses_other") && row.source === "backfill"), true)
  } finally {
    store.close()
  }
})

test("GET /api/metrics includes a bounded plugin health block without content", async () => {
  resetPluginStats()
  const store = createMetricsStore()
  try { seed(store) } finally { store.close() }
  await withServer(async (origin) => {
    assert.equal((await fetch(`${origin}/api/data`)).status, 200)
    const response = await fetch(`${origin}/api/metrics?from=2026-11-10&to=2026-11-11`)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(typeof body.plugin, "object")
    assert.ok(Number.isFinite(Date.parse(body.plugin.startedAt)))
    assert.ok(body.plugin.uptimeMs >= 0)
    assert.deepEqual(Object.keys(body.plugin.hooks).sort(), ["session.context", "session.prompt", "shell.create.before", "tool.execute.after"])
    assert.equal(body.plugin.hooks["session.prompt"].latency.buckets.length, 10)
    assert.equal(body.plugin.hooks["session.prompt"].latency.buckets.at(-1).maxMs, null)
    assert.ok(body.plugin.store.reads >= 2)
    assert.ok(body.plugin.store.bytesRead >= 0)
    assert.ok(body.plugin.store.writeLatency.buckets.length === 10)
    assert.ok(body.plugin.requests["2xx"] >= 1)
    assert.equal(typeof body.plugin.requests["4xx"], "number")
    assert.equal(typeof body.plugin.requests["5xx"], "number")
    assert.equal(typeof body.plugin.sse.clients, "number")
    assert.equal(typeof body.plugin.sse.peakClients, "number")
    assert.equal(typeof body.plugin.sse.refreshes, "number")
    assert.equal(typeof body.plugin.flush.pending, "number")
    assert.equal(typeof body.plugin.flush.failures, "number")
    assert.equal(typeof body.plugin.context.injectedChars, "number")
    assert.equal(typeof body.plugin.errors.hooks, "number")
    assert.deepEqual(body.plugin.current, { checkpoints: 0, todos: 0, activeTodos: 0, scopes: 0 })
    assert.equal(body.plugin.bytes.store, null)
    assert.ok(body.plugin.bytes.metrics > 0)
    const serialized = JSON.stringify(body.plugin)
    for (const secret of ["ses_raw", "msg_raw", "secret-project", "PROMPT_SECRET", "/home/gener"]) assert.equal(serialized.includes(secret), false)
  })
})

test("metrics database writes wake the existing SSE refresh", async () => {
  const server = createUiServer()
  await new Promise((resolve) => server.once("listening", resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3000)
  timeout.unref?.()
  try {
    const response = await fetch(`${origin}/api/events`, { signal: controller.signal })
    assert.equal(response.status, 200)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let body = ""
    const read = async () => {
      const { value, done } = await reader.read()
      if (!done) body += decoder.decode(value, { stream: true })
      return !done
    }
    assert.equal(await read(), true)
    assert.match(body, /: connected/)
    const store = createMetricsStore()
    try {
      store.ingestEvent(stepEvent({ data: { assistantMessageID: "msg_sse" } }), { session: session() })
    } finally {
      store.close()
    }
    while (!body.includes("data: refresh") && await read()) {}
    assert.match(body, /data: refresh/)
  } finally {
    clearTimeout(timeout)
    controller.abort()
    await new Promise((resolve) => server.close(resolve))
  }
})

test("queryMetrics can be called directly with the same filters while the writer is open", () => {
  const store = createMetricsStore()
  try {
    seed(store)
    const result = queryMetrics({ from: "2026-11-10", to: "2026-11-11", kind: "primary" }, { now: () => Date.UTC(2026, 10, 11) })
    assert.equal(result.totals.steps, 1)
    assert.equal(result.totals.tokens.input, 100)
    assert.equal(result.byKind.length, 1)
  } finally {
    store.close()
  }
})
