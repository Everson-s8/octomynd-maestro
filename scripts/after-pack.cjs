const fs = require("node:fs");
const path = require("node:path");

/**
 * Embed the same OctoMark used by the dashboard into the Windows executable.
 *
 * electron-builder's built-in resource editor also tries to initialize the
 * Windows code-signing bundle. The public build is intentionally unsigned, so
 * use the standalone rcedit package during afterPack instead.
 */
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;

  const projectRoot = context.packager.projectDir;
  const executable = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.exe`
  );
  const icon = path.join(projectRoot, "build", "maestro.ico");

  for (const file of [executable, icon]) {
    if (!fs.existsSync(file)) {
      throw new Error(`[maestro-brand] Required file is missing: ${file}`);
    }
  }

  const rcedit = require("rcedit");
  await rcedit(executable, {
    icon,
    "version-string": {
      FileDescription: context.packager.appInfo.productName,
      ProductName: context.packager.appInfo.productName,
      LegalCopyright: context.packager.appInfo.copyright || "Copyright © Octomynd"
    }
  });
  process.stdout.write(`[maestro-brand] Embedded OctoMark in ${path.basename(executable)}\n`);
};
