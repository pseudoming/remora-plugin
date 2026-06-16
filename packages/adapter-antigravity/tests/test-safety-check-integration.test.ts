import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { main } from "../src/hooks/safety-check";
import * as path from "node:path";
import * as fs from "node:fs";
import { getConn } from "@remora/core";

const DB_PATH = path.join(__dirname, ".test_safety_check_integration.db");

describe("Safety Check Integration Tests", () => {
    let conn: any;

    beforeAll(() => {
        // Set environment variable to force getConn() to use this temporary path
        process.env.REMORA_DB_PATH = DB_PATH;
        
        // Ensure clean state
        if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
        if (fs.existsSync(DB_PATH + "-wal")) fs.unlinkSync(DB_PATH + "-wal");
        if (fs.existsSync(DB_PATH + "-shm")) fs.unlinkSync(DB_PATH + "-shm");

        // Initialize schema
        conn = getConn();
        const schemaPath = path.resolve(__dirname, "../../core/schema/schema.sql");
        const schema = fs.readFileSync(schemaPath, "utf-8");
        conn.exec(schema);

        // Insert some mock data if required by rules, though dynamic rules might not strictly need DB rows to trigger
        conn.exec(`
            INSERT INTO session_state (session_id, updated_at) VALUES ('c1', CURRENT_TIMESTAMP);
        `);
    });

    afterAll(() => {
        if (conn) {
            try {
                conn.close();
            } catch (e) {}
        }
        if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
        if (fs.existsSync(DB_PATH + "-wal")) fs.unlinkSync(DB_PATH + "-wal");
        if (fs.existsSync(DB_PATH + "-shm")) fs.unlinkSync(DB_PATH + "-shm");
        delete process.env.REMORA_DB_PATH;
    });

    it("should return allow for safe view_file", () => {
        const payload = {
            toolCall: {
                name: "view_file",
                args: { AbsolutePath: "/safe/path" }
            },
            isSub: false
        };
        const res = main(payload);
        expect(res).toEqual({ decision: "allow" });
    });

    it("should return deny for dangerous checkRunCommandAuditRule", () => {
        const payload = {
            toolCall: {
                name: "run_command",
                args: { CommandLine: "vitest run" }
            },
            isSub: false
        };
        const res = main(payload) as any;
        expect(res.decision).toBe("deny");
        expect(res.reason).toContain("DELEGATION-BLOCKED"); // "DELEGATION-BLOCKED" is in the reason text
    });
});
