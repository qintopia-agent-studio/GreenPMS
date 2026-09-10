# Changelog

每个部署版本使用独立 Git 标签和 GitHub Release，优化说明与升级说明随代码保存。版本规则及发布步骤见 [发布约定](docs/releases/README.md)。

## [1.3.0](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.2.3...v1.3.0) (2026-09-10)


### Features

* automate GreenPMS production releases through private COS ([dcb6b3a](https://github.com/qintopia-agent-studio/GreenPMS/commit/dcb6b3a895c38b84f51c95f8cfa9d7f9680b0b1d))
* automate GreenPMS production releases through private COS ([486b4bf](https://github.com/qintopia-agent-studio/GreenPMS/commit/486b4bf8f7446a1a7336542d0e40e030cbaa5f00))


### CI / Deployment

* allow authors to merge without required approvals ([e0beeb2](https://github.com/qintopia-agent-studio/GreenPMS/commit/e0beeb26189f4ce0d7a76c835ef16cf1acd412fb))
* automate version PR and release tag creation ([1420227](https://github.com/qintopia-agent-studio/GreenPMS/commit/142022776477c505133cffa583dc5bbdfbe7b623))
* automate version PR and release tag creation ([cab1e57](https://github.com/qintopia-agent-studio/GreenPMS/commit/cab1e578dc83651350e010b4897b635bbbba3aae))
* enforce main protection and standard pull requests ([32355e4](https://github.com/qintopia-agent-studio/GreenPMS/commit/32355e45239c145d1f5c39bb970ae59391f1766f))
* enforce main protection and standard pull requests ([9e25378](https://github.com/qintopia-agent-studio/GreenPMS/commit/9e253789a1449e43f281bc024b8eba6fe12015ba))


### Documentation

* **release:** record v1.2.3 deployment ([a0fbdd5](https://github.com/qintopia-agent-studio/GreenPMS/commit/a0fbdd55595530d2a07b70136b4e73aee47cc2fb))

## [1.2.3](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.2.2...v1.2.3) (2026-09-09)

- 房态后台刷新失败后自动退避重试，恢复前保留写入安全门禁。
- 将房态失败提示改为紧凑状态条，减少黄色大提示和手动刷新依赖。

[完整优化说明与升级说明](docs/releases/v1.2.3.md)

## [1.2.2](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.2.1...v1.2.2) (2026-09-09)

- 保留浏览器标签页 Logo，撤回登录页和主界面左上角的图片展示，恢复文字品牌布局。

[完整优化说明与升级说明](docs/releases/v1.2.2.md)

## [1.2.1](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.2.0...v1.2.1) (2026-09-09)

- 使用 QinTopia 品牌图片作为登录页、侧边栏和浏览器标签页 Logo。

[完整优化说明与升级说明](docs/releases/v1.2.1.md)

## [1.2.0](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.1.0...v1.2.0) (2026-09-09)

- 修复订单、房态、会员和工作台的慢读取、失败恢复、分页与跨入口显示一致性问题。
- 补齐会员安排住宿、订单房号识别、资金筛选说明和房态高级筛选等工作入口与反馈。
- 账号页分区图标、低频区域折叠和页面紧凑布局完成统一调整。

[完整优化说明与升级说明](docs/releases/v1.2.0.md)

## [1.1.0](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.0.0...v1.1.0) (2026-09-07)

- 支持已预订及在住整房订单补录同住人，共用订单完整住宿日期。
- 支持撤销误录同住人并保留原因和登记历史，同步更新名册及人数。
- 将版本号移到左上角 Logo 下方，补齐版本接口 OpenAPI 错误响应声明。

[完整优化说明与升级说明](docs/releases/v1.1.0.md)

## [1.0.0](https://github.com/qintopia-agent-studio/GreenPMS/releases/tag/v1.0.0) (2026-09-07)

首个正式编号版本，基于既有线上系统建立版本基线。

- 修复所有楼栋今日人数重复统计。
- 登录固定保持 7 天。
- 新增页面版本号、版本查询接口和发布说明检查。

[完整优化说明与升级说明](docs/releases/v1.0.0.md)
