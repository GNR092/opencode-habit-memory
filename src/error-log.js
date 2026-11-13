import { constants, chmodSync, closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"

export const maxLogBytes = 256 * 1024
export const maxRecentErrors = 30

const redactions = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
  [/\b(password|passwd|token|secret|api[-_]?key|access[-_]?key|refresh[-_]?token)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1$2[REDACTED]"],
  [/\b(prompt|transcripts?|arguments?|session(?:[_ -]?id)?|checkpoint[_ -]?id|todo[_ -]?id)\b(\s*[:=]\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\r\n;,]+)/gi, "$1$2[REDACTED]"],
  [/\bses[-_][A-Za-z0-9_-]{6,}\b|\bses[A-Za-z0-9]{12,}\b/gi, "[REDACTED_SESSION_ID]"],
  [/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1[REDACTED]@"],
  [/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[REDACTED_PRIVATE_KEY]"],
]

const publicCommands = new Set([
  "habit-memory-mcp", "habit-memory-ui", "habit-memory-ui-stop", "npm run ui", "npm run ui:stop",
  "MCP tools/call", "MCP habit_memory_get", "MCP checkpoint_list", "MCP checkpoint_projects",
  "MCP checkpoint_contexts", "MCP checkpoint_save", "MCP checkpoint_delete", "MCP checkpoint_clear",
  "project-checkpoint-clear", "project_checkpoint_save", "project_todo_list", "project_todo_create",
  "project_todo_update", "project_todo_archive", "habit_memory",
])
const publicPhases = new Set([
  "parse-request", "execute", "dispatch", "start-server", "wait-listening", "publish-control",
  "notify-session", "stop-server", "resolve-project", "delete-checkpoint", "save-checkpoint",
  "list-todos", "update-todo", "archive-todo", "show", "request-stop", "wait-stop",
  "read-control-state", "startup",
])
const publicErrorNames = new Set(["AbortError", "AggregateError", "Error", "RangeError", "ReferenceError", "SyntaxError", "TypeError"])
const publicErrorCodes = new Set([
  "EACCES", "EADDRINUSE", "EADDRNOTAVAIL", "EBADF", "ECONNREFUSED", "ECONNRESET", "EEXIST",
  "EAI_AGAIN", "EISDIR", "EINVAL", "ELOOP", "EMFILE", "ENFILE", "ENODEV", "ENOENT", "ENOSPC",
  "ENOTDIR", "ENOTEMPTY", "EPIPE", "EPERM", "EROFS", "ETIMEDOUT", "ENOTFOUND",
  "ERR_HTTP_HEADERS_SENT", "ERR_STREAM_PREMATURE_CLOSE", "INVALID_METRICS_QUERY",
])
const publicSyscalls = new Set(["access", "bind", "chmod", "close", "connect", "fstat", "listen", "lstat", "mkdir", "open", "read", "readdir", "rename", "rmdir", "scandir", "stat", "unlink", "write"])

function sanitize(value, limit) {
  let result = value.replace(/\0/g, "�")
  for (const [pattern, replacement] of redactions) result = result.replace(pattern, replacement)
  return result.slice(0, limit)
}

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error("Unsafe error log directory")
  if (stat.mode & 0o077) chmodSync(path, 0o700)
}

function logSize(path) {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error("Unsafe error log file")
    if (stat.mode & 0o077) chmodSync(path, 0o600)
    return stat.size
  } catch (error) {
    if (error.code === "ENOENT") return 0
    throw error
  }
}

function rotate(path) {
  const backup = `${path}.1`
  try { unlinkSync(backup) } catch (error) { if (error.code !== "ENOENT") throw error }
  renameSync(path, backup)
  chmodSync(backup, 0o600)
}

export function errorLogPath() {
  const stateHome = process.env.XDG_STATE_HOME
  const root = stateHome && isAbsolute(stateHome) ? stateHome : join(homedir(), ".local", "state")
  return join(root, "habit-memory-plugin", "errors.log")
}

function readLog(path) {
  let fd
  try {
    const before = lstatSync(path)
    if (!before.isFile() || before.isSymbolicLink() || (process.getuid && before.uid !== process.getuid()) || (before.mode & 0o077)) throw new Error("Unsafe error log file")
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const stat = fstatSync(fd)
    if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) throw new Error("Unsafe error log file")
    const length = Math.min(stat.size, maxLogBytes)
    const start = Math.max(0, stat.size - length)
    const buffer = Buffer.alloc(length)
    let offset = 0
    while (offset < length) {
      const count = readSync(fd, buffer, offset, length - offset, start + offset)
      if (!count) break
      offset += count
    }
    return buffer.subarray(0, offset).toString("utf8").split("\n").slice(-maxRecentErrors).flatMap((line) => {
      try {
        const value = JSON.parse(line)
        const time = new Date(value?.time)
        if (!value || typeof value !== "object" || !Number.isFinite(time.getTime()) || !value.error || typeof value.error !== "object") return []
        const code = publicErrorCodes.has(value.error.code) ? value.error.code : undefined
        const syscall = publicSyscalls.has(value.error.syscall) ? value.error.syscall : undefined
        return [{
          time: time.toISOString(),
          command: publicCommands.has(value.command) ? value.command : "habit-memory",
          phase: publicPhases.has(value.phase) ? value.phase : "unknown",
          reason: {
            name: publicErrorNames.has(value.error.name) ? value.error.name : "Error",
            ...(code ? { code } : {}),
            ...(syscall ? { syscall } : {}),
          },
        }]
      } catch {
        return []
      }
    })
  } catch (error) {
    if (error.code === "ENOENT") return []
    throw error
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function readRecentErrors({ path = errorLogPath() } = {}) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("Invalid error log path")
  return [...readLog(`${path}.1`), ...readLog(path)]
    .sort((a, b) => Date.parse(b.time) - Date.parse(a.time))
    .slice(0, maxRecentErrors)
}

export function logCommandError(command, phase, error) {
  try {
    const path = errorLogPath()
    privateDirectory(dirname(path))
    const isError = error instanceof Error
    const entry = {
      time: new Date().toISOString(),
      command: sanitize(String(command), 80),
      phase: sanitize(String(phase), 80),
      error: {
        name: isError && typeof error.name === "string" ? sanitize(error.name, 80) : "NonErrorThrown",
        ...(typeof error?.code === "string" && /^[A-Z0-9_-]{1,48}$/.test(error.code) ? { code: error.code } : {}),
        ...(typeof error?.syscall === "string" && /^[A-Za-z0-9_.-]{1,48}$/.test(error.syscall) ? { syscall: error.syscall } : {}),
        ...(isError && typeof error.message === "string" ? { message: sanitize(error.message, 1200) } : {}),
        ...(isError && typeof error.stack === "string" ? { stack: sanitize(error.stack.split("\n").slice(1, 7).join("\n"), 2400) } : {}),
      },
    }
    const line = Buffer.from(`${JSON.stringify(entry)}\n`)
    if (logSize(path) + line.length > maxLogBytes) rotate(path)
    const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0)
    const fd = openSync(path, flags, 0o600)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid())) throw new Error("Unsafe error log file")
      if (stat.mode & 0o077) fchmodSync(fd, 0o600)
      let offset = 0
      while (offset < line.length) offset += writeSync(fd, line, offset, line.length - offset)
    } finally {
      closeSync(fd)
    }
  } catch {
    try { process.stderr.write("Habit Memory error log could not be written\n") } catch {}
  }
}

export async function withCommandErrorLog(command, phase, operation) {
  try {
    return await operation()
  } catch (error) {
    logCommandError(command, phase, error)
    throw error
  }
}
