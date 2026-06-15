import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as child_process from "child_process";
import * as fs from "fs";
import { handleRequest, resetPreFlightState } from "../src/mcp/git-mcp";

// Mock child_process and fs, to simulate different environment conditions
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof child_process>();
  return {
    ...actual,
    exec: vi.fn(),
    execSync: vi.fn(),
    spawn: vi.fn()
  };
});

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    existsSync: vi.fn()
  };
});

describe("Git MCP Server", () => {
  let stdoutWriteSpy: any;
  let stderrWriteSpy: any;
  let mockExec: any;
  let mockExecSync: any;
  let mockSpawn: any;
  let mockExistsSync: any;

  beforeEach(() => {
    stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    
    mockExec = vi.mocked(child_process.exec);
    mockExecSync = vi.mocked(child_process.execSync);
    mockSpawn = vi.mocked(child_process.spawn);
    mockExistsSync = vi.mocked(fs.existsSync);

    // Default mock behavior: Git is installed and repo is valid
    mockExecSync.mockReturnValue(Buffer.from("git version 2.40.0"));
    mockExistsSync.mockReturnValue(true);
    mockExec.mockImplementation((cmd: string, cb: any) => {
      cb(null, "true\n");
    });

    resetPreFlightState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns available tools list when in a valid Git repository", async () => {
    handleRequest({
      jsonrpc: "2.0",
      method: "tools/list",
      id: 42
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(stdoutWriteSpy).toHaveBeenCalled();
    const lastWrite = stdoutWriteSpy.mock.calls[0][0];
    const response = JSON.parse(lastWrite);
    
    expect(response.id).toBe(42);
    expect(response.result.tools).toHaveLength(5);
    expect(response.result.tools.map((t: any) => t.name)).toContain("git_status");
    expect(response.result.tools.map((t: any) => t.name)).toContain("git_commit");
  });

  it("returns RPC error on tools/call if git is not installed in the system PATH", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("ENOENT: command not found");
    });

    handleRequest({
      jsonrpc: "2.0",
      method: "tools/call",
      id: 43,
      params: { name: "git_status" }
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(stderrWriteSpy).toHaveBeenCalledWith(expect.stringContaining("ERROR: git executable not found"));
    
    const lastWrite = stdoutWriteSpy.mock.calls[0][0];
    const response = JSON.parse(lastWrite);
    expect(response.id).toBe(43);
    expect(response.error.code).toBe(-32603);
    expect(response.error.message).toContain("Git operations are unavailable");
  });

  it("returns RPC error on tools/call if cwd is not a git repository", async () => {
    mockExistsSync.mockReturnValue(false);

    handleRequest({
      jsonrpc: "2.0",
      method: "tools/call",
      id: 44,
      params: { name: "git_status" }
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(stderrWriteSpy).toHaveBeenCalledWith(expect.stringContaining("WARNING: .git folder not found"));
    
    const lastWrite = stdoutWriteSpy.mock.calls[0][0];
    const response = JSON.parse(lastWrite);
    expect(response.id).toBe(44);
    expect(response.error.code).toBe(-32603);
    expect(response.error.message).toContain("Git operations are unavailable");
  });

  it("executes git_status tool successfully through spawn", async () => {
    const mockProc = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn()
    };
    mockSpawn.mockReturnValue(mockProc);

    handleRequest({
      jsonrpc: "2.0",
      method: "tools/call",
      id: 45,
      params: { name: "git_status" }
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockSpawn).toHaveBeenCalledWith("git", ["status"]);
    
    const stdoutCallback = mockProc.stdout.on.mock.calls[0][1];
    stdoutCallback(Buffer.from("On branch master\n"));
    
    const closeCallback = mockProc.on.mock.calls.find((call: any) => call[0] === "close")[1];
    closeCallback(0);

    expect(stdoutWriteSpy).toHaveBeenCalled();
    const lastWrite = stdoutWriteSpy.mock.calls[0][0];
    const response = JSON.parse(lastWrite);
    expect(response.id).toBe(45);
    expect(response.result.content[0].text).toContain("On branch master");
  });

  it("handles initialize request and returns correct protocol version and capabilities", async () => {
    handleRequest({
      jsonrpc: "2.0",
      method: "initialize",
      id: 46,
      params: { protocolVersion: "2024-11-05" }
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(stdoutWriteSpy).toHaveBeenCalled();
    const lastWrite = stdoutWriteSpy.mock.calls[stdoutWriteSpy.mock.calls.length - 1][0];
    const response = JSON.parse(lastWrite);
    expect(response.id).toBe(46);
    expect(response.result.protocolVersion).toBe("2024-11-05");
    expect(response.result.capabilities.tools).toEqual({});
    expect(response.result.serverInfo.name).toBe("remora-git-mcp");
    expect(response.result.serverInfo.version).toBe("1.0.0");
  });

  it("handles notifications/initialized request without error or response", async () => {
    stdoutWriteSpy.mockClear();

    handleRequest({
      jsonrpc: "2.0",
      method: "notifications/initialized"
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(stdoutWriteSpy).not.toHaveBeenCalled();
  });
});
