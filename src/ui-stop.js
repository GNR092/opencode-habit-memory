import { stopUiServer } from "./ui-server.js"
import { withCommandErrorLog } from "./error-log.js"

try {
  const stopped = await withCommandErrorLog("npm run ui:stop", "stop-server", () => stopUiServer({ owner: "project" }))
  process.stdout.write(stopped ? "WebUI de Habit Memory detenida.\n" : "La WebUI de Habit Memory no estaba iniciada.\n")
} catch {
  process.exitCode = 1
}
