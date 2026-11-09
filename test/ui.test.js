import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { request as httpRequest } from "node:http"

test("local UI serves data and protects checkpoint mutations", async () => {
  const home = await mkdtemp(join(tmpdir(), "habit-ui-test-"))
  const previous = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = home
  const store = await import("../src/store.js")
  const { createUiServer } = await import("../src/ui-server.js")
  const a = await store.saveCheckpoint("project-a", "session-a", "Remember this <script>alert(1)</script>", "OpenCode session title", "readable-project")
  const b = await store.saveCheckpoint("project-a", "session-a", "Also this")
  await store.saveCheckpoint("project-b", "session-b", "Keep this")
  await store.saveCheckpoint("a / b", "c", "First colliding scope")
  await store.saveCheckpoint("a", "b / c", "Second colliding scope")
  await store.importLegacy({ version: 1, counts: { "request:cli:git": 5 } })
  await store.incrementHabitCounts(["tool:bash"])
  const server = createUiServer()
  await new Promise((resolve) => server.once("listening", resolve))
  const port = server.address().port, origin = `http://127.0.0.1:${port}`
  const get = (path, headers = {}) => fetch(origin + path, { headers })
  const page = await get("/"), html = await page.text()
  const token = server.habitToken
  const send = (path, body, overrides = {}) => fetch(origin + path, { method: "POST", headers: { "content-type": "application/json", origin, "x-habit-token": token, ...overrides }, body: JSON.stringify(body) })
  try {
    assert.match(page.headers.get("content-security-policy"), /script-src 'self'/)
    if (page.status === 503) {
      assert.match(html, /npm run build/)
      assert.match(html, /dist\//)
    } else {
      assert.equal(page.status, 200)
      assert.match(html, /\/assets\/index-[\w-]+\.js/)
      assert.equal((await get(html.match(/src="([^"]+\.js)"/)[1])).headers.get("content-type"), "text/javascript; charset=utf-8")
      assert.equal((await get(html.match(/href="([^"]+\.css)"/)[1])).headers.get("content-type"), "text/css; charset=utf-8")
      assert.match(html, /habit-token/)
      assert.match(html, /<html lang="es">/)
    }
    const read = await (await get("/api/data")).json()
    assert.equal(read.checkpoints.length, 5)
    assert.equal(read.checkpoints[0].summary, "Remember this <script>alert(1)</script>")
    assert.equal(read.checkpoints[0].sessionTitle, "OpenCode session title")
    assert.equal(read.checkpoints[0].projectDirectoryName, "readable-project")
    assert.equal(read.habits.counts["request:cli:git"], 5)
    assert.equal(read.habits.daily[new Date().toISOString().slice(0, 10)]["tool:bash"], 1)
    assert.equal(await (await send("/api/checkpoint/edit", { project: "project-a", context: "session-a", id: a.id, summary: "Edited safely" })).status, 200)
    assert.equal((await store.getData()).checkpoints.find(({ id }) => id === a.id).sessionTitle, "OpenCode session title")
    assert.equal((await store.getData()).checkpoints.find(({ id }) => id === a.id).projectDirectoryName, "readable-project")
    assert.equal(await (await send("/api/checkpoint/delete", { project: "project-a", context: "session-a", id: b.id })).status, 200)
    assert.equal(await (await send("/api/scope/delete", { project: "project-a", context: "session-a" })).status, 200)
    assert.deepEqual((await store.getData()).checkpoints.map(({ project, context }) => [project, context]), [["project-b", "session-b"], ["a / b", "c"], ["a", "b / c"]])
    assert.equal(await (await send("/api/scope/delete", { project: "a / b", context: "c" })).status, 200)
    assert.deepEqual((await store.getData()).checkpoints.map(({ project, context }) => [project, context]), [["project-b", "session-b"], ["a", "b / c"]])
    assert.equal(await (await send("/api/scope/delete", { project: "a", context: "b / c" })).status, 200)
    assert.deepEqual((await store.getData()).checkpoints.map(({ project, context }) => [project, context]), [["project-b", "session-b"]])
    assert.equal((await send("/api/checkpoint/delete", { project: "project-b", context: "session-b", id: "missing" })).status, 404)
    assert.equal((await send("/api/checkpoint/delete", { project: "project-b", context: "session-b", id: "x" }, { origin: "http://evil.invalid" })).status, 403)
    assert.equal((await send("/api/checkpoint/delete", { project: "project-b", context: "session-b", id: "x" }, { "x-habit-token": "bad" })).status, 403)
    assert.equal((await send("/api/habits/clear", {})).status, 400)
    assert.equal((await send("/api/habits/clear", { confirm: false })).status, 400)
    assert.equal((await send("/api/habits/clear", { confirm: true }, { origin: "http://evil.invalid" })).status, 403)
    assert.equal((await send("/api/habits/clear", { confirm: true }, { "x-habit-token": "bad" })).status, 403)
    const checkpointsBeforeClear = (await store.getData()).checkpoints
    assert.equal((await send("/api/habits/clear", { confirm: true })).status, 200)
    const cleared = await store.getData()
    assert.deepEqual(cleared.habits.counts, {})
    assert.deepEqual(cleared.habits.daily, {})
    assert.equal(cleared.habits.legacyImported, true)
    assert.deepEqual(cleared.checkpoints, checkpointsBeforeClear)
    await store.importLegacy({ version: 1, counts: { "request:cli:git": 99 } })
    assert.deepEqual((await store.getData()).habits.counts, {})
    const wrongHost = await new Promise((resolve, reject) => { const req = httpRequest({ host: "127.0.0.1", port, path: "/api/data", headers: { host: `evil.invalid:${port}` } }, (res) => { res.resume(); resolve(res) }); req.on("error", reject); req.end() })
    assert.equal(wrongHost.statusCode, 403)
    const oversized = await fetch(origin + "/api/checkpoint/edit", { method: "POST", headers: { "content-type": "application/json", origin, "x-habit-token": token }, body: JSON.stringify({ project: "p", context: "c", id: "x", summary: "x".repeat(9000) }) })
    assert.equal(oversized.status, 413)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    if (previous === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})
