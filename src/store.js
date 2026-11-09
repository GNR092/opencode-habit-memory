import { randomUUID } from "node:crypto"
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import { homedir } from "node:os"

const maxBytes = 2_000_000
const categories = new Set([
  ...["bash", "read", "write", "edit", "patch", "glob", "grep", "task", "subagent", "websearch", "webfetch"].flatMap((n) => [`tool:${n}`, `request:tool:${n}`]),
  ...["git", "php", "python", "python3", "pytest", "composer", "npm", "pnpm", "yarn", "bun", "docker", "opencode", "codesearch"].flatMap((n) => [`cli:${n}`, `request:cli:${n}`]),
  ...["build", "plan", "code", "explore", "general", "orquestador", "01-debug", "02-agente-plan", "03-fix", "04-test", "agente-debugger", "cambio-quirurgico", "ciberseguridad", "django-expert", "docker", "docker-expert", "frontend-designer", "git", "investigador-cientifico", "investigador-secundario", "linux-expert", "minecraft", "versionador"].map((n) => `request:agent:${n}`),
])
const root = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
export const storePath = join(root, "habit-memory-plugin", "store-v1.json")
const lockPath = `${storePath}.lock`
const recoveryPath = `${lockPath}.recovery`
const staleLockMs = 120_000
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino
async function unlinkIfSame(path, identity) {
  try { if (sameFile(identity, await stat(path))) await unlink(path) } catch {}
}
async function hasRecoveryClaim() {
  try { await stat(recoveryPath); return true } catch (error) {
    if (error.code === "ENOENT") return false
    throw error
  }
}
async function lockSnapshot() { return { stat: await stat(lockPath), contents: await readFile(lockPath, "utf8") } }
function sameLock(a, b) {
  return sameFile(a.stat, b.stat) && a.stat.size === b.stat.size && a.stat.mtimeMs === b.stat.mtimeMs && a.stat.ctimeMs === b.stat.ctimeMs && a.contents === b.contents
}
async function recoverStaleLock() {
  let initial
  try {
    initial = await lockSnapshot()
    if (Date.now() - initial.stat.mtimeMs <= staleLockMs) return
  } catch { return }
  const pid = Number(initial.contents), validPid = Number.isSafeInteger(pid) && pid > 0
  if (validPid) {
    try { process.kill(pid, 0); return } catch (error) { if (error.code !== "ESRCH") return }
  }
  let claim
  try { claim = await open(recoveryPath, "wx", 0o600) } catch { return }
  try {
    const before = await lockSnapshot()
    if (!sameLock(initial, before) || Date.now() - before.stat.mtimeMs <= staleLockMs) return
    if (validPid) {
      try { process.kill(pid, 0); return } catch (error) { if (error.code !== "ESRCH") return }
    }
    const current = await lockSnapshot()
    if (!sameLock(before, current) || Date.now() - current.stat.mtimeMs <= staleLockMs) return
    if (validPid) {
      try { process.kill(pid, 0); return } catch (error) { if (error.code !== "ESRCH") return }
    }
    await unlink(lockPath)
  } catch {
    // Any uncertainty leaves the existing lock in place.
  } finally {
    await claim.close().catch(() => {})
    await unlink(recoveryPath).catch(() => {})
  }
}

