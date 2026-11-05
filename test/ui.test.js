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
  const a = await store.saveCheckpoint("project-a", "session-a", "Remember this <script>alert(1)</script>")
  const b = await store.saveCheckpoint("project-a", "session-a", "Also this")
  await store.saveCheckpoint("project-b", "session-b", "Keep this")
  const server = createUiServer()
  await new Promise((resolve) => server.once("listening", resolve))
  const port = server.address().port, origin = `http://127.0.0.1:${port}`
  const get = (path, headers = {}) => fetch(origin + path, { headers })
  const html = await (await get("/")).text()
  const token = html.match(/const token="([a-f0-9]+)"/)[1]
  const send = (path, body, overrides = {}) => fetch(origin + path, { method: "POST", headers: { "content-type": "application/json", origin, "x-habit-token": token, ...overrides }, body: JSON.stringify(body) })
  try {
    assert.match(html, /textContent/)
    assert.match(html, /id="language" aria-label="Language \/ Idioma"/)
    assert.match(html, /Tu memoria de trabajo\./)
    assert.match(html, /Your working memory\./)
    const read = await (await get("/api/data")).json()
    assert.equal(read.checkpoints.length, 3)
    assert.equal(read.checkpoints[0].summary, "Remember this <script>alert(1)</script>")
    assert.equal(await (await send("/api/checkpoint/edit", { project: "project-a", context: "session-a", id: a.id, summary: "Edited safely" })).status, 200)
    assert.equal(await (await send("/api/checkpoint/delete", { project: "project-a", context: "session-a", id: b.id })).status, 200)
    assert.equal(await (await send("/api/scope/delete", { project: "project-a", context: "session-a" })).status, 200)
    assert.equal((await store.getData()).checkpoints.map((c) => c.project).join(), "project-b")
    assert.equal((await send("/api/checkpoint/delete", { project: "project-b", context: "session-b", id: "missing" })).status, 404)
    assert.equal((await send("/api/checkpoint/delete", { project: "project-b", context: "session-b", id: "x" }, { origin: "http://evil.invalid" })).status, 403)
    assert.equal((await send("/api/checkpoint/delete", { project: "project-b", context: "session-b", id: "x" }, { "x-habit-token": "bad" })).status, 403)
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
