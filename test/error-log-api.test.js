import assert from "node:assert/strict"
import test from "node:test"
import { stat } from "node:fs/promises"
import { request as httpRequest } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("recent errors API is safe, host-filtered, and refreshed by SSE including rotation", async () => {
  const dataHome = await mkdtemp(join(tmpdir(), "habit-memory-error-api-data-"))
  const stateHome = await mkdtemp(join(tmpdir(), "habit-memory-error-api-state-"))
  const previousDataHome = process.env.XDG_DATA_HOME
  const previousStateHome = process.env.XDG_STATE_HOME
  process.env.XDG_DATA_HOME = dataHome
  process.env.XDG_STATE_HOME = stateHome
  const { createUiServer } = await import("../src/ui-server.js")
  const { errorLogPath, logCommandError } = await import("../src/error-log.js")
  const server = createUiServer()
  await new Promise((resolve) => server.once("listening", resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  timeout.unref()

  try {
    const empty = await fetch(`${origin}/api/errors`)
    assert.equal(empty.status, 200)
    assert.deepEqual(await empty.json(), { errors: [] })

    const wrongHost = await new Promise((resolve, reject) => {
      const request = httpRequest({
        hostname: "127.0.0.1",
        port: server.address().port,
        path: "/api/errors",
        headers: { host: `untrusted.invalid:${server.address().port}` },
      }, (response) => { response.resume(); resolve(response) })
      request.on("error", reject)
      request.end()
    })
    assert.equal(wrongHost.statusCode, 403)

    const stream = await fetch(`${origin}/api/events`, { signal: controller.signal })
    const reader = stream.body.getReader()
    const decoder = new TextDecoder()
    let body = ""
    const read = async () => {
      const { value, done } = await reader.read()
      if (!done) body += decoder.decode(value, { stream: true })
      return !done
    }
    assert.equal(await read(), true)
    assert.match(body, /: connected/)

    const failure = Object.assign(new Error('private prompt arguments="user text" token=private-secret sessionID=ses_abcdef123456'), {
      code: "EACCES",
      syscall: "open",
    })
    logCommandError("MCP checkpoint_save", "execute", failure)
    while ((body.match(/data: refresh/g) ?? []).length < 1 && await read()) {}
    assert.match(body, /data: refresh/)

    const first = await fetch(`${origin}/api/errors`)
    const firstBody = await first.json()
    assert.equal(first.status, 200)
    assert.equal(firstBody.errors.length, 1)
    assert.deepEqual(Object.keys(firstBody.errors[0]).sort(), ["command", "phase", "reason", "time"])
    assert.deepEqual(firstBody.errors[0].reason, { name: "Error", code: "EACCES", syscall: "open" })
    assert.equal(firstBody.errors[0].command, "MCP checkpoint_save")
    assert.equal(firstBody.errors[0].phase, "execute")
    assert.doesNotMatch(JSON.stringify(firstBody), /private prompt|user text|private-secret|ses_abcdef|arguments|stack/)

    for (let index = 0; index < 300; index++) {
      logCommandError("MCP checkpoint_save", "execute", Object.assign(new Error("x".repeat(1000)), { code: "EACCES", syscall: "open" }))
    }
    await stat(`${errorLogPath()}.1`)
    while ((body.match(/data: refresh/g) ?? []).length < 2 && await read()) {}
    assert.ok((body.match(/data: refresh/g) ?? []).length >= 2)
    const afterRotation = await fetch(`${origin}/api/errors`)
    const rotatedBody = await afterRotation.json()
    assert.equal(rotatedBody.errors.length, 30)
    assert.equal(rotatedBody.errors[0].command, "MCP checkpoint_save")
  } finally {
    clearTimeout(timeout)
    controller.abort()
    await new Promise((resolve) => server.close(resolve))
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previousDataHome
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previousStateHome
    await Promise.all([
      rm(dataHome, { recursive: true, force: true }),
      rm(stateHome, { recursive: true, force: true }),
    ])
  }
})
