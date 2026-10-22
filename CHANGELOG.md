# Changelog

每个部署版本使用独立 Git 标签和 GitHub Release，优化说明与升级说明随代码保存。版本规则及发布步骤见 [发布约定](docs/releases/README.md)。

## [1.17.4](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.17.3...v1.17.4) (2026-10-22)


### Bug Fixes

* **dashboard:** 统一社区退房日与会员权益统计口径 ([#105](https://github.com/qintopia-agent-studio/GreenPMS/issues/105)) ([2c1c4e9](https://github.com/qintopia-agent-studio/GreenPMS/commit/2c1c4e91bcd7c1171e3a2429e3ffc2f0d9a14c82))

## [1.17.3](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.17.2...v1.17.3) (2026-10-21)


### Bug Fixes

* **dashboard:** 修复当前居民识别与资金事实缺项 ([#103](https://github.com/qintopia-agent-studio/GreenPMS/issues/103)) ([7647534](https://github.com/qintopia-agent-studio/GreenPMS/commit/764753415677e7a971eb9b3e8129059ece6ebdf0))

## [1.17.2](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.17.1...v1.17.2) (2026-10-21)


### Bug Fixes

* **release:** declare runtime compiler dependency ([#101](https://github.com/qintopia-agent-studio/GreenPMS/issues/101)) ([35224c7](https://github.com/qintopia-agent-studio/GreenPMS/commit/35224c739a34941b629a76608aae22b80e142ec2))

## [1.17.1](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.17.0...v1.17.1) (2026-10-21)


### Bug Fixes

* **dashboard:** 优化看板逐日排序与表格展示 ([#98](https://github.com/qintopia-agent-studio/GreenPMS/issues/98)) ([4173789](https://github.com/qintopia-agent-studio/GreenPMS/commit/4173789a52e826447ddc49976320e25100c2a158))
* **dashboard:** 统一居民与财务登记口径 ([#100](https://github.com/qintopia-agent-studio/GreenPMS/issues/100)) ([c4c1a53](https://github.com/qintopia-agent-studio/GreenPMS/commit/c4c1a5345de76681f5f7d83a0c98f64c5e12769f))

## [1.17.0](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.16.0...v1.17.0) (2026-10-20)


### Features

* **release:** 将数据库升级纳入受控发布 ([#95](https://github.com/qintopia-agent-studio/GreenPMS/issues/95)) ([c86687a](https://github.com/qintopia-agent-studio/GreenPMS/commit/c86687ad2dc6d76afef9c74877da73388a79e5a8))


### Bug Fixes

* **release:** 补齐数据库准备命令的sudo授权 ([#97](https://github.com/qintopia-agent-studio/GreenPMS/issues/97)) ([6b253ed](https://github.com/qintopia-agent-studio/GreenPMS/commit/6b253ed4dd126c92ce2f5c1b48783735cdc779b0))

## [1.16.0](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.15.0...v1.16.0) (2026-10-20)


### Features

* **membership:** support upgrades after room changes ([#93](https://github.com/qintopia-agent-studio/GreenPMS/issues/93)) ([d898cbd](https://github.com/qintopia-agent-studio/GreenPMS/commit/d898cbdb494e38cfc26d4abe1816a6ce2b611a58))

## [1.15.0](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.14.1...v1.15.0) (2026-10-17)


### Features

* **members:** 展示会员权益概要并默认展开详情 ([#92](https://github.com/qintopia-agent-studio/GreenPMS/issues/92)) ([c39aba8](https://github.com/qintopia-agent-studio/GreenPMS/commit/c39aba8c2e094a21f585c18ffa0c8729fa24bba4))


### Bug Fixes

* **release:** 切换容器前核验真实数据库迁移和完整性 ([#90](https://github.com/qintopia-agent-studio/GreenPMS/issues/90)) ([bb4d864](https://github.com/qintopia-agent-studio/GreenPMS/commit/bb4d864e2a2eedfa636f27bde0f95b166382f130))
* **room-status:** keep order details closed on navigation return ([#91](https://github.com/qintopia-agent-studio/GreenPMS/issues/91)) ([5655213](https://github.com/qintopia-agent-studio/GreenPMS/commit/5655213eef3646a925ba950416bc5188b006c1c5))


### CI / Deployment

* 分离 PR 格式检查避免编辑说明取消代码验证 ([#88](https://github.com/qintopia-agent-studio/GreenPMS/issues/88)) ([c08157f](https://github.com/qintopia-agent-studio/GreenPMS/commit/c08157f501d629d41af2eb8abfe344ab8e02ce44))

## [1.14.1](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.14.0...v1.14.1) (2026-10-16)


### Bug Fixes

* **room-catalog:** 简化房间分类设置并修复表格滚动 ([#87](https://github.com/qintopia-agent-studio/GreenPMS/issues/87)) ([783712e](https://github.com/qintopia-agent-studio/GreenPMS/commit/783712ef99aaa1356e66596a13d3d541f8d930eb))
* **room-status:** 修复翻月与同步阻断并统一宿舍统计范围 ([#85](https://github.com/qintopia-agent-studio/GreenPMS/issues/85)) ([9ea33bd](https://github.com/qintopia-agent-studio/GreenPMS/commit/9ea33bdbd479e1b08af7183d0e935d225406d84a))

## [1.14.0](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.13.1...v1.14.0) (2026-10-15)


### Features

* **members:** 支持取消误建的空白会员订单 ([#84](https://github.com/qintopia-agent-studio/GreenPMS/issues/84)) ([609dc01](https://github.com/qintopia-agent-studio/GreenPMS/commit/609dc011db056df0f1c75ee3dfdd4b6b040b46f1))


### Bug Fixes

* **dashboard:** 修复住宿时长漏计并按昵称识别回访 ([#82](https://github.com/qintopia-agent-studio/GreenPMS/issues/82)) ([e599a4b](https://github.com/qintopia-agent-studio/GreenPMS/commit/e599a4be3b75b4039800712b82348817fbe54efd))

## [1.13.1](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.13.0...v1.13.1) (2026-10-15)


### Bug Fixes

* **orders:** accept audited channel repricing in order details ([#80](https://github.com/qintopia-agent-studio/GreenPMS/issues/80)) ([828095c](https://github.com/qintopia-agent-studio/GreenPMS/commit/828095c046ef31e73a48ac96ce87bc540a0aa7cd))

## [1.13.0](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.12.1...v1.13.0) (2026-10-15)


### Features

* **sales:** 按匹配事实统计收入并支持住宿金额角分与渠道退款 ([#79](https://github.com/qintopia-agent-studio/GreenPMS/issues/79)) ([7d4117c](https://github.com/qintopia-agent-studio/GreenPMS/commit/7d4117c1afcda5e777aa156e331e9fb0836b5c72))


### Bug Fixes

* **dashboard:** 修复当前人数并补齐今日订单与收款 ([#77](https://github.com/qintopia-agent-studio/GreenPMS/issues/77)) ([c937593](https://github.com/qintopia-agent-studio/GreenPMS/commit/c937593823b25a5805a2a3cb10b53612513da7b3))

## [1.12.1](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.12.0...v1.12.1) (2026-10-13)


### Bug Fixes

* **dashboard:** 恢复登记人数与补录房源历史入住率 ([#75](https://github.com/qintopia-agent-studio/GreenPMS/issues/75)) ([3c2c573](https://github.com/qintopia-agent-studio/GreenPMS/commit/3c2c5732c83b55f424bcb9e24a520b523dab7dd9))

## [1.12.0](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.11.1...v1.12.0) (2026-10-12)


### Features

* **dashboard:** 重设计共居经营看板并修正统计边界 ([#73](https://github.com/qintopia-agent-studio/GreenPMS/issues/73)) ([71784bb](https://github.com/qintopia-agent-studio/GreenPMS/commit/71784bb35a24d95f991cedd3caecf38c8d0a28e5))

## [1.11.1](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.11.0...v1.11.1) (2026-10-11)


### Bug Fixes

* **dashboard:** 中文展示与未来库存异常追溯 ([#71](https://github.com/qintopia-agent-studio/GreenPMS/issues/71)) ([385d3b1](https://github.com/qintopia-agent-studio/GreenPMS/commit/385d3b19bcde69305b9801e8a291b8b0a8698a28))

## [1.11.0](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.10.0...v1.11.0) (2026-10-11)


### Features

* **dashboard:** 增强经营概览与只读明细分析 ([#69](https://github.com/qintopia-agent-studio/GreenPMS/issues/69)) ([7497d70](https://github.com/qintopia-agent-studio/GreenPMS/commit/7497d70388e11ed9a0859aece105d0be9fc992ff))

## [1.10.0](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.9.1...v1.10.0) (2026-10-06)


### Features

* **assistant:** 补齐员工操作知识并建立同版本交付约定 ([#67](https://github.com/qintopia-agent-studio/GreenPMS/issues/67)) ([77e4a8e](https://github.com/qintopia-agent-studio/GreenPMS/commit/77e4a8e4e22ed0ffdb327f3b7e897ac7fdc7cfdf))

## [1.9.1](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.9.0...v1.9.1) (2026-10-06)


### Bug Fixes

* **payments:** 恢复已验收资金与会员刷新基线 ([#65](https://github.com/qintopia-agent-studio/GreenPMS/issues/65)) ([f62600a](https://github.com/qintopia-agent-studio/GreenPMS/commit/f62600a3173143955c634de8441ed809eb342398))

## [1.9.0](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.8.3...v1.9.0) (2026-10-05)


### Features

* **payments:** 支持多订单资金分配与客户留存再使用 ([#62](https://github.com/qintopia-agent-studio/GreenPMS/issues/62)) ([df76346](https://github.com/qintopia-agent-studio/GreenPMS/commit/df76346af7bd59ac1bd98b3bc6a4dadafada3069))

## [1.8.3](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.8.2...v1.8.3) (2026-10-04)


### Bug Fixes

* **room-status:** 分离同日住宿库存与前客退房交接 ([#63](https://github.com/qintopia-agent-studio/GreenPMS/issues/63)) ([fa765d1](https://github.com/qintopia-agent-studio/GreenPMS/commit/fa765d121f1d46cdc81101506b24273d8cd414cf))


### Documentation

* **payments:** 提议支付通知 worker 生产接线 ([#60](https://github.com/qintopia-agent-studio/GreenPMS/issues/60)) ([9b152e1](https://github.com/qintopia-agent-studio/GreenPMS/commit/9b152e119c84ec435a0c39cb76eb5ab358f0e01c))

## [1.8.2](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.8.1...v1.8.2) (2026-09-28)


### Bug Fixes

* **room-status:** 降低短暂刷新提示干扰 ([#59](https://github.com/qintopia-agent-studio/GreenPMS/issues/59)) ([22de1db](https://github.com/qintopia-agent-studio/GreenPMS/commit/22de1db677579010729e12dceda000ee6f7af98e))


### Documentation

* **room-status:** record manual acceptance ([#57](https://github.com/qintopia-agent-studio/GreenPMS/issues/57)) ([d14f84f](https://github.com/qintopia-agent-studio/GreenPMS/commit/d14f84f78f3592af1490461eac9f15fe0af0c391))

## [1.8.1](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.8.0...v1.8.1) (2026-09-26)


### Bug Fixes

* **release:** record restricted switch failure diagnostics ([#54](https://github.com/qintopia-agent-studio/GreenPMS/issues/54)) ([3116f52](https://github.com/qintopia-agent-studio/GreenPMS/commit/3116f52608866b0ff8bba81acc6c74a63d86fc5c))
* **tokens:** 优化权限选择与签发校验提示 ([#56](https://github.com/qintopia-agent-studio/GreenPMS/issues/56)) ([f10e40a](https://github.com/qintopia-agent-studio/GreenPMS/commit/f10e40a8f4dc27b3871e93bc78c02e2b95fba69d))

## [1.8.0](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.7.2...v1.8.0) (2026-09-25)


### Features

* **payments:** 可靠投递收款事件并提供首次基线 ([#51](https://github.com/qintopia-agent-studio/GreenPMS/issues/51)) ([e7f7716](https://github.com/qintopia-agent-studio/GreenPMS/commit/e7f77163eb6d4cbc0142b356f96087b0a399458c))


### Documentation

* **payments:** 补充支付事件联合验收报告 ([#53](https://github.com/qintopia-agent-studio/GreenPMS/issues/53)) ([0dbb320](https://github.com/qintopia-agent-studio/GreenPMS/commit/0dbb3208430ade6b663c6acf587f8ec47d752533))

## [1.7.2](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.7.1...v1.7.2) (2026-09-21)


### Bug Fixes

* **catalog:** 保留房源身份支持在住房间改号并修复业务错误返回 ([#49](https://github.com/qintopia-agent-studio/GreenPMS/issues/49)) ([a410cda](https://github.com/qintopia-agent-studio/GreenPMS/commit/a410cdaf1f48376bead751d064503f09e557854f))

## [1.7.1](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.7.0...v1.7.1) (2026-09-21)


### Bug Fixes

* **stays:** 统一侧边栏补录与业务失败提示 ([#47](https://github.com/qintopia-agent-studio/GreenPMS/issues/47)) ([aab6de9](https://github.com/qintopia-agent-studio/GreenPMS/commit/aab6de97d025cf875fcfbea184ee5786148919e0))

## [1.7.0](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.6.0...v1.7.0) (2026-09-20)


### Features

* **room-status:** 优化悬浮快捷框与点击抽屉交互 ([#45](https://github.com/qintopia-agent-studio/GreenPMS/issues/45)) ([318088b](https://github.com/qintopia-agent-studio/GreenPMS/commit/318088bf1eb000be8dd5a90901c0a8af639b4df7))
* **room-status:** 精简快捷框并直达常用订单操作 ([#44](https://github.com/qintopia-agent-studio/GreenPMS/issues/44)) ([7fbd80e](https://github.com/qintopia-agent-studio/GreenPMS/commit/7fbd80e9f1011ae07ccd3005d7d152c6a70cac62))

## [1.6.0](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.5.0...v1.6.0) (2026-09-20)


### Features

* **ai:** 流式响应、超时取消与订单抽屉共存修复 ([#43](https://github.com/qintopia-agent-studio/GreenPMS/issues/43)) ([ca231cd](https://github.com/qintopia-agent-studio/GreenPMS/commit/ca231cd378e7e3e08b4768e5761c749ba5840d35))


### Documentation

* 核对已发布功能并关闭过期草稿记录 ([#41](https://github.com/qintopia-agent-studio/GreenPMS/issues/41)) ([9b9c6ee](https://github.com/qintopia-agent-studio/GreenPMS/commit/9b9c6eed97f18f535b295a2910c47b8ab5412af9))

## [1.5.0](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.4.3...v1.5.0) (2026-09-19)


### Features

* **membership:** 支持在住订单保留原房跨房型升级会员 ([#40](https://github.com/qintopia-agent-studio/GreenPMS/issues/40)) ([fecbd61](https://github.com/qintopia-agent-studio/GreenPMS/commit/fecbd614e7644791360fa0bc028f7c3076d8a0dc))


### Bug Fixes

* **orders:** 修复经营目录维护后的换房快照与名称展示 ([#38](https://github.com/qintopia-agent-studio/GreenPMS/issues/38)) ([418ffdf](https://github.com/qintopia-agent-studio/GreenPMS/commit/418ffdf0c29be6542754175a400ad0ecfc4ea3db))

## [1.4.3](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.4.2...v1.4.3) (2026-09-17)


### Bug Fixes

* **assistant:** keep assistant open during order actions ([#36](https://github.com/qintopia-agent-studio/GreenPMS/issues/36)) ([10fe106](https://github.com/qintopia-agent-studio/GreenPMS/commit/10fe106f70a8992e8ceee94b8619abdbad075d85))

## [1.4.2](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.4.1...v1.4.2) (2026-09-16)


### Bug Fixes

* **deploy:** initialize AI encryption with recoverable configuration transaction ([#33](https://github.com/qintopia-agent-studio/GreenPMS/issues/33)) ([0491c67](https://github.com/qintopia-agent-studio/GreenPMS/commit/0491c679af7af86ed8cd04639cc5618cc29f5fae))
* **orders:** improve list scrolling and drawer dismissal ([dcee2d8](https://github.com/qintopia-agent-studio/GreenPMS/commit/dcee2d80f8fab48574ca21d45242c2a0087c8f2b))

## [1.4.1](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.4.0...v1.4.1) (2026-09-15)


### Bug Fixes

* **release:** allow approved forward migration extension ([386d666](https://github.com/qintopia-agent-studio/GreenPMS/commit/386d6666947c165f282933868fa55733d21dc52c))
* **release:** allow approved forward migration extension ([142ece0](https://github.com/qintopia-agent-studio/GreenPMS/commit/142ece04fd6b04fb016fe8a6bd8da0edad5b6c7f))
* **room-status:** 修复 iPad 日期栏吸顶空白 ([#31](https://github.com/qintopia-agent-studio/GreenPMS/issues/31)) ([ee244c8](https://github.com/qintopia-agent-studio/GreenPMS/commit/ee244c803b2a1dd4796c17ad6f195988a96293a0))


### Documentation

* define worktree creation and cleanup rules ([#30](https://github.com/qintopia-agent-studio/GreenPMS/issues/30)) ([248015e](https://github.com/qintopia-agent-studio/GreenPMS/commit/248015e48a87e299476087953b9577f956c22794))

## [1.4.0](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.3.4...v1.4.0) (2026-09-15)


### Features

* **settings:** 管理房型房间床位与生效价格 ([#25](https://github.com/qintopia-agent-studio/GreenPMS/issues/25)) ([80e0a5e](https://github.com/qintopia-agent-studio/GreenPMS/commit/80e0a5e1e9727c07f14023a3bfde3d97159fc354))

## [1.3.4](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.3.3...v1.3.4) (2026-09-11)


### Bug Fixes

* **ui:** restore Q in collapsed sidebar ([a3b427d](https://github.com/qintopia-agent-studio/GreenPMS/commit/a3b427d6e96b4264e09355f5e8d48aacad8f1540))
* **ui:** 折叠侧栏恢复 Q 标识并隐藏版本号 ([cfcb080](https://github.com/qintopia-agent-studio/GreenPMS/commit/cfcb080a2020e9056dc7deea1198c3311ac97c3f))

## [1.3.3](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.3.2...v1.3.3) (2026-09-11)


### Bug Fixes

* accept COS never-versioned response ([3a35904](https://github.com/qintopia-agent-studio/GreenPMS/commit/3a359049b79ce57890ee596e4a07f12f11c8d8f7))
* accept COS never-versioned response ([c94b882](https://github.com/qintopia-agent-studio/GreenPMS/commit/c94b882939364d5c61704656e7d584df0f6578e8))
* inspect Docker images without labels ([a5de9fa](https://github.com/qintopia-agent-studio/GreenPMS/commit/a5de9fab1df8eee1113b154b0f6b31fd28234465))
* **integrations:** pass PMS and Agent OS synthetic joint acceptance ([4d71a1a](https://github.com/qintopia-agent-studio/GreenPMS/commit/4d71a1ac119b4c3fad0cd5b2570d81ec56809114))
* **integrations:** 修复事件补偿响应与新安装就绪检查 ([14f1700](https://github.com/qintopia-agent-studio/GreenPMS/commit/14f17006093e81f8f2bddee39298057307a4ebea))
* **release:** allow forward-only versions to deploy ([4470417](https://github.com/qintopia-agent-studio/GreenPMS/commit/4470417f0d313457cf302606b790b24c0bcfaf3b))
* **release:** allow forward-only versions to deploy ([0180c29](https://github.com/qintopia-agent-studio/GreenPMS/commit/0180c29c16ec466a25b12f635ca0c48526e960fb))
* **release:** deploy WeCom worker with app ([7c755a7](https://github.com/qintopia-agent-studio/GreenPMS/commit/7c755a7cfdd7fb38299711ef18d96f0189c7012c))
* **release:** deploy WeCom worker with app ([7e63fbc](https://github.com/qintopia-agent-studio/GreenPMS/commit/7e63fbcd21be5240b22213c666bc7989715b292b))
* **release:** restore rollback policy after migrations ([501e7da](https://github.com/qintopia-agent-studio/GreenPMS/commit/501e7dafaf642a1f63932faf039bfe9103d2f58f))
* **release:** restore rollback policy after migrations ([8ac3d86](https://github.com/qintopia-agent-studio/GreenPMS/commit/8ac3d861ef406bd80e1506a1fd639860a63221aa))
* **release:** return archive scanner identity ([d60bd5a](https://github.com/qintopia-agent-studio/GreenPMS/commit/d60bd5a5ef132ca6bbf47933e958148c69d3de2f))
* **release:** return archive scanner identity ([21d8a0f](https://github.com/qintopia-agent-studio/GreenPMS/commit/21d8a0fa75878f7098191054e8f375035e238516))
* **release:** separate archive and runtime image identity ([b144ee1](https://github.com/qintopia-agent-studio/GreenPMS/commit/b144ee153de5f77e75480a47faa24066f31dd016))
* **release:** separate archive and runtime image identity ([a87ead3](https://github.com/qintopia-agent-studio/GreenPMS/commit/a87ead301350928bb7586dba253c47f56a59e303))
* run release tests from harness checkout ([7c69474](https://github.com/qintopia-agent-studio/GreenPMS/commit/7c69474d197c04747e702f0513a294f8ac49254b))
* run release tests from harness checkout ([101f4d1](https://github.com/qintopia-agent-studio/GreenPMS/commit/101f4d1630f0b3c50af8d6924b884f68073e2c26))
* **wecom:** unblock production readiness fingerprint ([34f7725](https://github.com/qintopia-agent-studio/GreenPMS/commit/34f7725216338328d434e850aca1b70910252a34))


### Build System

* exclude repository-only files from Docker context ([c2e4e79](https://github.com/qintopia-agent-studio/GreenPMS/commit/c2e4e79f03818065441c59a32c1eb4845fca94ca))
* exclude repository-only files from Docker context ([8ca80a3](https://github.com/qintopia-agent-studio/GreenPMS/commit/8ca80a30acb15dfed6c8b9784c6750aef8399d6a))


### Documentation

* **integrations:** archive acceptance baselines and prepare PR ([a9bbbd9](https://github.com/qintopia-agent-studio/GreenPMS/commit/a9bbbd90b1e2c6fe786a2202d27a583c63546a8e))
* record final acceptance handoff approval block ([43ece6d](https://github.com/qintopia-agent-studio/GreenPMS/commit/43ece6dc0e0cdd26202c27b43fa5758daab16e36))

## [1.3.2](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.3.1...v1.3.2) (2026-09-10)

- 修正企业微信收退款 readiness 的生产 PostgreSQL 18 schema fingerprint，使迁移后的运行账号可以正常通过启动门禁。

[完整优化说明与升级说明](docs/releases/v1.3.2.md)

## [1.3.1](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.3.0...v1.3.1) (2026-09-10)

- 接入企业微信对外收退款流水同步、昵称展示、推荐匹配和完整清单查询。
- 收退款支持独立退款单号、原收款关联、历史边界和并发防重复匹配。
- 统一弹窗显式关闭，避免点击外部或按 Esc 误丢失填写内容。
- 完善 PMS 事件投影与智能体读取接口基础。

[完整优化说明与升级说明](docs/releases/v1.3.1.md)

## [1.3.0](https://github.com/qintopia-agent-studio/GreenPMS/compare/v1.2.3...v1.3.0) (2026-09-10)

### CI / Deployment

* 建立 GreenPMS 生产发布流水线、版本保护和回退约束。

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
