# PR 与 main 保护

日常修改使用分支和 PR。`main` 禁止直接推送、强制推送和删除；管理员同样需要通过 PR。
PR 至少需要另一位有写权限的成员批准一次，新增代码提交会使旧批准失效；讨论需要解决。
目前允许合并的人只有 `PatrickLiveCool` 和 `noraincode`，不配置绕过 PR 的账号或机器人。

## 创建和合并 PR

1. 从 `main` 创建工作分支并提交代码。
2. 标题使用 `类型: 说明` 或 `类型(范围): 说明`，例如 `fix(orders): 修复订单日期校验`。
   类型包括 `feat`、`fix`、`docs`、`refactor`、`test`、`chore`、`ci`、`perf`、`build`、`revert`。
3. 填写自动提供的三个段落：**改动说明**、**验证结果**、**风险与回退**。没有运行测试时写原因；不涉及运行行为时如实说明，不留模板提示语。
4. 等待 `PR format` 和 `Node and release checks` 通过，请另一位成员批准，再由指定合并人合并。

只有两位协作者时，通常是一人提交、另一人批准并合并。不要求两人同时审批、merge queue、签名提交或每次同步最新 main。

PR 格式和应用 CI 都使用只读 token，不访问生产 Secrets、服务器、COS 或数据库。
格式检查在修改 PR 标题/正文时重新运行；默认 CI 同时重新验证代码，避免因编辑事件取消正在运行的必需检查。
PR 检查执行待审分支代码，因此修改 workflow 或校验脚本本身也必须认真审核；格式检查不能证明正文中的测试结果属实。

## 管理设置

保护配置保存在 [.github/main-protection.json](../.github/main-protection.json)。它记录实际仓库设置，但修改文件不会自动修改 GitHub 权限。
已拥有仓库管理权限的管理员可以在核对现有设置后应用：

```bash
rtk proxy gh api --method PUT repos/qintopia-agent-studio/GreenPMS/branches/main/protection \
  --input .github/main-protection.json
rtk proxy gh api repos/qintopia-agent-studio/GreenPMS/branches/main/protection
```

必需检查绑定 GitHub Actions 的 app ID，不能用其他来源的同名状态替代。配置 `strict: false` 避免两人团队频繁更新分支，合并冲突仍须解决。
GitHub 管理员/组织所有者仍能修改或撤销保护规则；分支规则无法取消其管理权。当前仅这两位成员具有管理权限，新增管理员时应同步复核权限。

本地验证 PR 格式：

```bash
rtk proxy node --test scripts/check-pr-tests.mjs
```
