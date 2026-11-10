import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("local UI streams store changes over SSE", async () => {
  const home = await mkdtemp(join(tmpdir(), "habit-ui-events-"))
  const previous = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = home
  const store = await import("../src/store.js")
  const { createUiServer } = await import("../src/ui-server.js")
  const server = createUiServer()
  await new Promise((resolve) => server.once("listening", resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3000)
  timeout.unref()
  try {
    const response = await fetch(`${origin}/api/events`, { signal: controller.signal })
    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type"), /^text\/event-stream/)
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
    await store.saveCheckpoint("project-sse", "session-sse", "Stream this change")
    while (!body.includes("data: refresh") && await read()) {}
    assert.match(body, /data: refresh/)
  } finally {
    clearTimeout(timeout)
    controller.abort()
    await new Promise((resolve) => server.close(resolve))
    if (previous === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})
