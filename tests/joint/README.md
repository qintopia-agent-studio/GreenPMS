# PMS / Agent OS 合成联合验收

本工具只在独立本地工作区运行。复用真实 PMS HTTP API/事务/发布 Worker，以及 Agent OS 冻结版的 ingress、Client、Inbox 和 recovery；不实现另一套事件协议。结果与局限见 [验收记录](../../待开发项/PMS-AgentOS-事件联合验收-20260911.md)。

## 前置条件

- Node 22、`npm ci`、Docker、OpenSSL。
- 两个本任务专用容器，映射只允许 loopback；工具核对固定名称、标签和端口后才重置数据库。**重跑会删除这两个专用库中的合成数据**；存在活动连接则拒绝，不会强踢其他进程。
- Agent OS 责任方交付的完整固定清单、副本及 Rust 工具链。不能直接运行其正在修改的活动目录。

首次创建专用容器（不带真实密码，使用仅本机可达的隔离测试认证）：

```sh
docker run --pull=never --name green-pms-joint-pg-20260911 \
  --label qintopia.task=pms-agentos-joint-20260911 \
  -e POSTGRES_USER=qintopia -e POSTGRES_HOST_AUTH_METHOD=trust \
  -e POSTGRES_DB=qintopia -p 127.0.0.1:55442:5432 -d postgres:18
docker run --pull=never --name green-pms-joint-agentos-pg-20260911 \
  --label qintopia.task=pms-agentos-joint-20260911 \
  -e POSTGRES_USER=qintopia -e POSTGRES_HOST_AUTH_METHOD=trust \
  -e POSTGRES_DB=qintopia_test -p 127.0.0.1:55443:5432 -d pgvector/pgvector:pg18
```

已有本任务容器时只需启动它们，不重新创建或换用别的数据库。

## 固定接收端

本次采用 Agent OS v2 清单，SHA256：`56cc9ee18f93eabd6be177f73be7ca523cd5f91f5105e4f63069e59ca05da291`。复制前逐文件核对 `BASELINE.json` 中的路径、字节数和 SHA256；复制到 `/private/tmp/green-pms-joint-agentos-20260911-v2`，不修改源码。工具运行前会再次检查全部文件。

```sh
CARGO_TARGET_DIR=/private/tmp/green-pms-joint-agentos-target \
  cargo build --offline \
  --manifest-path /private/tmp/green-pms-joint-agentos-20260911-v2/runtime/sidecar/Cargo.toml \
  --features welcome-synthetic-driver
```

如果采用责任方交付的新固定版，显式设置 `AGENTOS_JOINT_BASELINE`、`AGENTOS_JOINT_BINARY`、`AGENTOS_JOINT_MANIFEST_SHA256`，并在验收记录中说明修复范围。工具不会替你更新 Agent OS 协议或文件。

## 执行

在本 PMS 独立工作区，用 Node 22 运行：

```sh
PMS_AGENTOS_JOINT_ENABLE=1 \
TEST_DATABASE_URL=postgres://qintopia@127.0.0.1:55442/qintopia_joint_test \
TEST_SUITE_LOCK_DATABASE_URL=postgres://qintopia@127.0.0.1:55442/postgres \
node --import tsx tests/helpers/run-database-test-suite.ts -- \
node --import tsx tests/joint/run.mjs
```

工具依次初始化专用库、启动两端程序、执行测试、停止所有子进程，并恢复 PMS Worker 角色为 NOLOGIN。报告只保存逐项状态、计数、版本和文件 hash 到被忽略的 `latest-result.json`；审核后可把报告复制到文档证据目录。发生失败不标记通过，独立案例继续运行。源码初始化测试复用现有 demo 凭证，仅进程使用，不抄入报告；每轮签名材料新生成，不写文件。

## 测试传输与故障

- PMS API：18442；只读代理：18443；TLS 投递代理：18444；Agent OS ingress：18872，全部 127.0.0.1。
- PMS 使用生产 `integration-worker-main.ts` 和正常 HTTPS 传输，私钥只存在代理内存，临时公有 CA 仅注入该 Worker，结束删除，不修改系统信任，不关闭 TLS 校验。
- Agent OS 使用非默认 `welcome-synthetic-driver` 功能中的 literal-loopback HTTP 读取传输；生产 Client 的 HTTPS 校验保持不变。此项不证明真实部署的 TLS、证书轮换或域名可达性。
- 代理可丢 ACK、断开连接、伪造错误签名、限制真实页大小、制造读取失败/并发屏障及同向量冲突。正常事件/投影来自真实程序；仅指定故障响应被改变，原存储不改写。
- 过期测试只在专用库中事务性调整已真实 ACK 事件的测试时间，恢复不可变触发器后调用真实 prune；没有直接把 pending 状态伪造成 accepted。
- 营业日测试通过 PMS 既有测试时钟包装器重启 API，不改变操作系统/数据库时间。
- 没有真实 Person/群资料、制卡器、上传器或发送适配器。没有录入申请和授权来模拟完整欢迎业务；禁发证据限定为本轮事件、补偿和重建链路。

## 清理与回归

自动清理保留合成数据库，便于诊断。确认测试进程已退出后，可以停止本任务两个容器；不要清理或重置 55432/55433/55439/55440/55441 的既有实例。

PMS 相关回归使用相同测试锁及 55442 实例，库名与联合验收分开：事件专项为 `qintopia_events_joint_regression`；支付 readiness 专项须使用 `qintopia_wecom_` 前缀（如 `qintopia_wecom_joint_regression`）。测试完成前不能同时重置共享 PostgreSQL 角色。
