const { execSync } = require('child_process');
console.log("🔨 Running custom tsup build pipeline...");
execSync("npx tsup src/install.ts src/**/*.ts --format cjs --outDir dist --external @remora/core --external better-sqlite3", { stdio: 'inherit' });
console.log("✅ Build successfully completed!");
