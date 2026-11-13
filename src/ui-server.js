import { randomBytes, timingSafeEqual } from "node:crypto"
import { lstatSync, mkdirSync, watch } from "node:fs"
import { mkdir, readFile, writeFile, lstat, unlink, rename, rmdir } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"
import { createServer, request as httpRequest } from "node:http"
import { clearCheckpoints, clearHabits, deleteCheckpoint, getData, storePath, updateCheckpoint } from "./store.js"
import { metricsPath, queryMetrics } from "./metrics.js"
import { pluginSnapshot, recordRequestStatus, recordServerError, recordSseClient, recordSseRefresh } from "./plugin-stats.js"
import { errorLogPath, logCommandError, readRecentErrors } from "./error-log.js"

const maxBody = 8192
const distPath = join(fileURLToPath(new URL("../dist/", import.meta.url)))
const controlPath = "/__habit_memory_control"
export function createUiServer({ port = 0 } = {}) {
  const token = randomBytes(32).toString("hex")
  const clients = new Set()
  let watcher, errorLogWatcher, refreshTimer
  const server = createServer(async (req, res) => {
    const host = req.headers.host
    if (![ `127.0.0.1:${server.address()?.port}`, `localhost:${server.address()?.port}` ].includes(host)) { recordRequestStatus(403); res.writeHead(403).end("Forbidden"); return }
    const method = req.method || "GET", url = new URL(req.url || "/", `http://${host}`)
    if (url.pathname === controlPath) {
      const supplied = req.headers["x-habit-token"]
      const authorized = ["GET", "POST"].includes(method) && req.headers.origin === `http://${host}` && typeof supplied === "string" && Buffer.byteLength(supplied) === Buffer.byteLength(token) && timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
      if (!authorized) { recordRequestStatus(403); res.writeHead(403).end(); return }
      recordRequestStatus(200)
      if (method === "GET") { res.writeHead(200, { "cache-control": "no-store" }).end("active"); return }
      res.writeHead(200, { "cache-control": "no-store" }).end("stopping")
      setImmediate(() => { server.closeStreams(); server.close() })
      return
    }
    const securityHeaders = { "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'", "referrer-policy": "no-referrer" }
    const send = (status, payload, type = "application/json; charset=utf-8") => { recordRequestStatus(status); res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...securityHeaders }); res.end(payload) }
    if (method === "GET" && url.pathname === "/") {
      try { const html = (await readFile(join(distPath, "index.html"), "utf8")).replace("<head>", `<head><meta name="habit-token" content="${token}">`); send(200, html, "text/html; charset=utf-8") }
      catch { send(503, "WebUI assets are missing (dist/index.html was not found). Run `npm run build` from the plugin directory to generate `dist/`.", "text/plain; charset=utf-8") }
      return
    }
    const asset = /^\/assets\/(index-[a-zA-Z0-9_-]+\.(?:js|css))$/.exec(url.pathname)
    if (method === "GET" && asset) {
      try { const file = asset[1], type = file.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8"; send(200, await readFile(join(distPath, "assets", file)), type) }
      catch { send(404, "Not found", "text/plain; charset=utf-8") }
      return
    }
    if (method === "GET" && url.pathname === "/api/data") {
      try { const data = await getData(); send(200, JSON.stringify({ habits: data.habits, checkpoints: data.checkpoints, todos: data.todos })) }
      catch { send(500, JSON.stringify({ error: "Unable to read local memory" })) }
      return
    }
    if (method === "GET" && url.pathname === "/api/metrics") {
      try {
        const filters = {}
        for (const key of ["from", "to", "project", "agent", "provider", "model", "kind"]) {
          const value = url.searchParams.get(key)
          if (value !== null && value !== "") filters[key] = value
        }
        let storeData
        try { storeData = await getData() } catch {}
        const result = queryMetrics(filters)
        result.plugin = pluginSnapshot({ storeData, storePath, metricsPath })
        send(200, JSON.stringify(result))
      } catch (error) {
        const invalid = error?.code === "INVALID_METRICS_QUERY"
        send(invalid ? 400 : 500, JSON.stringify({ error: invalid ? "Invalid metrics query" : "Unable to read metrics" }))
      }
      return
    }
    if (method === "GET" && url.pathname === "/api/errors") {
      try { send(200, JSON.stringify({ errors: readRecentErrors() })) }
      catch { send(500, JSON.stringify({ error: "Unable to read recent errors" })) }
      return
    }
    if (method === "GET" && url.pathname === "/api/events") {
      recordRequestStatus(200)
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", ...securityHeaders })
      res.write(": connected\n\n")
      clients.add(res)
      recordSseClient(1)
      const heartbeat = setInterval(() => {
        if (res.writableEnded) return
        try { res.write(": ping\n\n") } catch { res.end() }
      }, 30_000)
      heartbeat.unref?.()
      res.on("close", () => { clearInterval(heartbeat); if (clients.delete(res)) recordSseClient(-1) })
      return
    }
    if (method !== "POST" || !["/api/checkpoint/edit", "/api/checkpoint/delete", "/api/scope/delete", "/api/habits/clear"].includes(url.pathname)) { send(404, JSON.stringify({ error: "Not found" })); return }
    const origin = req.headers.origin
    if (origin !== `http://${host}` || req.headers["x-habit-token"] !== token) { send(403, JSON.stringify({ error: "Forbidden" })); return }
    let raw = ""
    try {
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) throw new Error()
      for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > maxBody) { send(413, JSON.stringify({ error: "Request too large" })); return } }
      const body = JSON.parse(raw)
      const clearingHabits = url.pathname === "/api/habits/clear", editing = url.pathname === "/api/checkpoint/edit", deleting = url.pathname === "/api/checkpoint/delete"
      const fields = clearingHabits ? ["confirm"] : editing ? ["project", "context", "id", "summary"] : deleting ? ["project", "context", "id"] : ["project", "context"]
      if (!body || Array.isArray(body) || Object.keys(body).length !== fields.length || Object.keys(body).some((key) => !fields.includes(key))) throw new Error()
      if (clearingHabits) {
        if (body.confirm !== true) throw new Error()
        await clearHabits()
        send(200, JSON.stringify({ changed: true }))
        return
      }
      const changed = editing ? await updateCheckpoint(body.project, body.context, body.id, body.summary) : deleting ? await deleteCheckpoint(body.project, body.context, body.id) : await clearCheckpoints(body.project, body.context)
      send(changed ? 200 : 404, JSON.stringify({ changed }))
    } catch { send(400, JSON.stringify({ error: "Invalid request" })) }
  })
  server.on("clientError", (_error, socket) => { recordRequestStatus(400); socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n") })
  const notifyRefresh = () => {
    if (refreshTimer) return
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      if (clients.size) recordSseRefresh()
      for (const client of clients) {
        if (client.writableEnded) { if (clients.delete(client)) recordSseClient(-1); continue }
        try { client.write("data: refresh\n\n") } catch { if (clients.delete(client)) recordSseClient(-1); recordServerError() }
      }
    }, 100)
  }
  try {
    const directory = dirname(storePath)
    const metricsName = basename(metricsPath)
    // -shm is excluded: read-only metrics queries update it and would self-trigger SSE.
    const watched = new Set([basename(storePath), metricsName, `${metricsName}-wal`])
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    watcher = watch(directory, (_event, filename) => {
      if (filename && !watched.has(filename)) return
      notifyRefresh()
    })
    watcher.unref?.()
    watcher.on("error", () => { watcher?.close(); watcher = undefined })
  } catch {}
  try {
    const errorDirectory = dirname(errorLogPath())
    const watchedErrors = new Set([basename(errorLogPath()), `${basename(errorLogPath())}.1`])
    mkdirSync(errorDirectory, { recursive: true, mode: 0o700 })
    errorLogWatcher = watch(errorDirectory, (_event, filename) => {
      if (filename && !watchedErrors.has(filename.toString())) return
      notifyRefresh()
    })
    errorLogWatcher.unref?.()
    errorLogWatcher.on("error", () => { errorLogWatcher?.close(); errorLogWatcher = undefined })
  } catch {}
  server.closeStreams = () => { const count = clients.size; for (const client of clients) { try { client.end() } catch {} } clients.clear(); if (count) recordSseClient(-count) }
  server.on("close", () => { clearTimeout(refreshTimer); watcher?.close(); errorLogWatcher?.close(); server.closeStreams() })
  server.habitToken = token
  return server.listen(port, "127.0.0.1")
}

