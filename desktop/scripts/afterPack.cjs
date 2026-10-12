// electron-builder never copies a node_modules directory through extraResources, and the daemon needs its own
// (resolveCodexAcpBin resolves ../../../node_modules from src/). Runs before the app is signed, so the signature
// covers it.
const { cpSync } = require("node:fs")
const { join } = require("node:path")

exports.default = async function afterPack(context) {
  const resources = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
  cpSync(join(__dirname, "..", "build", "bridge", "node_modules"), join(resources, "bridge", "node_modules"), {
    recursive: true,
    verbatimSymlinks: true,
  })
}
