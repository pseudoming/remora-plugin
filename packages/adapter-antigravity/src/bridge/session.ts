import { getConn, readMode as coreReadMode } from "@remora/core";

export function readMode(sessionId: string, defaultMode: string = "standard"): string {
  const conn = getConn();
  try {
    return coreReadMode(sessionId, defaultMode, conn);
  } finally {
    conn.close();
  }
}
