import assert from "node:assert/strict"
import test from "node:test"
import { access, mkdir, mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("/habit-memory-ui starts once and reuses its URL", async () => {
  const home = await mkdtemp(join(tmpdir(), "habit-ui-command-"))
  const previous = process.env.XDG_DATA_HOME
  const previousRuntime = process.env.XDG_RUNTIME_DIR
  process.env.XDG_DATA_HOME = home
  process.env.XDG_RUNTIME_DIR = home
  let server
  const { default: plugin } = await import("../index.js")
  const { startUiServer, stopUiServer } = await import("../src/ui-server.js")
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
    const stopCommand = commands.get("habit-memory-ui-stop")
    assert.ok(stopCommand)
    const port = server.address().port
    await stopCommand.execute({ sessionID: "test" })
    assert.equal(server.listening, false)
    const probe = createServer()
    await new Promise((resolve, reject) => probe.once("error", reject).listen(port, "127.0.0.1", resolve))
    await new Promise((resolve) => probe.close(resolve))
    assert.match(messages.at(-1).text, /detenida/)
    await stopCommand.execute({ sessionID: "test" })
    assert.match(messages.at(-1).text, /no estaba iniciada/)
    assert.equal(await stopUiServer(), false)
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(resolve))
    if (previous === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previous
    if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR
    else process.env.XDG_RUNTIME_DIR = previousRuntime
    await rm(home, { recursive: true, force: true })
  }
})

test("UI stop from another process closes the owning listener", async () => {
  const home = await mkdtemp(join(tmpdir(), "habit-ui-cross-process-"))
  const runtime = join(home, "runtime")
  await mkdir(runtime, { mode: 0o700 })
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime, XDG_DATA_HOME: join(home, "data") }
  const moduleUrl = new URL("../src/ui-server.js", import.meta.url).href
  const starter = spawn(process.execPath, ["--input-type=module", "-e", `import {startUiServer} from ${JSON.stringify(moduleUrl)}; const s=startUiServer(); s.controlReady.then(()=>console.log(s.address().port)); const timer=setInterval(()=>{},1000); s.once('close',()=>clearInterval(timer))`], { env, stdio: ["ignore", "pipe", "inherit"] })
  let stopper
  try {
    const port = await deadline(new Promise((resolve, reject) => {
      let output = ""
      starter.stdout.on("data", (chunk) => {
        output += chunk.toString()
        const match = output.match(/(?:^|\n)(\d+)(?:\n|$)/)
        if (match) resolve(Number(match[1]))
      })
      starter.once("exit", (code) => reject(new Error(`starter exited ${code}`)))
      starter.once("error", reject)
    }), 3000, "starter startup")
    assert.ok(port > 0)
    const descriptor = join(runtime, "habit-memory", "ui-control.json")
    await deadline((async () => { while (true) { try { await access(descriptor); return } catch {} await new Promise((resolve) => setTimeout(resolve, 20)) } })(), 3000, "descriptor publication")
    stopper = runStopChild(moduleUrl, env)
    const stop = await deadline(stopper, 3000, "stop child")
    assert.equal(stop, "true")
    const [code] = await deadline(once(starter, "exit"), 3000, "starter exit")
    assert.equal(code, 0)
    const probe = createServer()
    await new Promise((resolve, reject) => probe.once("error", reject).listen(port, "127.0.0.1", resolve))
    await new Promise((resolve) => probe.close(resolve))
  } finally {
    await Promise.all([starter, stopper?.child].filter(Boolean).map(killAndWait))
    await rm(home, { recursive: true, force: true })
  }
})

function runStopChild(moduleUrl, env) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import {stopUiServer} from ${JSON.stringify(moduleUrl)}; console.log(await stopUiServer())`], { env, stdio: ["ignore", "pipe", "pipe"] })
  let stdout = "", stderr = ""
  child.stdout.on("data", (data) => { stdout += data })
  child.stderr.on("data", (data) => { stderr += data })
  const result = deadline(once(child, "exit").then(([code]) => { assert.equal(code, 0, stderr); return stdout.trim() }), 2500, "stop process").finally(() => killAndWait(child))
  result.child = child
  return result
}

function deadline(promise, ms, label) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms) })]).finally(() => clearTimeout(timer))
}

async function killAndWait(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, "exit")
  child.kill("SIGKILL")
  await deadline(exited, 1000, "child cleanup")
}
