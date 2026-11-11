import assert from "node:assert/strict"
import test, { after, beforeEach } from "node:test"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

const previousDataHome = process.env.XDG_DATA_HOME
const testDataHome = await mkdtemp(join(tmpdir(), "habit-memory-metrics-"))
process.env.XDG_DATA_HOME = testDataHome
const { createMetricsStore, metricsPath, normalizeEvent } = await import("../src/metrics.js")

const sha = (value) => createHash("sha256").update(value).digest("hex")
const session = (overrides = {}) => ({
  projectID: "project-raw",
  agent: "03-fix",
  model: { id: "deepseek-v4.1-flash", providerID: "opencode-go", variant: "max" },
  location: { directory: "/home/gener/secret-project" },
  ...overrides,
})
const stepEvent = ({ data = {}, ...rest } = {}) => ({
  type: "session.step.ended",
  id: "evt-step-1",
  created: Date.UTC(2026, 10, 11, 12),
  data: {
    sessionID: "ses_raw_step_1",
    assistantMessageID: "msg_raw_step_1",
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
  created: Date.UTC(2026, 10, 11, 12),
  data: {
    sessionID: "ses_usage_1",
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

test("creates metrics.db with 0600, WAL and strict validation", async () => {
  const store = createMetricsStore()
  try {
    assert.equal(store.path, metricsPath)
    assert.equal(existsSync(metricsPath), true)
    assert.equal((await stat(metricsPath)).mode & 0o777, 0o600)
    assert.equal(rows("PRAGMA journal_mode")[0].journal_mode, "wal")
    const info = rows("PRAGMA table_info(steps)").map((column) => column.name)
    for (const column of ["day", "message_hash", "session_hash", "parent_hash", "project_hash", "directory", "agent", "provider", "model", "variant", "kind", "input_tokens", "cache_read_tokens", "cost", "priced"]) assert.equal(info.includes(column), true)

    const row = normalizeEvent(stepEvent(), { session: session() })
    assert.equal(row.day, "2026-11-11")
    assert.equal(row.kind, "primary")
    assert.equal(row.input_tokens, 100)
    assert.equal(row.output_tokens, 20)
    assert.equal(row.reasoning_tokens, 5)
    assert.equal(row.cache_read_tokens, 300)
    assert.equal(row.cache_write_tokens, 10)
    assert.equal(row.cost, 0.5)
    assert.equal(row.priced, 1)
    assert.equal(row.directory, "secret-project")
    assert.equal(row.agent, "03-fix")
    assert.equal(row.provider, "opencode-go")
    assert.equal(row.model, "deepseek-v4.1-flash")
    assert.equal(row.variant, "max")
    assert.equal(row.session_hash, sha("ses_raw_step_1"))
    assert.equal(row.message_hash, sha("message:msg_raw_step_1"))
    assert.equal(JSON.stringify(row).includes("ses_raw_step_1"), false)
    assert.equal(JSON.stringify(row).includes("msg_raw_step_1"), false)

    for (const bad of [-1, 1.5, NaN, "5"]) assert.throws(() => normalizeEvent(stepEvent({ data: { tokens: { input: bad } } }), { session: session() }))
    assert.throws(() => normalizeEvent(stepEvent({ data: { cost: -1 } }), { session: session() }))
    assert.throws(() => normalizeEvent(stepEvent({ data: { sessionID: "" } }), { session: session() }))
    assert.throws(() => normalizeEvent(stepEvent({ data: { assistantMessageID: 42 } }), { session: session() }))
    assert.equal(normalizeEvent({ type: "session.message.content.updated", data: {} }), undefined)
  } finally {
    store.close()
  }
})

test("deduplicates by assistant message hash", async () => {
  const store = createMetricsStore()
  try {
    assert.equal(store.ingestEvent(stepEvent(), { session: session() }), 1)
    assert.equal(store.ingestEvent(stepEvent(), { session: session() }), 0)
    const stored = rows("SELECT * FROM steps")
    assert.equal(stored.length, 1)
    assert.equal(stored[0].input_tokens, 100)
    assert.equal(stored[0].cache_read_tokens, 300)
    assert.equal(store.ingestEvent(stepEvent({ data: { assistantMessageID: "msg_raw_step_2" } }), { session: session() }), 1)
    assert.equal(rows("SELECT * FROM steps").length, 2)
  } finally {
    store.close()
  }
})

test("prunes steps older than 90 UTC days", async () => {
  const now = Date.UTC(2026, 10, 11, 12)
  const store = createMetricsStore({ now: () => now })
  try {
    const old = stepEvent({ id: "evt-old", created: now - 90 * 86_400_000, data: { sessionID: "ses-old", assistantMessageID: "msg-old" } })
    const recent = stepEvent({ id: "evt-recent", created: now - 89 * 86_400_000, data: { sessionID: "ses-recent", assistantMessageID: "msg-recent" } })
    assert.equal(store.ingestEvents([old, recent]), 2)
    const stored = rows("SELECT session_hash FROM steps")
    assert.deepEqual(stored.map((row) => row.session_hash), [sha("ses-recent")])
    assert.equal(store.prune(), 0)
  } finally {
    store.close()
  }
})

test("stores only hashes, basenames and allowlisted dimensions", async () => {
  const store = createMetricsStore()
  try {
    const sessionID = "ses_super_secret_identifier"
    const messageID = "msg_super_secret_identifier"
    const event = stepEvent({
      data: {
        sessionID,
        assistantMessageID: messageID,
        prompt: "PROMPT_SECRET",
        arguments: "/home/gener/secret/file.txt",
        content: "TRANSCRIPT_SECRET",
      },
    })
    assert.equal(store.ingestEvent(event, { session: session() }), 1)
    const [row] = rows("SELECT * FROM steps")
    const serialized = JSON.stringify(row)
    for (const secret of [sessionID, messageID, "PROMPT_SECRET", "TRANSCRIPT_SECRET", "/home/gener", "secret/file.txt"]) assert.equal(serialized.includes(secret), false)
    assert.equal(row.directory, "secret-project")
    assert.equal(row.session_hash, sha(sessionID))
    assert.equal(row.message_hash, sha(`message:${messageID}`))
    assert.equal(row.parent_hash, null)
    assert.equal(row.project_hash, sha("project-raw"))
  } finally {
    store.close()
  }
})

test("classifies usage.recorded and deduplicates by event id", async () => {
  const store = createMetricsStore()
  try {
    assert.equal(store.ingestEvent(usageEvent(), { session: session() }), 1)
    assert.equal(store.ingestEvent(usageEvent(), { session: session() }), 0)
    assert.equal(store.ingestEvent(usageEvent({ id: "evt-usage-2", data: { source: "compaction" } }), { session: session() }), 1)
    assert.equal(store.ingestEvent(usageEvent({ id: "evt-usage-3", data: { source: "generate" } }), { session: session({ parentID: "ses-parent" }) }), 1)
    assert.deepEqual(rows("SELECT kind FROM steps ORDER BY id").map((row) => row.kind), ["title", "compaction", "generate"])
    const [title] = rows("SELECT message_hash, parent_hash FROM steps ORDER BY id LIMIT 1")
    assert.equal(title.message_hash, sha("event:evt-usage-1"))
    assert.equal(title.parent_hash, null)
  } finally {
    store.close()
  }
})

test("rebuilds monthly aggregates for F2", async () => {
  const store = createMetricsStore()
  try {
    const events = [
      stepEvent({ id: "e1", created: Date.UTC(2026, 9, 1), data: { sessionID: "ses-1", assistantMessageID: "msg-1" } }),
      stepEvent({ id: "e2", created: Date.UTC(2026, 9, 2), data: { sessionID: "ses-2", assistantMessageID: "msg-2" } }),
      stepEvent({ id: "e3", created: Date.UTC(2026, 10, 1), data: { sessionID: "ses-3", assistantMessageID: "msg-3" } }),
    ]
    const sessions = new Map(events.map((event) => [event.data.sessionID, session({ parentID: "ses-parent" })]))
    assert.equal(store.ingestEvents(events, { sessions }), 3)
    store.rebuildMonthly()
    const monthly = rows("SELECT * FROM monthly ORDER BY month")
    assert.equal(monthly.length, 2)
    assert.equal(monthly[0].month, "2026-10")
    assert.equal(monthly[0].steps, 2)
    assert.equal(monthly[0].input_tokens, 200)
    assert.equal(monthly[0].kind, "subagent")
    assert.equal(rows("SELECT parent_hash FROM steps LIMIT 1")[0].parent_hash, sha("ses-parent"))
    assert.equal(monthly[1].month, "2026-11")
    assert.equal(monthly[1].steps, 1)
  } finally {
    store.close()
  }
})
