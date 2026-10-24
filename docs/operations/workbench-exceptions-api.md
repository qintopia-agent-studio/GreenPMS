# 工作台异常只读 API

依据：[已确认实施规格](../implementation/spec-workbench-actionable-exceptions.md)。接口与工作台页面读取同一套服务端判断，供有门店读取权限的外部客房智能体核对异常。交付实现不表示已发布或外部智能体已接入；本轮不新增内置助手查询工具。

## 请求与权限

`GET /api/v1/workbench/exceptions?propertyId=<property-id>&limit=50`

沿用现有会话或 `Authorization: Bearer <token-secret>` 认证，须有指定门店的 `READ` 权限。跨门店和失效凭证仍由既有鉴权拒绝；接口不授予退款、留存、入住、取消或纠错写权限。不得将 Token 写入 URL、截图或日志。

| 参数 | 含义 |
| --- | --- |
| `propertyId` | 必填，查询的门店 ID；切换门店后重新从第一页读取 |
| `limit` | 每页数量，默认 50，范围 1–100 |
| `afterId` | 可选，下一页传上一页的 `nextCursor`；首次不传 |

结果按 `orderId` 升序分页；`nextCursor: null` 表示本次查询没有下一页。不要用 `items.length`、订单搜索前 20 条或已加载的页数推断全店异常总数。跨页查询期间事实可能变化，刷新时从第一页重新核对，不把多次请求视为冻结的业务快照。

## 响应

类型定义：`packages/contracts/src/workbench.ts`。以下为合成示例，不含生产订单：

```json
{
  "propertyId": "00000000-0000-4000-8000-000000000001",
  "businessDate": "2026-10-24",
  "asOf": "2026-10-24T12:00:00.000Z",
  "totalOrders": 1,
  "items": [
    {
      "orderId": "00000000-0000-4000-8000-000000000002",
      "orderStatus": "CANCELLED",
      "stayStatus": "CANCELLED",
      "guestName": "合成住客",
      "arrivalDate": "2026-10-20",
      "departureDate": "2026-10-21",
      "unitLabel": "合成房间",
      "orderHref": "/orders/00000000-0000-4000-8000-000000000002",
      "reasons": [
        {
          "code": "REFUND_DUE",
          "category": "FUNDS",
          "message": "应退未退",
          "amount": { "currency": "CNY", "minorUnits": 40000 }
        }
      ]
    }
  ],
  "nextCursor": null
}
```

- `businessDate` 是门店当前营业日；逾期判断以此为准，不采用调用方时区或页面正在浏览的历史日期。
- `asOf` 是此次查询的时间；`totalOrders` 是当前门店全部异常订单数，不是当前页条数，也不是异常原因数。
- 每个订单只出现一次；`reasons` 保留该单全部原因。`unitLabel` 和 `stayStatus` 可为 `null`，不能补猜未知房间或住宿状态。
- `code` 用于稳定识别，`category` 用于分组，`message` 用于解释。优先展示服务端消息，不能只凭取消状态编造异常理由。
- `amount` 是该原因的相关金额，采用币种与整数最小单位；示例 `40000` 分为 400.00 元。无适用金额时为 `null`，不等同于 0 元。多个原因的金额可能重叠，不相加当作应收或应退总额。
- `orderHref` 为查看订单入口，后续处理沿用现有页面及权限，不自动执行任何业务命令。

## 原因与核对方向

| 原因代码 | 含义及核对方向 |
| --- | --- |
| `OVERDUE_ARRIVAL` | 超过到店日仍预订，核对实际到店与后续处理 |
| `OVERDUE_DEPARTURE` | 超过离店日仍在住，核对实际退房或续住；当天待退不是逾期 |
| `BALANCE_DUE` | 当前应收不足，核对收款和资金分配 |
| `OVERPAYMENT` | 多收待处理，核对退款或符合条件的留存 |
| `REFUND_DUE` | 取消、未到或撤销入住后有未处理多余资金 |
| `CHANNEL_REFUND_DUE` | 渠道应结减少或取消后仍有未退经营净额，核对平台退款及登记 |
| `CHANNEL_AMOUNT_MISMATCH` | 渠道应结与已登记经营净额不一致，核对成交、更正与退款 |
| `CHANNEL_DATA_REVIEW` | 渠道资料缺项或未初始化，不能按 0 元解释 |
| `FUNDS_INCONSISTENT` | 资金或留存事实不一致，按消息核对来源和可用份额 |
| `LIFECYCLE_INCONSISTENT` | 订单与住宿状态不一致，核对履约事实 |
| `INVENTORY_NOT_RELEASED` | 终态仍残留有效库存占用 |
| `COVERAGE_NOT_RELEASED` | 终态仍残留未释放的预留会员权益 |

`category` 取 `FULFILLMENT`（履约）、`FUNDS`（资金）、`INVENTORY`（占用）或 `DATA`（资料）；以返回值为准。

正常取消或已标记未到本身不构成异常。普通订单资金核对包含退款、冲销、内部划转和有效剩余留存；客户已确认并登记的正常剩余留存不报异常。取消后净收 600 元、剩余留存 200 元，应退未退为 400 元；解除留存并未退款，未退部分重新待处理。不能靠留存掩盖少款或不一致事实。

渠道订单按渠道应结和经营事实核对，不能把普通收款为 0 判成欠款。已登记全额渠道退款且净额为 0 不报渠道退款待处理，但 PMS 登记不独立证明支付平台已到账。历史渠道订单若仍有普通收退款或留存余额，另报 `FUNDS_INCONSISTENT`，不与渠道账抵销。资金和资料异常跨原住期持续，处理事实完成后重新查询才消失。

请求失败、无权限、后续页尚未加载都不能解释成“没有异常”。保留明确的失败或未完成状态，再按已返回游标重试；需要完整名单时成功读完所有页。只有查询成功且 `totalOrders` 为 0 才可报告“当前 PMS 查询未发现异常”，不能扩大为外部资金到账、人工验收或所有经营事实均已核实。
