import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("/habit-memory-ui starts once and reuses its URL", async () => {
  const home = await mkdtemp(join(tmpdir(), "habit-ui-command-"))
  const previous = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = home
  let server
  const { default: plugin } = await import("../index.js")
  const { startUiServer } = await import("../src/ui-server.js")
  const commands = new Map(), messages = []
  const hooks = { async hook() {} }
  const ctx = {
    storage: { async get() {} }, tool: { ...hooks, async transform() {} }, shell: hooks,
    session: { ...hooks, async synthetic(message) { messages.push(message) } },
    command: { async transform(callback) { callback({ add(command) { commands.set(command.name, command) } }) }, async reload() {} },
  }
  try {
    await plugin.setup(ctx)
    const command = commands.get("habit-memory-ui")
    assert.ok(command)
    await command.execute({ sessionID: "test" })
    await command.execute({ sessionID: "test" })
    const urls = messages.map(({ text }) => text.match(/http:\/\/127\.0\.0\.1:\d+/)[0])
    assert.equal(urls[0], urls[1])
    server = startUiServer()
    assert.equal(server.address().port, Number(new URL(urls[0]).port))
    assert.equal(server.listening, true)
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(resolve))
    if (previous === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})
