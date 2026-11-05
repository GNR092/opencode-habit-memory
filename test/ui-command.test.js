import assert from "node:assert/strict"
import test from "node:test"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { createServer } from "node:net"
import { createServer as createHttpServer } from "node:http"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("/habit-memory-ui starts once and reuses its URL", async () => {
  const home = await mkdtemp(join(tmpdir(), "habit-ui-command-"))
  const previous = process.env.XDG_DATA_HOME
  const previousRuntime = process.env.XDG_RUNTIME_DIR
  const previousPort = process.env.HABIT_MEMORY_UI_PORT
  process.env.XDG_DATA_HOME = home
  process.env.XDG_RUNTIME_DIR = home
  process.env.HABIT_MEMORY_UI_PORT = "0"
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
    for (const [index, { text }] of messages.entries()) {
      assert.match(text, new RegExp(`Puerto: ${new URL(urls[index]).port}`))
    }
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
    if (previousPort === undefined) delete process.env.HABIT_MEMORY_UI_PORT
    else process.env.HABIT_MEMORY_UI_PORT = previousPort
    await rm(home, { recursive: true, force: true })
  }
})

test("UI stop from another process closes the owning listener", async () => {
  const home = await mkdtemp(join(tmpdir(), "habit-ui-cross-process-"))
  const runtime = join(home, "runtime")
  await mkdir(runtime, { mode: 0o700 })
  const env = { ...process.env, HABIT_MEMORY_UI_PORT: "0", XDG_RUNTIME_DIR: runtime, XDG_DATA_HOME: join(home, "data") }
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

test("UI start recovers only a valid stale descriptor after connection refused", async () => {
  const home = await mkdtemp(join(tmpdir(), "habit-ui-stale-"))
  const runtime = join(home, "runtime")
  await mkdir(runtime, { mode: 0o700 })
  const previousRuntime = process.env.XDG_RUNTIME_DIR
  const previousData = process.env.XDG_DATA_HOME
  const previousPort = process.env.HABIT_MEMORY_UI_PORT
  process.env.XDG_RUNTIME_DIR = runtime
  process.env.XDG_DATA_HOME = join(home, "data")
  process.env.HABIT_MEMORY_UI_PORT = "0"
  let server
  try {
    const { createServer: netServer } = await import("node:net")
    const probe = netServer()
    await new Promise((resolve, reject) => probe.once("error", reject).listen(0, "127.0.0.1", resolve))
    const stalePort = probe.address().port
    await new Promise((resolve) => probe.close(resolve))
    const control = join(runtime, "habit-memory")
    await mkdir(control, { mode: 0o700 })
    const token = randomBytes(32).toString("hex")
    await writeFile(join(control, "ui-control.token"), token, { mode: 0o600 })
    await writeFile(join(control, "ui-control.json"), JSON.stringify({ port: stalePort, token }), { mode: 0o600 })

    const { startUiServer } = await import(`../src/ui-server.js?stale=${Date.now()}`)
    server = startUiServer()
    await deadline(server.controlReady, 3000, "stale recovery")
    assert.notEqual(server.address().port, stalePort)
    const descriptor = JSON.parse(await readFile(join(control, "ui-control.json"), "utf8"))
    assert.equal(descriptor.port, server.address().port)
    assert.notEqual(descriptor.token, token)
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    server = undefined
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(resolve))
    if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR
    else process.env.XDG_RUNTIME_DIR = previousRuntime
    if (previousData === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previousData
    if (previousPort === undefined) delete process.env.HABIT_MEMORY_UI_PORT
    else process.env.HABIT_MEMORY_UI_PORT = previousPort
    await rm(home, { recursive: true, force: true })
  }
})

test("UI start preserves control state after timeout and interrupted response body", async () => {
  for (const [name, calls] of [
    ["timeout", 1],
    ["interrupted body", 2],
  ]) {
    const home = await mkdtemp(join(tmpdir(), `habit-ui-${name.replaceAll(" ", "-")}-`))
    const runtime = join(home, "runtime")
    await mkdir(runtime, { mode: 0o700 })
    const previousRuntime = process.env.XDG_RUNTIME_DIR
    const previousData = process.env.XDG_DATA_HOME
    const previousPort = process.env.HABIT_MEMORY_UI_PORT
    process.env.XDG_RUNTIME_DIR = runtime
    process.env.XDG_DATA_HOME = join(home, "data")
    process.env.HABIT_MEMORY_UI_PORT = "0"
    let requests = 0
    const endpoint = createHttpServer((_req, res) => {
      requests++
      if (name === "timeout") return setTimeout(() => res.writeHead(200).end("active"), 800)
      res.writeHead(200)
      res.socket.destroy()
    })
    let server
    try {
      await new Promise((resolve, reject) => endpoint.once("error", reject).listen(0, "127.0.0.1", resolve))
      const control = join(runtime, "habit-memory")
      await mkdir(control, { mode: 0o700 })
      const token = randomBytes(32).toString("hex")
      const descriptorPath = join(control, "ui-control.json")
      await writeFile(join(control, "ui-control.token"), token, { mode: 0o600 })
      await writeFile(descriptorPath, JSON.stringify({ port: endpoint.address().port, token }), { mode: 0o600 })
      const { startUiServer } = await import(`../src/ui-server.js?${name.replaceAll(" ", "-")}=${Date.now()}`)
      server = startUiServer()
      await assert.rejects(deadline(server.controlReady, 3000, name), name === "timeout" ? /timed out/ : /ECONNRESET/)
      assert.equal(requests, calls)
      assert.equal(JSON.parse(await readFile(descriptorPath, "utf8")).port, endpoint.address().port)
      assert.equal(await readFile(join(control, "ui-control.token"), "utf8"), token)
      if (server.listening) await deadline(new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())), 1000, `${name} listener cleanup`)
      assert.equal(server.listening, false)
      server = undefined
    } finally {
      if (server?.listening) await new Promise((resolve) => server.close(resolve))
      await new Promise((resolve) => endpoint.close(resolve))
      if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR
      else process.env.XDG_RUNTIME_DIR = previousRuntime
      if (previousData === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = previousData
      if (previousPort === undefined) delete process.env.HABIT_MEMORY_UI_PORT
      else process.env.HABIT_MEMORY_UI_PORT = previousPort
      await rm(home, { recursive: true, force: true })
    }
  }
})

test("UI start fails closed when a valid control endpoint is ambiguous", async () => {
  const home = await mkdtemp(join(tmpdir(), "habit-ui-ambiguous-"))
  const runtime = join(home, "runtime")
  await mkdir(runtime, { mode: 0o700 })
  const previousRuntime = process.env.XDG_RUNTIME_DIR
  const previousData = process.env.XDG_DATA_HOME
  const previousPort = process.env.HABIT_MEMORY_UI_PORT
  process.env.XDG_RUNTIME_DIR = runtime
  process.env.XDG_DATA_HOME = join(home, "data")
  process.env.HABIT_MEMORY_UI_PORT = "0"
  const endpoint = createHttpServer((_req, res) => { res.writeHead(404).end() })
  let server
  try {
    await new Promise((resolve, reject) => endpoint.once("error", reject).listen(0, "127.0.0.1", resolve))
    const control = join(runtime, "habit-memory")
    await mkdir(control, { mode: 0o700 })
    const token = randomBytes(32).toString("hex")
    await writeFile(join(control, "ui-control.token"), token, { mode: 0o600 })
    await writeFile(join(control, "ui-control.json"), JSON.stringify({ port: endpoint.address().port, token }), { mode: 0o600 })
    const { startUiServer } = await import(`../src/ui-server.js?ambiguous=${Date.now()}`)
    server = startUiServer()
    await assert.rejects(deadline(server.controlReady, 3000, "ambiguous control"), /unexpected response/)
    await deadline(new Promise((resolve) => server.once("close", resolve)), 1000, "failed listener cleanup")
    server = undefined
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(resolve))
    await new Promise((resolve) => endpoint.close(resolve))
    if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR
    else process.env.XDG_RUNTIME_DIR = previousRuntime
    if (previousData === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previousData
    if (previousPort === undefined) delete process.env.HABIT_MEMORY_UI_PORT
    else process.env.HABIT_MEMORY_UI_PORT = previousPort
    await rm(home, { recursive: true, force: true })
  }
})

test("concurrent UI starts converge on one listener", async () => {
  const home = await mkdtemp(join(tmpdir(), "habit-ui-concurrent-"))
  const runtime = join(home, "runtime")
  await mkdir(runtime, { mode: 0o700 })
  const env = { ...process.env, HABIT_MEMORY_UI_PORT: "0", XDG_RUNTIME_DIR: runtime, XDG_DATA_HOME: join(home, "data") }
  const moduleUrl = new URL("../src/ui-server.js", import.meta.url).href
  const start = () => spawn(process.execPath, ["--input-type=module", "-e", `import {startUiServer} from ${JSON.stringify(moduleUrl)}; const s=startUiServer(); s.controlReady.then(()=>console.log(s.remotePort||s.address().port)); const timer=setInterval(()=>{},1000); s.once('close',()=>clearInterval(timer))`], { env, stdio: ["ignore", "pipe", "inherit"] })
  const starters = [start(), start()]
  try {
    const ports = await Promise.all(starters.map((child) => deadline(new Promise((resolve, reject) => {
      let output = ""
      child.stdout.on("data", (chunk) => { output += chunk.toString(); const match = output.match(/(?:^|\n)(\d+)(?:\n|$)/); if (match) resolve(Number(match[1])) })
      child.once("exit", (code) => reject(new Error(`starter exited ${code}`)))
      child.once("error", reject)
    }), 3000, "concurrent start")))
    assert.equal(ports[0], ports[1])
    await deadline((async () => { while (true) { try { await access(join(runtime, "habit-memory", "ui-control.json")); return } catch {} await new Promise((resolve) => setTimeout(resolve, 20)) } })(), 3000, "control publication")
  } finally {
    await Promise.all(starters.map(killAndWait))
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
