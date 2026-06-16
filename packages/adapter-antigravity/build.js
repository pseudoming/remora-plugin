const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

console.log("🔨 Running custom tsup build pipeline...");
execSync("npx tsup --config " + path.join(__dirname, "tsup.config.ts"), {
	stdio: "inherit",
});

// Copy schema.sql to the expected paths in dist
const srcSchema = path.join(__dirname, "src", "schema", "schema.sql");
const destSchemaRoot = path.join(__dirname, "dist", "schema.sql");
const destSchemaSub = path.join(__dirname, "dist", "schema", "schema.sql");

if (fs.existsSync(srcSchema)) {
	fs.mkdirSync(path.dirname(destSchemaSub), { recursive: true });
	fs.copyFileSync(srcSchema, destSchemaRoot);
	fs.copyFileSync(srcSchema, destSchemaSub);
	console.log("📋 Copied schema.sql to dist/ and dist/schema/");
}

console.log("✅ Build successfully completed!");