let uiServer

const ipcFiles = (owner = "opencode") => {
  const base = process.env.XDG_RUNTIME_DIR && isSafeRuntimeDir(process.env.XDG_RUNTIME_DIR)
    ? join(process.env.XDG_RUNTIME_DIR, "habit-memory")
    : join(homedir(), ".local", "share", "habit-memory")
  const dir = base
  const prefix = owner === "project" ? "ui-project-control" : "ui-control"
  return { dir, descriptor: join(dir, `${prefix}.json`), token: join(dir, `${prefix}.token`), lock: join(dir, `${prefix}.lock`) }
}

function isSafeRuntimeDir(path) {
  try {
    const stat = lstatSync(path)
    return stat.isDirectory() && stat.uid === process.getuid?.() && !(stat.mode & 0o077)
  } catch { return false }
}

async function withLock(paths, fn) {
  const deadline = Date.now() + 3000
  while (true) {
    try { await mkdir(paths.lock, { mode: 0o700 }); break }
    catch (error) { if (error.code !== "EEXIST" || Date.now() >= deadline) throw error; await new Promise((resolve) => setTimeout(resolve, 25)) }
  }
  try { return await fn() } finally { await rmdir(paths.lock).catch(() => {}) }
}

async function readDescriptor(paths = ipcFiles()) {
  const stat = await lstat(paths.descriptor)
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error("Unsafe UI control descriptor")
  const raw = await readFile(paths.descriptor, "utf8")
  const descriptor = JSON.parse(raw)
  const secret = await lstat(paths.token)
  if (!secret.isFile() || secret.uid !== process.getuid?.() || (secret.mode & 0o077) || descriptor.token !== await readFile(paths.token, "utf8") || !/^[a-f0-9]{64}$/.test(descriptor.token) || !Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535) throw new Error("Invalid UI control descriptor")
  return { ...descriptor, paths, identity: { descriptor: { dev: stat.dev, ino: stat.ino, raw }, token: { dev: secret.dev, ino: secret.ino } } }
}

