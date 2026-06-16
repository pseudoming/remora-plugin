import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { runTopicGarbageCollection, setTraceId } from "@remora/core";

export function runGarbageCollection(conn?: Database.Database): void {
	runTopicGarbageCollection(conn);
}

export function main(): void {
	setTraceId(`c_${randomUUID().slice(0, 8)}`);
	runGarbageCollection();
}
