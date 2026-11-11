import assert from "node:assert/strict"
import test, { beforeEach } from "node:test"
import { join } from "node:path"
import {
  measureHook,
  pluginSnapshot,
  recordCollectorFlush,
  recordCollectorPending,
  recordContextChars,
  recordHookError,
  recordNotice,
  recordRequestStatus,
  recordServerError,
  recordSseClient,
  recordSseRefresh,
  recordStoreError,
  recordStoreLockTimeout,
  recordStoreLockWait,
  recordStoreRead,
  recordStoreWrite,
  resetPluginStats,
  storeStats,
} from "../src/plugin-stats.js"

beforeEach(() => resetPluginStats())

test("hook counters keep fixed buckets and approximate percentiles", async () => {
  await measureHook("session.prompt", async () => {})
  await assert.rejects(measureHook("session.context", async () => { throw new Error("boom") }))
  recordHookError("tool.execute.after")
  const snapshot = pluginSnapshot()
  assert.deepEqual(Object.keys(snapshot.hooks).sort(), ["session.context", "session.prompt", "shell.create.before", "tool.execute.after"])
  assert.equal(snapshot.hooks["session.prompt"].invocations, 1)
  assert.equal(snapshot.hooks["session.prompt"].errors, 0)
  assert.equal(snapshot.hooks["session.context"].invocations, 1)
  assert.equal(snapshot.hooks["session.context"].errors, 1)
  assert.equal(snapshot.hooks["tool.execute.after"].invocations, 0)
  assert.equal(snapshot.hooks["tool.execute.after"].errors, 1)
  assert.equal(snapshot.errors.hooks, 2)
  const latency = snapshot.hooks["session.prompt"].latency
  assert.equal(latency.samples, 1)
  assert.equal(latency.buckets.length, 10)
  assert.equal(latency.buckets.at(-1).maxMs, null)
  assert.ok(latency.p50 === null || Number.isFinite(latency.p50))
  assert.ok(latency.p95 === null || Number.isFinite(latency.p95))
  recordHookError("not-a-hook")
  assert.equal(Object.keys(pluginSnapshot().hooks).length, 4)
})

test("store counters sum bytes and write latency without persisting", () => {
  recordStoreRead(100)
  recordStoreRead(0)
  recordStoreWrite(50, 7)
  recordStoreLockWait()
  recordStoreLockTimeout()
  recordStoreError()
  const snapshot = storeStats()
  assert.equal(snapshot.reads, 2)
  assert.equal(snapshot.bytesRead, 100)
  assert.equal(snapshot.writes, 1)
  assert.equal(snapshot.bytesWritten, 50)
  assert.equal(snapshot.lockWaits, 1)
  assert.equal(snapshot.lockTimeouts, 1)
  assert.equal(snapshot.errors, 1)
  assert.equal(snapshot.writeLatency.samples, 1)
  assert.equal(snapshot.writeLatency.p50, 10)
  assert.equal(snapshot.writeLatency.p95, 10)
  assert.equal(pluginSnapshot().errors.store, 2)
})

test("context, notices, SSE, requests and flush counters stay in memory", () => {
  recordContextChars(10)
  recordContextChars(5)
  recordContextChars(-1)
  recordNotice("checkpoint")
  recordNotice("todo")
  recordSseClient(1)
  recordSseClient(1)
  recordSseClient(-1)
  recordSseRefresh()
  recordRequestStatus(200)
  recordRequestStatus(404)
  recordRequestStatus(500)
  recordServerError()
  recordCollectorPending(3)
  recordCollectorFlush(0, false)
  recordCollectorFlush(2, true)
  const snapshot = pluginSnapshot()
  assert.deepEqual(snapshot.context, { injections: 2, injectedChars: 15, notices: { checkpoint: 1, todo: 1 } })
  assert.deepEqual(snapshot.sse, { clients: 1, peakClients: 2, refreshes: 1 })
  assert.deepEqual(snapshot.requests, { "2xx": 1, "4xx": 1, "5xx": 1 })
  assert.equal(snapshot.errors.server, 2)
  assert.equal(snapshot.flush.pending, 2)
  assert.equal(snapshot.flush.failures, 1)
  assert.equal(snapshot.errors.collector, 1)
  assert.equal(typeof snapshot.flush.lastAt, "number")
})

test("plugin snapshot exposes counts and sizes but no store content", () => {
  const snapshot = pluginSnapshot({
    storeData: {
      checkpoints: [{ project: "secret-project", context: "secret-context" }],
      todos: [{ status: "pending", task: "secret-task" }],
    },
    storePath: join(process.cwd(), "package.json"),
    metricsPath: join(process.cwd(), "missing-metrics.db"),
  })
  assert.deepEqual(snapshot.current, { checkpoints: 1, todos: 1, activeTodos: 1, scopes: 1 })
  assert.equal(typeof snapshot.bytes.store, "number")
  assert.equal(snapshot.bytes.metrics, null)
  const serialized = JSON.stringify(snapshot)
  for (const secret of ["secret-project", "secret-context", "secret-task", "ses_", "msg_", "/home/"]) assert.equal(serialized.includes(secret), false)
  assert.ok(Number.isFinite(Date.parse(snapshot.startedAt)))
  assert.ok(snapshot.uptimeMs >= 0)
})