function controlRequest(descriptor, { method = "GET", path = controlPath, timeout = 500, bodyLimit = 64 } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: "127.0.0.1", port: descriptor.port, path, method, headers: { host: `127.0.0.1:${descriptor.port}`, origin: `http://127.0.0.1:${descriptor.port}`, ...(path === controlPath ? { "x-habit-token": descriptor.token } : {}) } }, (res) => {
      const chunks = []
      let size = 0
      res.on("data", (chunk) => {
        size += chunk.length
        if (size > bodyLimit) { req.destroy(new Error("Control response too large")); return }
        chunks.push(chunk)
      })
      res.once("end", () => { clearTimeout(timer); resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }) })
      res.once("aborted", () => { clearTimeout(timer); reject(Object.assign(new Error("Control response aborted"), { code: "ECONNRESET" })) })
      res.once("error", (error) => { clearTimeout(timer); reject(error) })
    })
    const timer = setTimeout(() => req.destroy(Object.assign(new Error("Control request timed out"), { code: "ETIMEDOUT" })), timeout)
    req.once("error", (error) => { clearTimeout(timer); reject(error) })
    req.end()
  })
}

async function requestRemoteStop(descriptor) {
  try {
    const response = await controlRequest(descriptor, { method: "POST", timeout: 1000 })
    if (response.status !== 200 || response.body !== "stopping") {
      logCommandError(descriptor.paths.descriptor.includes("ui-project-control") ? "npm run ui:stop" : "habit-memory-ui-stop", "request-stop", new Error(`UI control endpoint returned HTTP ${response.status}`))
      return false
    }
    const deadline = Date.now() + 1500
    while (Date.now() < deadline) {
      try { await controlRequest(descriptor, { path: "/", timeout: 100, bodyLimit: 0 }) }
      catch (error) { if (error.code === "ECONNREFUSED") return true }
      await new Promise((done) => setTimeout(done, 25))
    }
    logCommandError(descriptor.paths.descriptor.includes("ui-project-control") ? "npm run ui:stop" : "habit-memory-ui-stop", "wait-stop", new Error("UI control endpoint did not stop before timeout"))
    return false
  } catch (error) {
    if (error.code !== "ECONNREFUSED") logCommandError(descriptor.paths.descriptor.includes("ui-project-control") ? "npm run ui:stop" : "habit-memory-ui-stop", "request-stop", error)
    return false
  }
}

async function remoteIsActive(descriptor) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await controlRequest(descriptor)
      if (response.status === 200 && response.body === "active") return true
      throw new Error(`Existing UI control endpoint returned an unexpected response (HTTP ${response.status})`)
    } catch (error) {
      if (error.code === "ECONNREFUSED") return false
      if (error.code === "ETIMEDOUT") throw new Error("Existing UI control endpoint timed out")
      if (error.message.startsWith("Existing UI control endpoint")) throw error
      if (attempt === 0 && error.code === "ECONNRESET") continue
      const code = typeof error.code === "string" && /^[A-Z0-9_]{1,40}$/.test(error.code) ? ` (${error.code})` : ""
      throw new Error(`Existing UI control endpoint could not be verified${code}`)
    }
  }
}

