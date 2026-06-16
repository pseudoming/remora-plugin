import * as readline from "readline";
import { exec, spawn, execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

let gitAvailable: boolean | null = null;

export function resetPreFlightState() {
	gitAvailable = null;
}

function checkGitInstalled(): boolean {
	if (gitAvailable !== null) {
		return gitAvailable;
	}
	try {
		execSync("git --version", { stdio: "ignore" });
		gitAvailable = true;
	} catch (e: any) {
		gitAvailable = false;
		process.stderr.write(
			"[RemoraGitMCP] ERROR: git executable not found in PATH.\n",
		);
	}
	return gitAvailable;
}

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
	terminal: false,
});

rl.on("line", (line) => {
	if (!line.trim()) return;
	try {
		const request = JSON.parse(line);
		handleRequest(request);
	} catch (e: any) {
		process.stderr.write(
			`[RemoraGitMCP] Error parsing request JSON: ${e.message}\n`,
		);
	}
});

rl.on("close", () => {
	process.exit(0);
});

function sendResponse(id: any, result: any, error?: any) {
	const payload: any = {
		jsonrpc: "2.0",
		id,
	};
	if (error) {
		payload.error = error;
	} else {
		payload.result = result;
	}
	process.stdout.write(JSON.stringify(payload) + "\n");
}

function checkGitRepository(callback: (isRepo: boolean) => void) {
	if (!checkGitInstalled()) {
		callback(false);
		return;
	}

	// 物理快速检查：若当前目录连 .git 文件夹都不存在，直接返回 false，免除 exec 损耗
	const cwd = process.cwd();
	const gitPath = path.join(cwd, ".git");
	if (!fs.existsSync(gitPath)) {
		process.stderr.write(
			"[RemoraGitMCP] WARNING: .git folder not found. Current workspace is not a git repository.\n",
		);
		callback(false);
		return;
	}

	exec("git rev-parse --is-inside-work-tree", (err, stdout) => {
		const isRepo = !err && stdout.trim() === "true";
		if (!isRepo) {
			process.stderr.write(
				"[RemoraGitMCP] WARNING: git rev-parse failed. Current workspace is not a git repository.\n",
			);
		}
		callback(isRepo);
	});
}

export function handleRequest(req: any) {
	const { method, id, params } = req;

	if (method === "initialize") {
		const protocolVersion = params?.protocolVersion || "2024-11-05";
		sendResponse(id, {
			protocolVersion,
			capabilities: {
				tools: {},
			},
			serverInfo: {
				name: "remora-git-mcp",
				version: "1.0.0",
			},
		});
	} else if (method === "notifications/initialized") {
		// Safely ignore notifications/initialized method
	} else if (method === "tools/list") {
		sendResponse(id, {
			tools: [
				{
					name: "git_status",
					description: "Get git status of current repository",
					inputSchema: { type: "object", properties: {} },
				},
				{
					name: "git_log",
					description: "Get git commit history log limit 5",
					inputSchema: { type: "object", properties: {} },
				},
				{
					name: "git_checkout",
					description: "Switch branch or restore working tree files",
					inputSchema: {
						type: "object",
						properties: {
							target: {
								type: "string",
								description: "The branch name or file path to checkout",
							},
						},
						required: ["target"],
					},
				},
				{
					name: "git_merge",
					description: "Merge branch changes into current branch",
					inputSchema: {
						type: "object",
						properties: {
							branch: {
								type: "string",
								description: "The source branch name to merge from",
							},
						},
						required: ["branch"],
					},
				},
				{
					name: "git_commit",
					description: "Record staged changes to the repository history",
					inputSchema: {
						type: "object",
						properties: {
							message: {
								type: "string",
								description: "Commit message describing the changes",
							},
						},
						required: ["message"],
					},
				},
			],
		});
	} else if (method === "tools/call") {
		const { name, arguments: toolArgs } = params || {};

		checkGitRepository((isRepo) => {
			if (!isRepo) {
				sendResponse(id, null, {
					code: -32603,
					message: "Git operations are unavailable in this workspace",
				});
				return;
			}

			let gitArgs: string[] = [];
			if (name === "git_status") {
				gitArgs = ["status"];
			} else if (name === "git_log") {
				gitArgs = ["log", "-n", "5"];
			} else if (name === "git_checkout") {
				const target = toolArgs?.target || "";
				if (!target) {
					sendResponse(id, null, {
						code: -32602,
						message: "Missing required argument 'target'",
					});
					return;
				}
				gitArgs = ["checkout", target];
			} else if (name === "git_merge") {
				const branch = toolArgs?.branch || "";
				if (!branch) {
					sendResponse(id, null, {
						code: -32602,
						message: "Missing required argument 'branch'",
					});
					return;
				}
				gitArgs = ["merge", branch];
			} else if (name === "git_commit") {
				const message = toolArgs?.message || "";
				if (!message) {
					sendResponse(id, null, {
						code: -32602,
						message: "Missing required argument 'message'",
					});
					return;
				}
				gitArgs = ["commit", "-m", message];
			} else {
				sendResponse(id, null, {
					code: -32601,
					message: `Method not found: ${name}`,
				});
				return;
			}

			// 使用 spawn 传递 argv 数组，物理阻断命令行拼接注入
			const proc = spawn("git", gitArgs);
			let stdout = "";
			let stderr = "";

			proc.stdout.on("data", (data) => {
				stdout += data.toString();
			});
			proc.stderr.on("data", (data) => {
				stderr += data.toString();
			});

			proc.on("close", (code) => {
				const output = stdout + stderr;
				if (code === 0) {
					sendResponse(id, {
						content: [{ type: "text", text: output }],
					});
				} else {
					// 当退出码不为 0 时（如 git merge 冲突），我们依然返回文本以供大模型进行冲突分析决策
					sendResponse(id, {
						content: [
							{ type: "text", text: `Git exited with code ${code}\n${output}` },
						],
					});
				}
			});

			proc.on("error", (err: any) => {
				sendResponse(id, null, {
					code: -32603,
					message: `Failed to spawn git process: ${err.message}`,
				});
			});
		});
	} else {
		if (id !== undefined) {
			sendResponse(id, null, {
				code: -32601,
				message: `Method not found: ${method}`,
			});
		}
	}
}
