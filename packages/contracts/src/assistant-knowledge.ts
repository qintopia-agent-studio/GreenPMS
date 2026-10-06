import type { CommandCapability } from "./index.ts";
import type { AccountManagementAction } from "./account-management.ts";

/** Employee-facing operating knowledge. Shipped with the application, never learned from chat.
 * Maintenance contract: docs/operations/assistant-knowledge.md.
 * sources are review pointers, not runtime file reads or links to expose to employees.
 */
export interface AssistantKnowledgeTopic {
  id: string;
  title: string;
  commands: readonly CommandCapability[];
  accountActions?: readonly AccountManagementAction[];
  sources: readonly string[];
  content: string;
}
export const assistantKnowledgeRevision = "2026-10-06.1";
export const assistantKnowledgeBaseline = "1.9.1";

export const assistantKnowledgeTopics: readonly AssistantKnowledgeTopic[] = [
  {
    id: "workspace", title: "工作区、权限与安全提交", commands: [],
    sources: ["apps/web/src/session.tsx", "packages/domain/src/command-permissions.ts"],
    content: `先确认当前门店。房态、订单、会员、工作台和设置的数据与权限以当前工作区为准，换店后重新查询；只读账号不能提交业务。按钮隐藏或禁用可能由权限、订单状态、功能开关或未完成的核对流程导致，应查看页面具体原因，不教员工绕过限制。
所有业务变更都在正式页面填写、查看预览并由员工确认；预览不是提交成功。结果不明先查订单或恢复提示，不重复登记收款、退款或预订。不要求员工提供登录密码、API Key、完整证件号。`
  },
  {
    id: "room-status", title: "房态查询与同日退房交接", commands: [],
    sources: ["待开发项/QinTopia-PMS-房态稳定性欠款与状态显示-实施规格.md", "apps/web/src/room-status/RoomStatusGrid.tsx", "packages/db/src/departure-day-stays.ts"],
    content: `在房态页选择日期，按房型、房号等筛选，点击住宿记录查看订单；空闲位置选择日期后安排住宿。长住宿可跨显示区间，不把日历当前窗口当作住宿最长天数。助手自己的可用性工具一次最多查31晚，这是工具限制，不是系统预订上限。
住宿夜占用包含入住日、不含离店日。前客当天应退但尚未实际退房时，当晚可被后客预订，不代表后客现在可以入住；必须先让前客正式办理退房，再给后客办理入住。不要为了后客预订而强行延长前客库存或撤销真实入住。
未知、部分加载、请求失败不能解释成空房、零欠款或已结清；刷新并查看异常提示。维修、整房与床位互斥、真实在住交接都可能阻止操作，以服务端核对为准。`
  },
  {
    id: "booking", title: "新建预订、渠道、免费住宿与报价", commands: ["CREATE_ORDER"],
    sources: ["apps/web/src/pages/InventoryPage.tsx", "apps/web/src/ui.tsx", "待开发项/QinTopia-PMS-在住升级会员与历史补录-实施规格.md"],
    content: `从房态空闲位置或页面新建入口开始，核对房间/床位、入住与离店日期、住宿人及住宿类型。普通住宿按表单选择渠道并填写所需渠道订单号；渠道是订单来源，不等于收款方式。会员住宿通过选择会员计算覆盖，不把它伪装成渠道订单。
报价后核对总额、住宿范围和规则，再提交预订；报价、预订、办理入住是不同步骤。价格以当前表单和服务端报价为准，不能由助手凭记忆计算或承诺。
免费住宿按正式免费住宿入口填写依据，不伪造一笔现金或企微收款；渠道差额按页面说明处理，不用改订单金额或重复记收款来消除未知差额。`
  },
  {
    id: "order-search", title: "查找订单、详情、同住人与工作台", commands: ["MANAGE_ORDER_OCCUPANTS"],
    sources: ["apps/web/src/pages/OrdersPage.tsx", "apps/web/src/pages/TodayPage.tsx", "apps/web/src/pages/OrderDetailPage.tsx"],
    content: `在订单页用客人、房号及状态等筛选定位订单，打开详情核对日期、住宿安排、金额、履约和历史。房态与工作台也可进入对应订单。工作台用于查看待办，不是自动办理入住、退房或退款。
整房订单可以在详情中维护同住人，先核对主住人和实际同住关系；同住人不等于新增一个房间预订，不借此重复占房。误填住客资料走有权限的更正入口，不能删历史掩盖事实。
助手订单搜索最多返回20条且可能还有下一页，不能据此给出全店总数。`
  },
  {
    id: "check-in-out", title: "入住、退房与住宿结束", commands: ["CHECK_IN", "CHECK_OUT", "COMPLETE_STAY"],
    sources: ["packages/db/src/orders.ts", "apps/web/src/pages/OrderDetailPage.tsx", "待开发项/房态与订单运营流程分步开发计划.md"],
    content: `打开确定的订单，查看可操作状态，再选择办理入住或办理退房；核对实际日期、住宿安排和预览后确认。预订不等于已入住，计划离店日到了也不等于已实际退房。
提前离店时按正式缩短/提前退房流程核对剩余日期、价格和会员权益，不直接改数据库日期。入住当天不通过缩短或提前退房处理未使用房间，查看撤销入住的条件。
住宿结束与资金结清分开：已退房不代表已退款或已结清；订单仍有款项待处理时继续在资金区按真实事实处理。`
  },
  {
    id: "stay-changes", title: "改期、续住、缩短与换房", commands: ["RESCHEDULE_STAY", "EXTEND_STAY", "SHORTEN_STAY", "MOVE_UNIT"],
    sources: ["apps/web/src/pages/OrderDetailPage.tsx", "packages/db/src/orders.ts", "docs/implementation/catalog-snapshot-fix/README.md"],
    content: `从订单操作区选择改期、续住、缩短或换房，填写生效日期、目标日期和需要的目标房间/床位。核对库存、价格、住宿安排及会员覆盖变化，然后由员工确认。续住不是新建一张重复订单。
换房需核对整房/床位类型、目标房型和实际换房日期；不要承诺任意房型免费换住。已发布价格变化不会简单覆盖所有历史订单，变更费用以服务端预览为准。冲突或预览过期时刷新重做核对，不反复点击确认。`
  },
  {
    id: "cancel-no-show", title: "取消、未到与资金后续", commands: ["CANCEL_ORDER", "MARK_NO_SHOW"],
    sources: ["apps/web/src/components/OrderLifecycleActionDrawer.tsx", "docs/implementation/spec-payment-allocation-retained-funds.md"],
    content: `在订单详情选择取消订单或标记未到，填写原因，核对影响并确认；可用状态以该订单页面为准。取消订单不会自动退款，也不会自动释放原流水供别的订单使用。
取消后已有收款继续保留。按客户真实意向分别办理实际退款登记或客户留存；不要把已取消误当作资金归零、退款完成。会员权益的占用、释放或已消费处理以预览为准，不承诺取消后所有已用权益自动恢复。`
  },
  {
    id: "revoke-fulfillment", title: "撤销入住与管理员撤销退房", commands: ["REVOKE_CHECK_IN", "REVOKE_CHECK_OUT"],
    sources: ["apps/web/src/components/OrderLifecycleActionDrawer.tsx", "待开发项/spec-revoke-checkout.md", "packages/db/src/orders.ts"],
    content: `撤销入住只在系统允许的入住当天、确认房间未被实际使用并填写原因时办理。它不是恢复为原预订的通用按钮；按当前预览核对终结订单、金额、库存及权益影响，需要继续预订时不要假定原预订已恢复。
撤销退房是管理员受控纠错：填写原因并核对恢复的在住状态、原住宿安排、费用及权益；原收退款事实不因此改变。恢复存在房间冲突、权益不足或后续变更时会被阻止，不能绕过守卫。`
  },
  {
    id: "pricing", title: "调整金额与资金事实区别", commands: ["REPRICE_ORDER"],
    sources: ["apps/web/src/pages/OrderDetailPage.tsx", "packages/contracts/src/assistant.ts"],
    content: `调整金额入口用于更正实际约定的订单金额，填写新金额和原因，核对原金额、新金额与已收款差额后确认。调整金额不等于办理收款或退款，不会替客人付款，也不自动消除已存在的真实资金事实。金额或币种不清楚时先查订单，不猜测。`
  },
  {
    id: "payment-allocation", title: "一笔钱覆盖两个或多个预订", commands: ["RECORD_COLLECTION"],
    sources: ["docs/implementation/spec-payment-allocation-retained-funds.md", "apps/web/src/components/OrderFundsFormDialog.tsx", "apps/web/src/components/ExternalPaymentPicker.tsx"],
    content: `这是同一门店的企业微信真实收款按金额分配给多个普通直接住宿订单，不是把原始流水拆成多笔现金收入；会员订单收款仍整笔独占，不套用住宿订单拆分规则。只有收款分配功能已启用且流水来源可用时才使用分配流程；未启用时保留原整笔匹配语义，联系管理员核对，不教员工绕过。
操作：分别打开每张订单的记录收款表单，收款方式选择企业微信，查找并选择同一笔已成功的真实收款流水，填写本次分配给当前订单的金额，逐单预览确认。每次核对已分配与剩余可分配金额，不把整笔总额在每张订单重复登记。当前不是一个批量选择多订单后一键提交的表单。
示例：已收到1000元，A订单分400元，确认后B订单选择同一流水分600元；三个或更多订单同理，各次合计不能超过可分配余额。示例数字不是当前客人的实时余额。
现金、银行等按实际收款方式和必填凭据/备注登记，不套用企微流水拆分能力。付款昵称和相同金额只是核对线索，不证明款项属于某位客户。`
  },
  {
    id: "refunds", title: "部分退款、合并退款与真实退款登记", commands: ["RECORD_REFUND"],
    sources: ["docs/implementation/spec-payment-allocation-retained-funds.md", "apps/web/src/components/OrderFundsFormDialog.tsx"],
    content: `在需要退款的订单打开记录退款，选择该订单可退的原收款份额，核对实际退款方式、金额和原因。企微退款须选择已成功且关联正确原始交易的真实退款流水；先有外部实际退款，再在PMS登记。PMS不发起支付平台退款。
启用分配后，同一笔合并退款可以按各订单对应的收款份额逐单登记；不得超过退款流水剩余可分配额或对应原收款的可退额度。退款不会恢复原收款流水的可分配余额，不能将退给客户的钱再次分配出去。
例如A400+B600来自同一1000元收款，B取消并真实退600元后登记B退款，A仍400元，现金净额400元，原收款不能再拿600元去给C订单使用。
存在尚未核对归属的成功退款时，来源新增使用或释放可能被冻结；先核对退款归属，不通过冲销或手工重记绕过。已预留为客户留存的部分应走留存退款入口，避免重复占用。`
  },
  {
    id: "retained-create", title: "取消后登记客户留存", commands: ["RETAIN_ORDER_FUNDS"],
    sources: ["docs/implementation/spec-payment-allocation-retained-funds.md", "apps/web/src/components/RetainedFunds.tsx", "packages/db/src/retained-funds.ts"],
    content: `留存款是已经收到的订单资金留给客户以后使用，不是充值钱包，不新增现金收入。来源限于已取消、未到或已退房的普通直接住宿订单中经核实、未占用的多余企微款项；不是任意会员款、现金或银行收款都能留存。
打开来源订单，在“客户留存与资金归属”选择“登记客户留存”，选择可留存原资金，填本次金额、款项归属客户、联系方式/核验依据及确认说明，勾选已核实款项归属及客户意向，继续核对并确认。
例：1000元已分A400、B600，B取消后600元仍在B，不会自动转成公共余额；客户同意保留时在B登记留存600元。不得凭同名、付款昵称或代订人名字自动认定所有权。`
  },
  {
    id: "retained-use", title: "查询留存、再次使用与授权代订", commands: ["APPLY_RETAINED_FUNDS"],
    sources: ["apps/web/src/pages/OrdersPage.tsx", "apps/web/src/components/RetainedFunds.tsx", "packages/db/src/retained-funds.ts"],
    content: `在订单页切换“客户留存待用”，按客户、联系方式或来源订单搜索；需要查看已用完等记录时勾选“包含已处理历史”。来源订单详情也展示原留存、已用、已退、已解除及剩余金额。
使用时打开目标住宿订单，在“客户留存与资金归属”选择“使用客户留存款”，搜索并选中正确留存记录，填写本次金额和使用授权说明，核实归属并确认。目标必须是同一门店的其他可收款普通直接住宿订单，当前允许预订、在住或已退房状态；不能用到来源订单自身或任意会员订单。
允许经授权代订，但必须记录款项归属人的授权，不能凭同名自动扣款。例：B留存600元，授权用于C400元后，剩余200元。系统记录来源转出和目标转入，不新增现金收入，转出也不是退款。
C以后取消，不会自动恢复B已用的400元；应在C按符合条件的退款或再次留存流程处理。助手当前不能直接查询留存清单或实时余额，只能说明步骤并打开订单页/具体订单；不要编造剩余额度。`
  },
  {
    id: "retained-refund-release", title: "留存款退款与误标解除", commands: ["REFUND_RETAINED_FUNDS", "RELEASE_RETAINED_FUNDS"],
    sources: ["docs/implementation/spec-payment-allocation-retained-funds.md", "apps/web/src/components/RetainedFunds.tsx"],
    content: `退回剩余留存：到来源订单的留存记录选择“登记留存款实际退款”，选择已成功且关联原交易的真实退款流水，填写本次金额及原因，核实客户意向后确认；系统只登记已发生退款，不发起实际退款。例：600元留存已用于C400元，剩余200元真实退款并登记后留存归零；不能再退已使用的400元。
误标留存：在来源订单选择“解除留存”，只解除未使用部分并填写原因。解除后回到来源订单待处理，不成为公共可分配余额，不代表退钱给客户；已使用部分不能直接抹掉。关闭留存功能也不会释放历史预留，已有历史仍应可查。`
  },
  {
    id: "reverse-facts", title: "资金更正与撤销分配", commands: ["REVERSE_FACT"],
    sources: ["docs/implementation/spec-payment-allocation-retained-funds.md", "apps/web/src/pages/OrderDetailPage.tsx"],
    content: `误记资金通过订单资金记录的正式冲销/更正入口，选择原事实并说明原因，保留原记录和更正历史。普通冲销不会自动释放企微流水占用；若确需重新分配，核对“同时撤销流水归属以便重新分配”及服务端预览。
已有退款、留存、转会员或待核对退款占用等依赖时，收款分配不能直接撤销。撤销归属不改变实际收退款；撤销退款归属也不会恢复原收款可用额度。不要建议先删除历史再重录。`
  },
  {
    id: "member-profile", title: "会员档案、查重与误建删除", commands: ["CREATE_MEMBER", "CORRECT_MEMBER_PROFILE"], accountActions: ["DELETE_MEMBER"],
    sources: ["docs/implementation/spec-step-2a-member-directory.md", "待开发项/QinTopia-PMS-会员资料字段调整-实施规格.md", "待开发项/QinTopia-PMS-第9步-9.6-账号管理与误建会员删除-实施规格.md", "apps/web/src/pages/MembersPage.tsx"],
    content: `在会员页按姓名、昵称或手机号搜索，确认不是已有会员再新建。手机号需要查重，证件号可选；相同姓名不代表同一人。新建档案本身不产生可住宿权益。
打开会员档案查看合同、余额、收款及关联住宿。资料错误通过有权限的“修改会员记录”办理，填写原因并核对；不要为改资料另建重复会员。管理员可删除无业务记录或已办卡但从未核销的误建会员；先取消关联预订，存在误录收款时必须额外确认其为误录，系统追加冲销并作废未用权益，保留历史而不是实际退款。有历史核销、住宿转会员或其他禁止关联时不能删除；真正收过的钱需要退回时，不用误建删除冒充退款。`
  },
  {
    id: "membership-sale", title: "会员订单、收款、生效与更正", commands: ["CREATE_MEMBERSHIP_ORDER", "RECORD_MEMBERSHIP_PAYMENT", "CORRECT_MEMBERSHIP_PAYMENT", "ACTIVATE_MEMBERSHIP_ORDER"],
    sources: ["docs/implementation/spec-step-2b-membership-orders.md", "apps/web/src/pages/MembersPage.tsx", "docs/implementation/spec-payment-allocation-retained-funds.md"],
    content: `在会员档案创建会员订单，选择页面当前发布的产品，核对权益类型、房型、价格及有效期；成交价偏离默认价时填写原因，不让助手给固定价格承诺。登记真实企微收款并核对流水归属；会员收款仍整笔独占，不使用住宿多订单分配方式。
收款后仍需明确办理会员订单生效，不能把已建档、已创建会员订单或已收款等同于权益已生效。至少有一笔有效收款才能生效；收款与成交价有差额时按页面核对，不据此自动改价或宣称结清。
错误会员收款使用“更正企微收款”，保留原收款及更正记录，不原地删除。会员退费不是本版已提供的通用功能，不用住宿退款或留存入口冒充会员退费。`
  },
  {
    id: "member-stay", title: "会员住宿覆盖、余额与临时其他整间房", commands: ["CORRECT_MEMBER_ENTITLEMENT_BALANCE"],
    sources: ["docs/implementation/spec-step-2c-member-balances-and-stays.md", "待开发项/QinTopia-PMS-会员临时安排其他整间房型-实施规格.md", "apps/web/src/pages/MembersPage.tsx"],
    content: `安排住宿时选择会员并核对房型、有效日期、可用权益和现金补差。预订冻结权益，入住按规则核销；不能把会员剩余夜数当成现金，也不能仅因有会员档案就保证所有日期和房型免费。
覆盖不足时查看逐段覆盖和未覆盖部分报价；遇到多份权益重叠无法自动选择等提示先处理歧义，不由助手随意指定权益。余额更正在会员权益区填写目标剩余数和原因、核对后提交，不改档案数字替代流水。
临时安排其他整间房：从正常房态选择空的整间房、创建订单并选会员，按页面选择临时安排并填写原因；必须有唯一的有效整房权益完整覆盖全部日期，每晚仍扣原权益1间夜，只占实际房间，不增加房型差价、不改变未来适用房型。余额不足不回退现金补差，不能用于床位与整房互换，也不新增审批入口。`
  },
  {
    id: "membership-conversion", title: "在住升级会员与收款转会员", commands: ["CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"],
    sources: ["待开发项/QinTopia-PMS-在住升级会员与历史补录-实施规格.md", "待开发项/spec-cross-room-membership-upgrade.md", "待开发项/spec-8-6-wecom-net-transfer-after-refunds.md", "docs/implementation/spec-payment-allocation-retained-funds.md"],
    content: `在符合条件的在住订单详情点击“升级会员”：按主住人手机号匹配档案，无手机号先更正住宿人，无档案先建档再回到订单。核对产品、有效净收款、转入金额、会员成交价、企微补收差额和住宿权益核销，按最终预览确认。
跨房型升级保留实际房间，不是要求先换房；仅适用在住、完整区间同一实际整房及整房会员，须明确勾选“本次临时安排其他整房”并填原因，核对整段权益充足。例外仅覆盖本次房间与日期，不改变以后产品房型；跨房型升级后延长、换房和历史房间安排纠错被阻止，不能自动套用普通会员续住说明。
住宿收款转会员是现有资金归属转换，不是再次收款。符合资格的全部企微净收款一次转入，会员成交价不能低于转入额；差额必须有真实新企微收款凭证，零转入不伪造零元收款。历史收退款保留；拆分收款或内部划转来源禁止转会员，不把已留存、已退款或已转出的款项重复转入。升级后金额与权益按服务端核对，不用普通重价或部分撤销伪造完整撤销升级。`
  },
  {
    id: "historical-corrections", title: "历史补录、住客及住宿安排纠错", commands: ["CORRECT_ORDER_OCCUPANT", "CORRECT_HISTORICAL_STAY_ARRANGEMENTS", "CORRECT_MEMBERSHIP_EFFECTIVE_DATE", "BACKFILL_HISTORICAL_MEMBERSHIP", "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY"],
    sources: ["待开发项/QinTopia-PMS-在住升级会员与历史补录-实施规格.md", "待开发项/QinTopia-PMS-运营主管受控纠错与房态异常修复-实施规格.md", "apps/web/src/pages/MembersPage.tsx", "apps/web/src/pages/OrdersPage.tsx"],
    content: `补录用于补进真实漏记业务，不是改写已有订单。已完成住宿与当前在住住宿按房态页提供的“补录住宿”入口办理，录入真实历史日期并核对价格、权益及资金依据。已完成补录不再补办入住/退房、不算当前在住；跨今天的在住补录直接形成实际在住记录。已有订单漏记收款在原订单补记，不重复建单。确实漏记退房的逾期在住订单按页面补记退房；错误预订的完成住宿需填写真实依据、核对完整履约与权益影响，不能对所有历史订单普遍补办入住/退房。
住客、历史住宿安排、会员生效日期、历史会员补录或误办会员转回住宿等纠错，使用当前页面已开放且有权限的“修改会员记录”或对应订单更正入口，填原因并查看只读核对、影响范围后确认。不能因为按钮不见就用普通新建流程代替受控纠错。
本版保留审计和关联关系，不指导SQL改数、删除原始事实或绕过库存/权益检查；未来计划或关闭的入口不当成当前功能。`
  },
  {
    id: "maintenance", title: "维修与尚未启用的功能", commands: ["LOCK_MAINTENANCE", "RELEASE_MAINTENANCE", "COMPLETE_CLEANING"],
    sources: ["apps/web/src/pages/InventoryPage.tsx", "packages/contracts/src/index.ts"],
    content: `需要维修时在房态相关入口选择房间/床位和日期，填写原因，核对占用影响后锁定；结束维修使用正式释放入口，不能靠删除入住记录让房间变空。
当前清洁工作流关闭，不指导员工通过“完成清洁”解锁入住；内部占用也不是当前可办理能力。不将代码中的预留命令、历史入口或开发计划当作已开放功能。`
  },
  {
    id: "catalog", title: "房型、房间床位、楼栋顺序与价格", commands: ["MANAGE_ROOM_CATALOG"],
    sources: ["待开发项/QinTopia-PMS-房型房间床位与价格管理-实施规格.md", "docs/implementation/catalog-snapshot-fix/README.md", "apps/web/src/pages/RoomCatalogPage.tsx"],
    content: `有权限的管理员在设置→房型与价格管理房型、房间床位、楼栋显示顺序和住宿价格。修改前核对销售单位、房型关联、启停状态及影响，按页面核对后确认。停用不等于删除历史。
价格和房型有历史快照，修改经营目录不会简单重算全部旧订单；在住房间改号等变化仍须按系统规则提交，遇到占用或关联阻断不能先删订单绕过。助手不能直接打开此设置子页，需告诉员工从设置手动进入，不能把AI模型设置当作房型设置。`
  },
  {
    id: "accounts-tokens", title: "工作人员账号与外部智能体访问", commands: ["ISSUE_TOKEN", "ROTATE_TOKEN", "REVOKE_TOKEN"],
    accountActions: ["CREATE_STAFF", "RESET_PASSWORD", "CHANGE_PASSWORD", "DISABLE_STAFF", "ENABLE_STAFF", "REVOKE_SESSIONS", "DELETE_STAFF"],
    sources: ["apps/web/src/pages/AccountsPage.tsx", "apps/web/src/pages/TokensPage.tsx", "packages/domain/src/command-permissions.ts", "待开发项/QinTopia-PMS-第9步-9.6-账号管理与误建会员删除-实施规格.md"],
    content: `工作人员通过网页登录账号使用PMS；管理员在设置→账号管理创建普通员工、重设密码、停用/启用和撤销会话；不是任意角色权限编辑器，不能新增管理员或管理其他管理员。工作人员可凭当前密码修改自己的密码。停用会让会话和Token失效，重新启用不恢复旧凭证；重设密码不自动启用停用账号。只有该管理页新建且从未使用的空员工账号可按条件删除，其他身份保留历史。遇到登录失效先重新登录，权限不足联系管理员，不共享他人账号。
设置→智能体与外部访问管理API Key（Token）的范围、有效期、轮换和撤销。Token用于外部程序，不是员工登录密码；不能因新增功能自动给旧Token增加能力，需显式核对授权。不得把Token或模型密钥发给助手。助手只能说明此路径，不能直接打开这两个设置子页或代改权限。`
  },
  {
    id: "assistant-help", title: "AI助手的使用、配置与不确定性", commands: [],
    sources: ["docs/operations/ai-assistant.md", "docs/operations/ai-question-records.md", "apps/api/src/assistant.ts"],
    content: `员工可问操作步骤、查询订单/会员或有限日期内的可用房间，并让助手打开支持的正式入口。当前能直接打开的订单表单只有续住、换房、记录收款、调整金额、取消订单；其他操作先打开订单详情，再由员工按说明点击真实按钮。没有具体订单时先确认目标，不猜ID。
留存明细、退款流水、会员权益详情等未接入助手查询的实时数据，必须由员工到正式页面核对，不能从一般知识或历史对话编造。知识不足时说明缺少依据并引导管理员核实，不编造按钮、业务规则或办理结果。
模型配置所属门店的管理员可在设置→AI助手修改地址、模型和密钥，测试连接后保存启用；测试连接会请求模型服务。模型故障不影响PMS其他业务；可停止生成或新建对话，不重复提交业务。员工反馈“未解决”会记录供改进分析，不会自动训练模型或自动修改业务规则。`
  }
];

export function renderAssistantKnowledge(): string {
  return `员工操作知识（修订 ${assistantKnowledgeRevision}；已核对功能基线 ${assistantKnowledgeBaseline}，不是生产部署状态证明）\n` +
    assistantKnowledgeTopics.map(topic => `【${topic.title}】\n${topic.content}`).join("\n\n");
}
