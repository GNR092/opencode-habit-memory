import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { errorLogPath, logCommandError, maxLogBytes, maxRecentErrors, readRecentErrors, withCommandErrorLog } from "../src/error-log.js"

test("command errors are private, sanitized, and rotated", async () => {
  const home = await mkdtemp(join(tmpdir(), "habit-memory-error-log-"))
  const previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = home
  try {
    const failure = Object.assign(new Error('EACCES token=topsecret Authorization: Bearer abc123 prompt="private prompt" arguments="private args" sessionID=ses_abcdef123456'), { code: "EACCES", syscall: "open" })
    await assert.rejects(withCommandErrorLog("project_todo_create", "save-todo", async () => { throw failure }), (error) => error === failure)

    const path = errorLogPath()
    const record = JSON.parse((await readFile(path, "utf8")).trim())
    assert.equal(record.command, "project_todo_create")
    assert.equal(record.phase, "save-todo")
    assert.equal(record.error.code, "EACCES")
    assert.equal(record.error.syscall, "open")
    const firstLog = JSON.stringify(record)
    assert.doesNotMatch(firstLog, /topsecret|abc123|private prompt|private args|ses_abcdef/)

    assert.equal((await stat(join(home, "habit-memory-plugin"))).mode & 0o077, 0)
    assert.equal((await stat(path)).mode & 0o077, 0)

    for (let i = 0; i < 300; i++) logCommandError("MCP checkpoint_save", "execute", new Error("x".repeat(1000)))
    const current = await stat(path)
    const rotated = await stat(`${path}.1`)
    assert.ok(current.size <= maxLogBytes)
    assert.ok(rotated.size <= maxLogBytes)
    assert.equal(current.mode & 0o077, 0)
    assert.equal(rotated.mode & 0o077, 0)
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test("recent error reader caps output and exposes only safe fields across rotation", async () => {
  const home = await mkdtemp(join(tmpdir(), "habit-memory-error-reader-"))
  const directory = join(home, "habit-memory-plugin")
  await mkdir(directory, { mode: 0o700 })
  const path = join(directory, "errors.log")
  const start = Date.parse("2026-11-13T20:00:00.000Z")
  const entry = (index) => ({
    time: new Date(start + index).toISOString(),
    command: "MCP checkpoint_save",
    phase: "execute",
    error: { name: "TypeError", code: "EACCES", syscall: "open", message: "private prompt token=not-for-ui", stack: "private sessionID=ses_1234567890" },
    arguments: "private arguments",
  })
  const previous = Array.from({ length: 40 }, (_, index) => entry(index))
  const current = Array.from({ length: 20 }, (_, index) => entry(index + 40))
  current.push({
    ...entry(61),
    command: "MCP checkpoint_save arguments=private",
    phase: "execute sessionID=ses_abcdef123456",
    error: { name: "CustomSecretName", code: "TOPSECRET123", syscall: "secret-path", message: "prompt=private secret=not-for-ui", stack: "private args" },
  })
  try {
    await writeFile(`${path}.1`, previous.map((value) => JSON.stringify(value)).join("\n") + "\n", { mode: 0o600 })
    await writeFile(path, current.map((value) => JSON.stringify(value)).join("\n") + "\n", { mode: 0o600 })

    const recent = await readRecentErrors({ path })
    assert.equal(maxRecentErrors, 30)
    assert.equal(recent.length, 30)
    assert.equal(recent[0].time, new Date(start + 61).toISOString())
    assert.deepEqual(recent[0], {
      time: new Date(start + 61).toISOString(),
      command: "habit-memory",
      phase: "unknown",
      reason: { name: "Error" },
    })
    assert.equal(recent[1].command, "MCP checkpoint_save")
    assert.equal(recent[1].phase, "execute")
    assert.deepEqual(recent[1].reason, { name: "TypeError", code: "EACCES", syscall: "open" })
    assert.doesNotMatch(JSON.stringify(recent), /private|not-for-ui|TOPSECRET|ses_abcdef|sessionID|arguments/)
    assert.deepEqual(await readRecentErrors({ path: join(directory, "missing.log") }), [])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
