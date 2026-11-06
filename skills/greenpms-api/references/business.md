# 业务索引：按意图选择 API，再核对真实结果

以下是路由和结果核对清单，不代替当前 OpenAPI 的必填参数。参数不明确时用 `schema COMMAND`；不猜 ID、日期、金额、流水、会员产品或业务确认事实。

## 查询

| 目的 | 路径与注意点 |
| --- | --- |
| 身份、门店和有效命令 | `GET /api/v1/me`；按目标物业读取 `propertyAccess`、`allowedActions` |
| 房号定位住宿订单 | `GET /api/v1/orders?propertyId=…&query=…`；使用历史列表分页核实唯一订单。房号匹配后再核当前房间、住客和状态 |
| 某营业日的工作列表 | 同一路径使用 `workDate=YYYY-MM-DD`；不得混用 history filters、`pageSize`、`beforeId`。列表不是当天实际履约事件账 |
| 单个订单权威详情 | `GET /api/v1/orders/{orderId}`；看当前安排、订单/Stay 状态、履约、资金事实与金额 |
| 会员定位与详情 | `GET /api/v1/members?propertyId=…&query=…`；`GET /api/v1/members/{memberId}?propertyId=…` |
| 维修前后库存 | `GET /api/v1/properties/{propertyId}/availability?arrivalDate=…&departureDate=…`；维修床位和父房互斥，区间左闭右开 |
| 房态详情 | `GET /api/v1/properties/{propertyId}/room-status?arrivalDate=…&departureDate=…`；最多30天、按分页完整性读取。普通占用 conflicts 不直接代表双订 |
| 外部流水分配/留存资金 | `GET /api/v2/external-payments?propertyId=…`、`GET /api/v2/retained-funds?propertyId=…`；先核功能开关、来源与归属 |
| 独立资金事实 | `GET /api/v1/facts/{factId}`；核对类型、订单、金额、来源及冲销/退款关系 |

首次需要房源、会员产品、定价策略等参考 ID 时读取 `/api/v1/meta` 的相应部分。引用用户提供的对象前仍须核对当前可见范围。金额使用整数分；日期按门店 timezone/businessDate，不以会话起始日期代替今天。完整列表需处理其实际分页协议；查询失败不是空列表。

## 住宿

| 意图 | 命令与结果 |
| --- | --- |
| 报价和建单 | `quote` 执行 `CREATE_QUOTE`，再以 quoteId `CREATE_ORDER`；成功后读取新 orderId、日期、房源、金额和状态 |
| 入住/普通退房 | `CHECK_IN` → CHECKED_IN/IN_HOUSE 和入住事实；`CHECK_OUT` → CHECKED_OUT/COMPLETED 和退房事实。日期/状态不符时依服务端反馈处理，不用普通退房代替缩住 |
| 预订改期/续住/缩住 | `RESCHEDULE_STAY` / `EXTEND_STAY` / `SHORTEN_STAY`；同一订单的新日期、当前计价和生效库存。缩住不等于已经退房 |
| 换房 | `MOVE_UNIT`；核对生效日后的目标房间、此前历史安排和金额/权益变化 |
| 同住人 | `MANAGE_ORDER_OCCUPANTS`；核对增删目标和人数，主要入住人不可作为普通同行人删除 |
| 调价 | `REPRICE_ORDER`；确认授权的目标金额，核对当前合同金额；不自动登记收退款 |
| 取消/未到 | `CANCEL_ORDER` / `MARK_NO_SHOW`；核对终止状态和库存释放。未到受门店时间门槛限制，取消不证明钱已退 |
| 撤销误入住 | `REVOKE_CHECK_IN`；必须真实确认未使用房间，再核对撤销状态与保留的原入住记录 |
| 补齐漏记的已完成住宿 | `COMPLETE_STAY`；须确认实际完成事实，回读入住/退房履约都存在且仅一次，不编造实际发生 |

普通建单 Confirm reason 固定为 `{"code":"CREATE_STANDARD_ORDER","note":""}`。历史补录或临时换类安排沿用专属原因和预览锁定说明；`COMPLETE_STAY` 的 reason.code 为 `COMPLETE_STAY`，note 必须与 input.reasonNote 一致。不要对所有建单套用普通原因，也不要用任意字符串试错。

## 会员与资金

| 意图 | 命令与结果 |
| --- | --- |
| 建会员 | `CREATE_MEMBER`；读取准确 memberId；新增档案不自动办卡或赠送权益 |
| 办卡/收款/纠正/激活 | `CREATE_MEMBERSHIP_ORDER`、`RECORD_MEMBERSHIP_PAYMENT`、`CORRECT_MEMBERSHIP_PAYMENT`、`ACTIVATE_MEMBERSHIP_ORDER`；核对会员订单、实收差额、追加纠正记录及合同/权益。差额按现有规则处理，不私自抹平 |
| 取消空白会员单 | `CANCEL_MEMBERSHIP_ORDER`；仅待生效且无任何收款/合同/权益关联的单可取消，核对 VOIDED 和取消记录 |
| 纠正权益余额 | `CORRECT_MEMBER_ENTITLEMENT_BALANCE`；核对当前余额、授权的目标余额及追加台账；旧 expectedAvailableBalance 失效须重新核实 |
| 住宿款转会员 | `CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP`；先核住宿订单、会员、收款来源、会员产品与补款；回读住宿资金、会员资金、已消费和剩余权益，不重复算钱 |
| 住宿收款/退款登记 | `RECORD_COLLECTION` / `RECORD_REFUND`；核对金额、成功外部流水和对应订单份额；回读资金事实及剩余可分配/可退金额。成组补齐按当前 schema，不另补重复收款 |
| 冲正 | `REVERSE_FACT`；确认具体错误事实，核对追加冲正及保留原记录，不将冲正解释为外部退款 |
| 留存/使用/释放/退留存款 | `RETAIN_ORDER_FUNDS`、`APPLY_RETAINED_FUNDS`、`RELEASE_RETAINED_FUNDS`、`REFUND_RETAINED_FUNDS`；确认款项归属和用途授权，核对留存、使用、释放、退款及剩余额度；内部划转不新增现金 |

会员操作一般回读 `/api/v1/members/{已知memberId}?propertyId={门店}`；memberId 可来自原输入或正式结果，不能把 membershipOrderId 当 memberId。资金操作一般回读对应订单、必要资金事实和留存/分配列表；不因净额为0就宣称收退两边均已对平。

## 维修与管理边界

`LOCK_MAINTENANCE` 只锁定房源、日期和原因；正式结果给 maintenanceLockId。`RELEASE_MAINTENANCE` 完整释放对应区间，保留历史。回读该区间库存/房态，核对具体床位和父房互斥变化；不生成住宿人、订单、会员或现金事实。

本 Skill 覆盖现有日常命令，不开放房源配置、账号管理等 SESSION 专属操作，不启用清洁流程，不把内部权益派生命令当可人工办理，也不提供令牌签发/轮换命令。管理员纠错需其真实权限和专属契约，不能通过替换命令或身份规避。
