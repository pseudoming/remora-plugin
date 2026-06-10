# 子智能体协同与探活机制指南

本指南记录了 Remora 插件在主-子智能体协同、运行期探活以及心跳超时延期方面的架构设计与技术规范。

---

## 1. 主-子智能体协同与探活机制 (Subagent Collaboration & Liveness)

为应对长链路调试和高风险操作，Remora 采用了主-子代理分离的协同设计：
- **主代理 (Coordinator)**：充当协调者与决策审批者，不直接运行高风险的写或测试命令。
- **子代理 (Diver / Extractor)**：在分支隔离沙盒中运行具体任务，并向主代理进行状态上报。

### 1.1 动态制导与安全锚点保护 (Strong Payload)
- 主代理派发任务时，必须通过 **Strong Payload** 方式进行强力约束：
  1. 明确要求执行前的**物理文件核验**（防止盲写和臆想）。
  2. 显式设定**安全锚点禁止降级**（如 `safety-policy.ts` 是不可动摇 of 系统常数，如遇冲突必须立刻快速失败 `[ANCHOR_VIOLATION]`）。
  3. **环境缺失 Fail-Fast**：如限制缺失 `npm`、`node` 等核心工具，禁止在沙盒中尝试进行全局重装，应立即熔断退出。

### 1.2 主代理心跳延期与防假死探活规范 (Timer Rollover Protocol)
为防止后台子特工空转/假死导致主代理失联，主代理使用以下时序进行 **Timer Rollover** 闭环维护：

1. **首次挂载 (Register)**：
   主特工在启动 `invoke_subagent` 后，**同步**调用 `schedule` 工具注册一个 180s 的一次性防假死定时器，并将 TaskId 写入状态文件（`~/.gemini/config/plugins/remora-plugin/data/.runtime/active_timer_task_id.txt`）。
2. **主动上报延期 (Rollover)**：
   当被动接收到子特工主动推送的 `progress_report` 并唤醒主特工时：
   - 读取状态文件，调用 `manage_task` (Action: 'kill') **物理取消**上一次的超时闹钟。
   - 重新调用 `schedule` 注册一个全新的 180s 定时检查，并将新 TaskId 覆盖写入文件，从而实现心跳在健康工作时的**向后顺延**，避免多余的唤醒。
3. **完成时注销 (Eviction)**：
   收到 `final_report` 或任务回执时，主特工读取状态文件 TaskId 并物理 kill 该定时器，注销状态，宣告本轮任务完美闭环收敛。
