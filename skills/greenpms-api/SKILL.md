---
name: greenpms-api
description: 通过 Green PMS API 办理住宿、会员、收退款登记和维修等日常业务。用于员工对话办理、查询办理结果或恢复超时操作；使用固定脚本完成预览、正式提交与业务回读。
metadata:
  version: "1.0.0"
  hermes:
    required_environment_variables:
      - GREENPMS_BASE_URL
      - GREENPMS_API_TOKEN
      - GREENPMS_PROPERTY_ID
---

# Green PMS 对话办理

员工说清业务需求后，连续完成 API 办理；只在对象不明、缺少业务事实或出现新的风险决定时追问。任何模型和运行时都使用同一套 API，权限由 Key 对应的身份、门店、命令上限及当前服务端规则决定。既有门店职责和业务授权要求继续适用。

## 使用固定执行器

使用本 Skill 的 `scripts/greenpms.py`，不要每次重写 `python -c`、requests 或 curl 流程。先从 Skill 加载结果取得绝对 `skill_dir`，以下记为 `$SKILL_DIR`；不要假定 terminal 当前目录就是 Skill 或 Profile 目录。

连接读取现有 `GREENPMS_BASE_URL`、`GREENPMS_API_TOKEN`、`GREENPMS_PROPERTY_ID`。不打印 Token、认证头或凭据文件，不把它们写入请求输入、状态文件和对话。在 Hermes 中先加载本 Skill，再通过 terminal 运行；另一种执行工具缺少变量不代表原 Profile 未配置。

```bash
python3 "$SKILL_DIR/scripts/greenpms.py" --help
python3 "$SKILL_DIR/scripts/greenpms.py" me
python3 "$SKILL_DIR/scripts/greenpms.py" schema CHECK_OUT
```

首次接入或权限变化时用 `me` 确认门店和可用命令；不在每次办理前依次重读 version、OpenAPI、me、meta。已知命令沿用已核实契约，参数不清楚或契约变化时再用 `schema 命令` 精简查看。当前 API 契约与实时业务查询优先于历史聊天和本 Skill 示例。

## 正常办理

1. **定位准确对象。** 通过 API 查明门店、唯一订单/会员/房源、当前状态、营业日及必要业务事实。房号可能对应多个历史订单；不要取列表第一条。查询路径和日期口径见 [业务索引](references/business.md)。
2. **预览。** 为本次办理分配一个私有状态文件，记住其路径。脚本先持久化本次身份和两阶段幂等键，再请求预览；不要只把状态保存在模型上下文中。检查 effect 的对象、日期、金额、库存、权益及其他影响。
3. **必要时对话确认。** 原指令已覆盖对象、动作和全部必要事实、预览也没有新影响时，直接继续。需要确认时只问尚未确定的内容。`--confirmed` 表示这些条件已满足，不要求员工再说一次“你执行”；也不能凭此替人确认未使用房间、实际完成住宿、真实付款或款项归属。
4. **正式提交并回读。** 使用原状态文件、真实办理原因和正确回读地址执行 `commit`。脚本会保存 Confirm 身份，正式成功后可在同一次工具调用内读取业务对象。检查对应命令的结果标准后再报告完成。

已知唯一订单的普通退房例子（替换示例 ID，金额和日期仍以实时结果为准）：

```bash
TASK_STATE="${XDG_STATE_HOME:-$HOME/.local/state}/greenpms-api/checkout-example.json"
python3 "$SKILL_DIR/scripts/greenpms.py" get /api/v1/orders/order_example \
  --fields order.id,order.status,order.current_unit_code,stay.status,currentSegment,effectiveArrangement,fulfillment,amounts,occupants.nickname
python3 "$SKILL_DIR/scripts/greenpms.py" prepare CHECK_OUT \
  --input '{"orderId":"order_example"}' --state "$TASK_STATE"
```

预览里的 `commandType=PREVIEW:CHECK_OUT` 只表示预览已保存。即使 `EXECUTED` / `businessCommitted=true`，订单也还没有退房。核对效果并满足业务授权后：

```bash
python3 "$SKILL_DIR/scripts/greenpms.py" commit --state "$TASK_STATE" \
  --reason '{"code":"CHECK_OUT","note":"同事明确要求对该订单办理当天正常退房，预览无额外影响"}' \
  --confirmed --readback '/api/v1/orders/{result.orderId}'
```

状态文件名是例子；实际按本次请求分配唯一文件名，创建一次后沿用，同一状态不能复用于另一笔业务。不要用新的状态路径规避超时或重复办理保护。原因应忠实概括已确认的事实，不照抄示例伪造确认；API 没有通用的“必须另用中文确认原因”门槛。

退房成功需同时满足：正式回执 `CHECK_OUT / EXECUTED / businessCommitted=true`，目标订单 ID 一致；回读 `order.status=CHECKED_OUT`、`stay.status=COMPLETED`，且 `fulfillment.checkOut` 存在并与本次办理吻合。`factRefs` 为空不代表失败。其他命令按[业务索引](references/business.md)核对自己的状态、金额、事实或库存，不套用退房字段。

## 超时、失败与恢复

- 工具显示 Running、HTTP 200、预览成功、已经发送请求，都不等于业务完成。脚本输出的正式提交结果与业务回读分开判断；回读失败时告知“提交结果已取得，业务结果待核实”。
- 正式提交超时、断连或返回 UNKNOWN：保留原状态文件，运行 `recover --state 原路径`。不要换键、建新状态文件或重新预览来绕过未知结果。脚本不会在不确定状态下盲目再提交。
- 预览请求丢响应时，用相同命令、输入和状态文件再次 `prepare`，重放原 Preview 键；预览与正式 Confirm 身份不可混用。报价用 `quote` 的单阶段身份，不表示建单。
- `PREVIEW_STALE`、权限不足或业务拒绝：先解释真实阻塞原因。确认旧尝试确定未执行后，才根据当前授权建立新的办理尝试；重新预览有实质变化时，只确认变化部分。
- `resolve` 是显式结果恢复步骤，不是新业务办理。使用条件和返回判断见 [恢复与回执](references/recovery.md)。不要无限循环；一次查询仍未知时保留身份，告知同事待核实，再进行有依据的后续查询。
- 正常成功已有正式回执和业务回读，不重复遍历 commands、receipts、command-results。排查延迟可看脚本的请求耗时；模型/工具等待、人工等待、网络及消息投递须分开记录，不能把群聊 Running 文案当作 API 故障证据。

## 业务表达

向同事简短反馈“房号｜昵称、已办理动作、金额或日期变化、仍待处理事项”。昵称从对应订单取得，不用当前房客替代历史订单客人。日常回复不堆技术枚举、路径或回执号；排错或用户索要时再提供。保留现有门店的展示和运营口径。

报价不等于订房；登记收退款不证明外部资金到账；取消/改价不自动退款。必要事实和风险确认可以在对话中完成，不要求员工跳回 PMS UI。服务端拒绝、尚未启用功能、SESSION 专属管理操作和令牌管理不靠此 Skill 绕过。
