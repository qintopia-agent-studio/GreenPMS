# 已确认计价案例

本目录的 7 个 JSON 案例来自用户已确认业务事实：

| 文件 | 证据 |
|---|---|
| `01-transient-six-night-boundary.json` | 6 夜为临住、P1、政策生效日与跨月不拆 |
| `02-weekly-reschedule-boundary.json` | 未入住订单从 7 夜调整为 6 夜后按完整新区间重选档 |
| `03-monthly-extension-boundary.json` | 29→30 夜累计续住并接受跳档下降 |
| `04-custom-cross-month-move.json` | 连续跨月、跨产品换房、统一 14 夜档与最终一次舍入 |
| `05-fixed-term-partial-member.json` | 具体 coverageSet 与 7 个未覆盖日期逐日 P1 |
| `06-rolling-manual-target.json` | 政策基础价、指定最终价与反推 adjustment |
| `07-free-cross-month.json` | 免费住宿跨月仍为 0 且不使用会员权益 |

案例必须通过 `../pricing-case.schema.json`，并由生产领域执行器复算。不要把 expected 值直接回传作为执行结果，不要加入未核定临时值或历史兼容伪值。
