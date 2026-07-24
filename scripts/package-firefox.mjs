import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { spawn } from "node:child_process"

const artifactsDirectory = "dist/firefox"

await rm(artifactsDirectory, { recursive: true, force: true })
await mkdir(artifactsDirectory, { recursive: true })

const command = process.platform === "win32" ? "web-ext.cmd" : "web-ext"
await new Promise((resolve, reject) => {
  const child = spawn(command, ["build", "--source-dir", "firefox", "--artifacts-dir", artifactsDirectory, "--ignore-files", "native-host/**", "native-host/"], {
    stdio: "inherit",
  })
  child.on("error", reject)
  child.on("exit", code => code === 0 ? resolve() : reject(new Error(`web-ext exited with code ${code}`)))
})

const artifacts = (await readdir(artifactsDirectory)).filter(name => name.endsWith(".zip"))
if (artifacts.length !== 1) {
  throw new Error(`Expected one Firefox artifact, found ${artifacts.length}`)
}

const artifactPath = join(artifactsDirectory, artifacts[0])
const checksum = createHash("sha256").update(await readFile(artifactPath)).digest("hex")
console.log(`Firefox artifact: ${artifactPath}`)
console.log(`SHA-256: ${checksum}`)
