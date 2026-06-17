#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
const isPostInstall = argv.includes("--postinstall");
const isDevMonorepo = fs.existsSync(path.resolve(__dirname, "../../core"));
const target = path.join(__dirname, "../dist/install.js");

if (isPostInstall && isDevMonorepo) {
	console.log("ℹ️ [Remora Install] Development Monorepo detected in postinstall. Skipping auto-deploy.");
	console.log("   Please run './deploy.sh' manually to package and install the plugin globally.");
	process.exit(0);
}

if (!fs.existsSync(target)) {
	console.warn("⚠️ [Remora Install] dist/install.js not found. Skipping auto-installation.");
	process.exit(0);
}

if (isPostInstall) {
	process.argv = [process.argv[0], process.argv[1], "--force"];
}

require(target).main();