const empty = () => ({ version: 1, habits: { version: 1, counts: {}, daily: {} }, checkpoints: [] })
const text = (v, max = 240) => typeof v === "string" && v.length > 0 && v.length <= max
const basenameValue = (v) => typeof v === "string" && v.length > 0 && v.length <= 128 && v === v.trim() && v !== "." && v !== ".." && !/[\\/\u0000-\u001f\u007f]/.test(v) ? v : undefined
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value
function valid(data) {
  if (!data || Object.keys(data).some((k) => !["version", "habits", "checkpoints"].includes(k)) || data.version !== 1 || !data.habits || Object.keys(data.habits).some((k) => !["version", "counts", "daily", "legacyImported"].includes(k)) || data.habits.version !== 1 || !data.habits.counts || (data.habits.legacyImported !== undefined && typeof data.habits.legacyImported !== "boolean") || !Array.isArray(data.checkpoints)) throw new Error("Invalid habit-memory store schema")
  for (const [key, count] of Object.entries(data.habits.counts)) if (!categories.has(key) || !Number.isSafeInteger(count) || count < 1 || count > 999) throw new Error("Invalid habits data")
  const daily = data.habits.daily === undefined ? {} : data.habits.daily
  if (!daily || typeof daily !== "object" || Array.isArray(daily) || Object.keys(daily).length > 365) throw new Error("Invalid daily habit data")
  for (const [date, counts] of Object.entries(daily)) {
    if (!validDate(date) || !counts || typeof counts !== "object" || Array.isArray(counts) || !Object.keys(counts).length) throw new Error("Invalid daily habit data")
    for (const [key, count] of Object.entries(counts)) if (!categories.has(key) || !Number.isSafeInteger(count) || count < 1) throw new Error("Invalid daily habit data")
  }
  data.habits.daily = daily
  if (data.checkpoints.length > 10000 || data.checkpoints.some((c) => !c || Object.keys(c).some((k) => !["id", "project", "context", "summary", "createdAt", "sessionTitle", "projectDirectoryName"].includes(k)) || !text(c.id, 80) || !text(c.project, 128) || !text(c.context, 128) || !text(c.summary) || !text(c.createdAt, 40) || (c.sessionTitle !== undefined && !text(c.sessionTitle, 200)) || (c.projectDirectoryName !== undefined && !basenameValue(c.projectDirectoryName)))) throw new Error("Invalid checkpoint data")
  return data
}
async function read() {
  try {
    const raw = await readFile(storePath)
    if (raw.length > maxBytes) throw new Error("Storage exceeds size limit")
    return valid(JSON.parse(raw))
  } catch (error) {
    if (error.code === "ENOENT") return empty()
    throw error
  }
}
async function locked(fn) {
  await mkdir(dirname(storePath), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + 5000
  let handle, identity
  while (!handle) {
    try {
      const candidate = await open(lockPath, "wx", 0o600)
      let candidateIdentity
      try {
        candidateIdentity = await candidate.stat()
        if (await hasRecoveryClaim()) {
          await candidate.close()
          await unlinkIfSame(lockPath, candidateIdentity)
        } else {
          handle = candidate
          identity = candidateIdentity
        }
      } catch (error) {
        await candidate.close().catch(() => {})
        if (candidateIdentity) await unlinkIfSame(lockPath, candidateIdentity)
        throw error
      }
    }
    catch (error) {
      if (error.code !== "EEXIST") throw error
      await recoverStaleLock()
    }
    if (!handle) {
      if (Date.now() >= deadline) throw new Error("Storage is locked")
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  try {
    await handle.writeFile(String(process.pid))
    return await fn()
  } finally {
    await handle.close()
    await unlinkIfSame(lockPath, identity)
  }
}
async function write(data) {
  valid(data)
  const serialized = JSON.stringify(data)
  if (Buffer.byteLength(serialized) > maxBytes) throw new Error("Storage exceeds size limit")
  const temp = `${storePath}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temp, "wx", 0o600)
  try {
    await handle.writeFile(serialized)
    await handle.sync()
    await handle.close()
    await rename(temp, storePath)
  } catch (error) {
    await handle.close().catch(() => {})
    await unlink(temp).catch(() => {})
    throw error
  }
}
const scope = (project, context) => {
  if (!text(project, 128) || !text(context, 128)) throw new Error("project and context are required (max 128 chars)")
}
export async function getData() { return read() }
export async function saveHabitCounts(counts) {
  return locked(async () => { const data = await read(); data.habits = { ...data.habits, version: 1, counts }; await write(data) })
}
export async function incrementHabitCounts(keys) {
  return locked(async () => {
    const data = await read()
    const accepted = [...new Set(keys.filter((key) => categories.has(key)))]
    if (!accepted.length) return
    const today = new Date().toISOString().slice(0, 10)
    const cutoff = new Date(`${today}T00:00:00.000Z`)
    cutoff.setUTCDate(cutoff.getUTCDate() - 364)
    for (const date of Object.keys(data.habits.daily)) if (date < cutoff.toISOString().slice(0, 10) || date > today) delete data.habits.daily[date]
    const daily = data.habits.daily[today] ??= {}
    for (const key of accepted) {
      data.habits.counts[key] = Math.min(999, (data.habits.counts[key] ?? 0) + 1)
      daily[key] = Math.min(Number.MAX_SAFE_INTEGER, (daily[key] ?? 0) + 1)
    }
    await write(data)
  })
}
export async function clearHabits() {
  return locked(async () => {
    const data = await read()
    data.habits = { version: 1, counts: {}, daily: {}, ...(data.habits.legacyImported === undefined ? {} : { legacyImported: data.habits.legacyImported }) }
    await write(data)
  })
}
export async function saveCheckpoint(project, context, summary, sessionTitle, projectDirectoryName) {
  scope(project, context)
  if (!text(summary)) throw new Error("summary is required (max 240 chars)")
  return locked(async () => {
    const data = await read()
    const title = typeof sessionTitle === "string" ? sessionTitle.trim() : ""
    const directory = basenameValue(typeof projectDirectoryName === "string" ? projectDirectoryName.trim() : projectDirectoryName)
    const record = { id: randomUUID(), project, context, summary, createdAt: new Date().toISOString(), ...(title && title.length <= 200 ? { sessionTitle: title } : {}), ...(directory ? { projectDirectoryName: directory } : {}) }
    data.checkpoints.push(record)
    await write(data); return record
  })
}
export async function listCheckpoints(project, context) {
  scope(project, context)
  return (await read()).checkpoints.filter((c) => c.project === project && c.context === context).sort((a,b) => b.createdAt.localeCompare(a.createdAt))
}
export async function listCheckpointContexts(project) {
  if (!text(project, 128)) throw new Error("project is required (max 128 chars)")
  return [...new Set((await read()).checkpoints.filter((c) => c.project === project).map((c) => c.context))].sort()
}
export async function deleteCheckpoint(project, context, id) {
  scope(project, context)
  if (!text(id, 80)) throw new Error("id is required (max 80 chars)")
  return locked(async () => { const data = await read(), before = data.checkpoints.length; data.checkpoints = data.checkpoints.filter((c) => !(c.project === project && c.context === context && c.id === id)); if (before !== data.checkpoints.length) await write(data); return before !== data.checkpoints.length })
}
export async function updateCheckpoint(project, context, id, summary) {
  scope(project, context)
  if (!text(id, 80) || !text(summary)) throw new Error("id and summary are required (max 240 chars)")
  return locked(async () => {
    const data = await read(), checkpoint = data.checkpoints.find((c) => c.project === project && c.context === context && c.id === id)
    if (!checkpoint) return false
    checkpoint.summary = summary
    await write(data)
    return true
  })
}
export async function clearCheckpoints(project, context) {
  scope(project, context)
  return locked(async () => { const data = await read(), before = data.checkpoints.length; data.checkpoints = data.checkpoints.filter((c) => c.project !== project || c.context !== context); if (before !== data.checkpoints.length) await write(data); return before - data.checkpoints.length })
}
export async function importLegacy(profile, checkpoint) {
  return locked(async () => {
    const data = await read()
    let changed = false
    if (!data.habits.legacyImported) {
      const counts = profile?.version === 1 && profile.counts
        ? Object.fromEntries(Object.entries(profile.counts).filter(([k,v]) => categories.has(k) && Number.isSafeInteger(v) && v > 0).map(([k,v]) => [k, Math.min(v,999)]))
        : data.habits.counts
      data.habits = { ...data.habits, version: 1, counts, legacyImported: true }
      changed = true
    }
    if (checkpoint?.version === 1 && text(checkpoint.summary) && text(checkpoint.project, 128) && !data.checkpoints.some((c) => c.id === `legacy-${checkpoint.project}`)) {
      data.checkpoints.push({ id: `legacy-${checkpoint.project}`, project: checkpoint.project, context: "legacy", summary: checkpoint.summary, createdAt: new Date(0).toISOString() })
      changed = true
    }
    if (changed) await write(data)
  })
}
