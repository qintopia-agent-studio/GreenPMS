# 日常业务统一 API 验证清单

本清单对应 2026-11-06 的日常业务 API 检查，适用现有普通员工的 30 类命令。验证使用本机合成数据、Bearer Token 和受限 `qintopia_runtime` 数据库角色；不要求特定外部智能体，不代表生产功能开关、真实对话或人工验收已通过。

本轮 19 个 HTTP 场景已分批通过（会员 4、资金 5、住宿 7、维修 3），未发现需要追加修改业务实现的同类缺陷。所有结果均来自上述测试条件，不扩大为全部业务分支或生产性能已验收。

## 验证方法

四组 HTTP 契约测试使用[公共测试 helper](../../tests/helpers/business-api.ts)，每次成功办理均核对：

1. 预览返回 `PREVIEW:<命令>`，目标业务状态不变；同键重放预览与回查仍为预览。
2. 正式提交返回对应业务命令身份，成功回执与预览不同；具体业务用例另核对权威读取和数据库不变量。
3. 原 Confirm 幂等键重放、按原键查询结果、查询命令和回执，均取得同一正式结果，不重复影响业务。
4. 正式提交后再读取预览的回执，仍保持预览身份。

测试刻意执行多次回查来验证协议；正常客户端应按[连续办理路径](agent-command-protocol.md#连续办理与耗时排查)执行，无须复制这些测试调用次数。`app.inject` 穿过真实 HTTP 参数校验、权限、序列化与业务处理，未覆盖网络、代理、模型及消息投递延迟。

## 30 类命令逐项映射

| 命令 | 核对的业务结果 | HTTP 用例 |
| --- | --- | --- |
| `CREATE_MEMBER` | 新档案可读，无虚构合同或权益 | 会员 |
| `CREATE_MEMBERSHIP_ORDER` | 待生效订单和成交价快照 | 会员 |
| `RECORD_MEMBERSHIP_PAYMENT` | 实收事实与总额 | 会员 |
| `CORRECT_MEMBERSHIP_PAYMENT` | 原记录保留，追加冲销及替代收款 | 会员 |
| `ACTIVATE_MEMBERSHIP_ORDER` | 差额按既有规则处理，合同和权益只生成一次 | 会员 |
| `CANCEL_MEMBERSHIP_ORDER` | 空白单作废；已有收款拒绝取消 | 会员 |
| `CORRECT_MEMBER_ENTITLEMENT_BALANCE` | 余额纠正追加台账，原权益总量保留 | 会员 |
| `CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP` | 住宿款转入、补款与已消费间夜一致，不重复计钱 | 会员 |
| `CREATE_ORDER` | 唯一订单、住宿安排及库存 | 住宿、资金、会员 |
| `MANAGE_ORDER_OCCUPANTS` | 同住人增删，价格与库存不变 | 住宿 |
| `RESCHEDULE_STAY` | 同一订单改期，旧库存释放、新日期占用 | 住宿 |
| `EXTEND_STAY` | 新离店日期和延长的库存区间 | 住宿 |
| `SHORTEN_STAY` | 缩短日期和剩余库存，保持在住状态 | 住宿 |
| `MOVE_UNIT` | 历史房间保留，生效日起切换目标房间 | 住宿 |
| `REPRICE_ORDER` | 当前合同金额变化，库存与收退款事实不变 | 住宿 |
| `CANCEL_ORDER` | 取消状态、释放库存，不自动生成退款 | 住宿、资金 |
| `MARK_NO_SHOW` | 时间门槛后标未到、释放库存，无入住事实 | 住宿 |
| `REVOKE_CHECK_IN` | 明确未使用后撤销，保留原入住证据 | 住宿 |
| `CHECK_IN` | 订单与 Stay 进入在住状态 | 住宿、会员 |
| `CHECK_OUT` | 退房与完成状态、履约记录及库存释放 | 会员；既有退房回归 |
| `COMPLETE_STAY` | 明确实际完成后补齐一次入住和退房履约 | 住宿 |
| `RECORD_COLLECTION` | 合付分配金额及订单资金事实 | 资金、会员 |
| `RECORD_REFUND` | 普通及成组退款、来源关联、金额上限 | 资金 |
| `REVERSE_FACT` | 追加冲正并释放对应分配，保留历史 | 资金 |
| `RETAIN_ORDER_FUNDS` | 留存额度，不增加现金收款 | 资金 |
| `APPLY_RETAINED_FUNDS` | 授权使用、内部划转和剩余额度 | 资金 |
| `RELEASE_RETAINED_FUNDS` | 释放留存额度，不冒充退款 | 资金 |
| `REFUND_RETAINED_FUNDS` | 关联成功退款及留存余额 | 资金 |
| `LOCK_MAINTENANCE` | 床位占用及父房互斥，无住宿或资金事实 | 维修 |
| `RELEASE_MAINTENANCE` | 完整释放区间，保留维修历史 | 维修 |

测试文件：[会员](../../tests/contract/daily-membership-api.contract.test.ts)、[资金](../../tests/contract/daily-finance-api.contract.test.ts)、[住宿](../../tests/contract/daily-stay-api.contract.test.ts)、[维修](../../tests/contract/daily-maintenance-api.contract.test.ts)、[既有退房回归](../../tests/contract/command-receipt-identity.contract.test.ts)。

负向场景包括：只读身份、提交前撤销命令权限、缺少业务确认、错误效果哈希、付款/库存/余额变化导致预览陈旧、超额退款、重复冲正、尚未到未入住处理时限、追溯缩短和主要入住人删除。既有[智能体 HTTP 核心流程](../../tests/contract/agent-core-journey.contract.test.ts)继续覆盖活动提交的 `UNKNOWN` 与原身份恢复；不为每个业务命令重复同一并发测试。

## 依据与边界

会员依据 [2A 建档](../implementation/spec-step-2a-member-directory.md)、[2B 会员订单](../implementation/spec-step-2b-membership-orders.md)、[2C 余额与住宿](../implementation/spec-step-2c-member-balances-and-stays.md)及[空白单取消](../implementation/spec-cancel-empty-membership-order.md)；资金依据[分配和留存](../implementation/spec-payment-allocation-retained-funds.md)与[退款对账](../implementation/spec-refund-business-reconciliation.md)；维修依据[维修边界](../implementation/spec-step-3-stage-6-maintenance-boundary.md)。住宿日期、换房、生命周期和同住人沿用已确认开发与验收计划。

本轮不改变权限、计价、资金、库存和生命周期规则。资金分配用例显式启用对应功能，仅说明启用时的行为；不声明生产已开启。房源配置、账号管理、删除会员和模型配置的既有 SESSION 限制、清洁流程关闭、内部派生命令不可人工授权均保持原状。管理员专属纠错也不属于这 30 类普通员工命令的逐项验收范围。

人工业务验收与真实对话记录见[主验收计划](../../待开发项/QinTopia-PMS-分步开发与人工验收计划.md)。一次成功退房不能证明其他业务已人工通过；本轮自动验证也不能解释某个外部智能体的耗时。
