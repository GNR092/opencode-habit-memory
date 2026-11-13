import assert from "node:assert/strict"
import test from "node:test"
import { randomBytes } from "node:crypto"
import { createServer } from "node:net"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("UI startup replaces a stale descriptor for the port it just bound", async () => {
  const home = await mkdtemp(join(tmpdir(), "habit-memory-ui-stale-"))
  const envNames = ["XDG_RUNTIME_DIR", "XDG_DATA_HOME", "XDG_STATE_HOME", "HABIT_MEMORY_UI_PORT"]
  const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]))
  const probe = createServer()
  let server
  let stopUiServer
  try {
    const port = await new Promise((resolve, reject) => {
      probe.once("error", reject)
      probe.listen(0, "127.0.0.1", () => {
        const value = probe.address().port
        probe.close((error) => error ? reject(error) : resolve(value))
      })
    })
    process.env.XDG_RUNTIME_DIR = home
    process.env.XDG_DATA_HOME = home
    process.env.XDG_STATE_HOME = home
    process.env.HABIT_MEMORY_UI_PORT = String(port)

    const controlDir = join(home, "habit-memory")
    await mkdir(controlDir, { mode: 0o700 })
    const staleToken = randomBytes(32).toString("hex")
    await writeFile(join(controlDir, "ui-project-control.token"), staleToken, { mode: 0o600 })
    await writeFile(join(controlDir, "ui-project-control.json"), JSON.stringify({ port, token: staleToken }), { mode: 0o600 })

    const ui = await import("../src/ui-server.js")
    stopUiServer = ui.stopUiServer
    server = ui.startUiServer({ owner: "project" })
    await server.controlReady

    const descriptor = JSON.parse(await readFile(join(controlDir, "ui-project-control.json"), "utf8"))
    assert.equal(server.listening, true)
    assert.equal(descriptor.port, port)
    assert.notEqual(descriptor.token, staleToken)
    assert.equal(await stopUiServer({ owner: "project" }), true)
  } finally {
    if (server?.listening && stopUiServer) await stopUiServer({ owner: "project" }).catch(() => {})
    if (probe.listening) probe.close()
    for (const name of envNames) {
      if (previous[name] === undefined) delete process.env[name]
      else process.env[name] = previous[name]
    }
    await rm(home, { recursive: true, force: true })
  }
})