async function removeStale(paths, existing) {
  const current = await readDescriptor(paths)
  if (current.identity.descriptor.dev !== existing.identity.descriptor.dev || current.identity.descriptor.ino !== existing.identity.descriptor.ino || current.identity.descriptor.raw !== existing.identity.descriptor.raw || current.identity.token.dev !== existing.identity.token.dev || current.identity.token.ino !== existing.identity.token.ino || current.token !== existing.token) throw new Error("UI control state changed during recovery")
  await unlink(paths.descriptor)
  const tokenStat = await lstat(paths.token)
  if (tokenStat.dev !== existing.identity.token.dev || tokenStat.ino !== existing.identity.token.ino || await readFile(paths.token, "utf8") !== existing.token) throw new Error("UI control token changed during recovery")
  await unlink(paths.token)
}

async function removeOwned(paths, token, descriptorIdentity) {
  try {
    if (await readFile(paths.token, "utf8") !== token) return
    if (!descriptorIdentity) { await unlink(paths.token); return }
    const current = await readDescriptor(paths)
    const stat = await lstat(paths.descriptor)
    if (current.token !== token || stat.dev !== descriptorIdentity.dev || stat.ino !== descriptorIdentity.ino) return
    await unlink(paths.descriptor)
    if (await readFile(paths.token, "utf8") === token) await unlink(paths.token)
  } catch {}
}

async function installControl(server, owner) {
  const paths = ipcFiles(owner)
  await mkdir(paths.dir, { recursive: true, mode: 0o700 })
  const dirStat = await lstat(paths.dir)
  if (!dirStat.isDirectory() || dirStat.uid !== process.getuid?.() || (dirStat.mode & 0o077)) throw new Error("Unsafe Habit Memory control directory")
  await withLock(paths, async () => {
    let descriptorExists = true
    try { await lstat(paths.descriptor) }
    catch (error) { if (error.code === "ENOENT") descriptorExists = false; else throw error }
    if (descriptorExists) {
      const existing = await readDescriptor(paths)
      // A listener that just bound this port cannot be a separate prior server.
      if (existing.port === server.address().port) {
        await removeStale(paths, existing)
      } else if (await remoteIsActive(existing)) {
        server.remotePort = existing.port
        server.close()
        return
      } else {
        await removeStale(paths, existing)
      }
    }
    const token = server.habitToken
    let identity
    server.once("close", () => {
      if (identity) void withLock(paths, () => removeOwned(paths, token, identity)).catch(() => {})
    })
    const tempToken = `${paths.token}.${randomBytes(8).toString("hex")}.tmp`, tempDescriptor = `${paths.descriptor}.${randomBytes(8).toString("hex")}.tmp`
    await writeFile(tempToken, token, { mode: 0o600, flag: "wx" })
    await rename(tempToken, paths.token)
    const publish = () => {
      const descriptor = JSON.stringify({ port: server.address().port, token })
      return writeFile(tempDescriptor, descriptor, { mode: 0o600, flag: "wx" }).then(() => rename(tempDescriptor, paths.descriptor))
    }
    if (!server.listening) throw new Error("UI listener closed before control publication")
    await publish()
    identity = await lstat(paths.descriptor)
  })
}

export function startUiServer({ owner = "opencode" } = {}) {
  if (uiServer?.listening) return uiServer
  const server = createUiServer({ port: Number(process.env.HABIT_MEMORY_UI_PORT || 43109) })
  server.controlOwner = owner
  uiServer = server
  server.controlReady = new Promise((resolve, reject) => {
    server.once("listening", () => installControl(server, owner).then(resolve, (error) => {
      server.close()
      reject(error)
    }))
    server.once("error", reject)
  })
  server.once("close", () => { if (uiServer === server) uiServer = undefined })
  server.on("listening", () => process.stdout.write(`Habit Memory UI: http://127.0.0.1:${server.address().port}\n`))
  return server
}

export async function stopUiServer({ owner = "opencode" } = {}) {
  if (!uiServer?.listening || uiServer.controlOwner !== owner) {
    const paths = ipcFiles(owner)
    return withLock(paths, async () => { const descriptor = await readDescriptor(paths); if (!await requestRemoteStop(descriptor)) return false; return true }).catch((error) => {
      if (error.code !== "ENOENT") logCommandError(owner === "project" ? "npm run ui:stop" : "habit-memory-ui-stop", "read-control-state", error)
      return false
    })
  }
  const server = uiServer
  await server.controlReady
  server.closeStreams()
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve(true)))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const server = startUiServer({ owner: "project" })
    await new Promise((resolve, reject) => {
      if (server.listening) return resolve()
      server.once("listening", resolve)
      server.once("error", reject)
    })
    await server.controlReady
  } catch (error) {
    logCommandError("npm run ui", "startup", error)
    process.exitCode = 1
  }
}
