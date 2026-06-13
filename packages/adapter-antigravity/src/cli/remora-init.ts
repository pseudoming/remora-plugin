#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { setTraceId } from "@remora/core";

function recursiveWalk(dir: string, pattern: RegExp): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...recursiveWalk(fullPath, pattern));
    } else if (entry.isFile() && pattern.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

function initEnvironment(): boolean {
  const pluginDir = path.dirname(path.dirname(path.dirname(path.dirname(__dirname))));
  const configDir = path.join(pluginDir, "..", "..");

  const projectId = "11111111-1111-1111-1111-111111111111";
  const projectsDir = path.join(configDir, "projects");
  const projectFile = path.join(projectsDir, `${projectId}.json`);

  let initialized = false;
  if (!fs.existsSync(projectFile)) {
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.writeFileSync(
      projectFile,
      JSON.stringify(
        {
          id: projectId,
          name: "remora-system",
          projectResources: { resources: [] },
        },
        null,
        2
      )
    );
    initialized = true;
  }

  const configFile = path.join(configDir, "config.json");
  if (fs.existsSync(configFile)) {
    const configData = JSON.parse(fs.readFileSync(configFile, "utf-8"));

    const sidecars = (configData["sidecars"] = configData["sidecars"] ?? {});
    const compactorKey = "remora-plugin/memory-compactor";

    if (!(compactorKey in sidecars)) {
      sidecars[compactorKey] = {
        enabled: false,
        projectId: projectId,
      };
      fs.writeFileSync(configFile, JSON.stringify(configData, null, 2));
      initialized = true;
    }
  }

  if (initialized) {
    const scriptsDir = path.join(pluginDir, "scripts");
    const tsFiles = recursiveWalk(scriptsDir, /\.ts$/);
    const shFiles = recursiveWalk(scriptsDir, /\.sh$/);
    const compactorDir = path.join(scriptsDir, "adapter", "sidecar", "compactor");
    const compactorTsFiles = fs.existsSync(compactorDir)
      ? fs.readdirSync(compactorDir)
          .filter((f) => f.endsWith(".ts"))
          .map((f) => path.join(compactorDir, f))
      : [];

    const allFiles = [...tsFiles, ...shFiles, ...compactorTsFiles];
    for (const filePath of allFiles) {
      const st = fs.statSync(filePath);
      fs.chmodSync(filePath, st.mode | 0o111);
    }
  }

  return initialized;
}

export function main(): void {
  setTraceId(`c_${randomUUID().slice(0, 8)}`);
  initEnvironment();
}

if (typeof require !== "undefined" && require.main === module) {
  main();
}
