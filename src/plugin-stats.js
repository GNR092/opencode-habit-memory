import { statSync } from "node:fs"

const hookNames = Object.freeze(["session.prompt", "session.context", "tool.execute.after", "shell.create.before"])
const latencyBuckets = Object.freeze([1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000])
const histogram = () => ({ counts: new Array(latencyBuckets.length).fill(0) })
let startedAt
let hooks
let context
let store
let sse
let requests
let flush
let errors

function reset() {
  startedAt = Date.now()
  hooks = Object.fromEntries(hookNames.map((name) => [name, { invocations: 0, errors: 0, latency: histogram() }]))
  context = { injections: 0, injectedChars: 0, notices: { checkpoint: 0, todo: 0 } }
  store = { reads: 0, writes: 0, bytesRead: 0, bytesWritten: 0, lockWaits: 0, lockTimeouts: 0, errors: 0, writeLatency: histogram() }
  sse = { clients: 0, peakClients: 0, refreshes: 0 }
  requests = { "2xx": 0, "4xx": 0, "5xx": 0 }
  flush = { lastAt: null, pending: 0, failures: 0 }
  errors = { hooks: 0, store: 0, server: 0, collector: 0 }
}
reset()

function observe(histogramValue, durationMs) {
  const value = Number(durationMs)
  if (!Number.isFinite(value) || value < 0) return
  let index = latencyBuckets.findIndex((max) => value <= max)
  if (index === -1) index = latencyBuckets.length - 1
  histogramValue.counts[index]++
}

function percentile(histogramValue, quantile) {
  const samples = histogramValue.counts.reduce((sum, count) => sum + count, 0)
  if (!samples) return null
  const target = Math.ceil(samples * quantile)
  let seen = 0
  for (let index = 0; index < histogramValue.counts.length; index++) {
    seen += histogramValue.counts[index]
    if (seen >= target) return latencyBuckets[index]
  }
  return latencyBuckets.at(-1)
}

function histogramSnapshot(histogramValue) {
  return {
    samples: histogramValue.counts.reduce((sum, count) => sum + count, 0),
    p50: percentile(histogramValue, 0.5),
    p95: percentile(histogramValue, 0.95),
    buckets: histogramValue.counts.map((count, index) => ({ maxMs: index === histogramValue.counts.length - 1 ? null : latencyBuckets[index], count })),
  }
}

function recordHook(name, durationMs, failed) {
  const hook = hooks[name]
  if (!hook) return
  hook.invocations++
  observe(hook.latency, durationMs)
  if (failed) {
    hook.errors++
    errors.hooks++
  }
}

export async function measureHook(name, fn) {
  const started = Date.now()
  try {
    const result = await fn()
    recordHook(name, Date.now() - started, false)
    return result
  } catch (error) {
    recordHook(name, Date.now() - started, true)
    throw error
  }
}

export function recordHookError(name) {
  const hook = hooks[name]
  if (!hook) return
  hook.errors++
  errors.hooks++
}

export function recordContextChars(chars) {
  const value = Number(chars)
  if (!Number.isSafeInteger(value) || value < 0) return
  if (!value) return
  context.injections++
  context.injectedChars += value
}

export function recordNotice(kind) {
  if (kind === "checkpoint" || kind === "todo") context.notices[kind]++
}

export function recordStoreRead(bytes) {
  store.reads++
  const value = Number(bytes)
  if (Number.isSafeInteger(value) && value >= 0) store.bytesRead += value
}

export function recordStoreWrite(bytes, durationMs) {
  store.writes++
  const value = Number(bytes)
  if (Number.isSafeInteger(value) && value >= 0) store.bytesWritten += value
  observe(store.writeLatency, durationMs)
}

export function recordStoreLockWait() {
  store.lockWaits++
}

export function recordStoreLockTimeout() {
  store.lockTimeouts++
  errors.store++
}

export function recordStoreError() {
  store.errors++
  errors.store++
}

export function recordSseClient(delta) {
  sse.clients = Math.max(0, sse.clients + (Number(delta) || 0))
  sse.peakClients = Math.max(sse.peakClients, sse.clients)
}

export function recordSseRefresh() {
  sse.refreshes++
}

export function recordRequestStatus(status) {
  const code = Number(status)
  if (code >= 200 && code < 300) requests["2xx"]++
  else if (code >= 400 && code < 500) requests["4xx"]++
  else if (code >= 500 && code < 600) {
    requests["5xx"]++
    errors.server++
  }
}

export function recordServerError() {
  errors.server++
}

export function recordCollectorPending(pending) {
  const value = Number(pending)
  flush.pending = Number.isSafeInteger(value) && value >= 0 ? value : 0
}

export function recordCollectorFlush(pending, failed) {
  flush.lastAt = Date.now()
  recordCollectorPending(pending)
  if (failed) {
    flush.failures++
    errors.collector++
  }
}

function currentCounts(storeData) {
  if (!storeData || typeof storeData !== "object") return null
  const checkpoints = Array.isArray(storeData.checkpoints) ? storeData.checkpoints : []
  const todos = Array.isArray(storeData.todos) ? storeData.todos : []
  return {
    checkpoints: checkpoints.length,
    todos: todos.length,
    activeTodos: todos.filter((todo) => todo?.status === "pending").length,
    scopes: new Set(checkpoints.map((checkpoint) => `${checkpoint?.project}\u0000${checkpoint?.context}`)).size,
  }
}

function fileSize(path) {
  try { return statSync(path).size } catch { return null }
}

export function storeStats() {
  return {
    reads: store.reads,
    writes: store.writes,
    bytesRead: store.bytesRead,
    bytesWritten: store.bytesWritten,
    lockWaits: store.lockWaits,
    lockTimeouts: store.lockTimeouts,
    errors: store.errors,
    writeLatency: histogramSnapshot(store.writeLatency),
  }
}

export function pluginSnapshot({ storeData, storePath, metricsPath } = {}) {
  return {
    startedAt: new Date(startedAt).toISOString(),
    uptimeMs: Math.max(0, Date.now() - startedAt),
    hooks: Object.fromEntries(Object.entries(hooks).map(([name, hook]) => [name, {
      invocations: hook.invocations,
      errors: hook.errors,
      latency: histogramSnapshot(hook.latency),
    }])),
    context: { injections: context.injections, injectedChars: context.injectedChars, notices: { ...context.notices } },
    store: storeStats(),
    sse: { clients: sse.clients, peakClients: sse.peakClients, refreshes: sse.refreshes },
    requests: { ...requests },
    flush: { ...flush },
    errors: { ...errors },
    current: currentCounts(storeData),
    bytes: { store: fileSize(storePath), metrics: fileSize(metricsPath) },
  }
}

export function resetPluginStats() {
  reset()
}

export { hookNames }
