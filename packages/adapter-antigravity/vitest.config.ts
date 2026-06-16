import { defineConfig } from "vitest/config";
import * as path from "node:path";

export default defineConfig({
	resolve: {
		alias: {
			"@remora/core": path.resolve(__dirname, "../core/src"),
		},
	},
	test: {
		include: ["tests/**/*.test.ts"],
		setupFiles: ["tests/vitest.setup.ts"],
	},
});
