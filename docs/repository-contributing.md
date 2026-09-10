# PR 与 main 保护

日常修改使用分支和 PR。`main` 禁止直接推送、强制推送和删除；管理员同样需要通过 PR。
PR 不要求他人批准，格式检查、测试和构建通过且讨论已解决后，作者可以自行合并。
目前允许合并的人只有 `PatrickLiveCool` 和 `noraincode`，不配置绕过 PR 的账号或机器人。

## 创建和合并 PR

1. 从 `main` 创建工作分支并提交代码。
2. 标题使用 `类型: 说明` 或 `类型(范围): 说明`，例如 `fix(orders): 修复订单日期校验`。
   类型包括 `feat`、`fix`、`docs`、`refactor`、`test`、`chore`、`ci`、`perf`、`build`、`revert`。
3. 填写自动提供的三个段落：**改动说明**、**验证结果**、**风险与回退**。没有运行测试时写原因；不涉及运行行为时如实说明，不留模板提示语。
4. 等待 `PR format` 和 `Node and release checks` 通过，解决讨论后，由指定合并人合并；提交者本人也可以合并。

GitHub 不支持作者批准自己的 PR，因此必需审批人数设置为 0，同时保留必须通过 PR 的规则。另一位成员仍可自愿审核；已有批准在新增代码提交后失效，但不要求重新获取批准。无需为了合并自己的 PR 切换账号。

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
