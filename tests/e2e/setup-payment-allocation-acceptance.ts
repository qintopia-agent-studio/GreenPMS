/** Coordinator-only setup; never imported by the browser spec and never runs automatically.
 * PAYMENT_ALLOCATION_ACCEPTANCE_DATABASE_URL=postgres://qintopia@127.0.0.1:55439/qintopia_payment_allocation_acceptance \
 * PMS_PAYMENT_ALLOCATION_ENABLED=true node --import tsx tests/e2e/setup-payment-allocation-acceptance.ts --reset-synthetic-acceptance
 * To import a synthetic success refund AFTER applying 400: same env, --refund 人工一
 * Stop acceptance servers before reset. This helper resets ONLY the explicitly guarded dedicated database.
 */
import { createCommandPreview, confirmCommandPreview } from '@qintopia/db';
import type { AuthPrincipal, CommandEnvelope } from '@qintopia/contracts';
import { demo } from '../../packages/db/src/seed.ts';
import { createQuoteForTesting } from '../../packages/db/src/pricing-service.ts';
import { resetDatabase } from '../helpers/database.ts';
import { authScope } from '../helpers/auth-principals.ts';
import { acceptanceDatabaseUrl, groups, guestName, propertyId, syncSyntheticPayment, type AcceptanceGroup } from './payment-allocation-helpers.ts';

async function main() {
  const url = acceptanceDatabaseUrl();
  if (process.env.PMS_PAYMENT_ALLOCATION_ENABLED !== 'true') throw new Error('显式启用 PMS_PAYMENT_ALLOCATION_ENABLED=true');
  const args = process.argv.slice(2);
  if (args[0] === '--refund' && args.length === 2 && groups.includes(args[1] as AcceptanceGroup)) {
    const bill = await syncSyntheticPayment(args[1] as AcceptanceGroup, 'REFUND');
    console.log(JSON.stringify({synthetic:true, refundBillId:bill.id, reference:bill.reference})); return;
  }
  if (args.length !== 1 || args[0] !== '--reset-synthetic-acceptance') throw new Error('需要 --reset-synthetic-acceptance 或 --refund <组名>；未重置');
  const db = await resetDatabase(url);
  const principal: AuthPrincipal = { subjectId:demo.administratorSubjectId, credentialId:'synthetic-acceptance-session', credentialType:'SESSION', displayName:'合成验收管理员', ...authScope({credentialType:'SESSION',profile:'administrator'}) };
  await db.insertInto("web_sessions").values({id:principal.credentialId,subject_id:principal.subjectId,secret_hash:"b".repeat(64),expires_at:new Date(Date.now()+3600000),revoked_at:null}).execute();
  const meta = () => ({idempotencyKey:crypto.randomUUID(),correlationId:crypto.randomUUID()});
  async function execute(command:CommandEnvelope) {
    const {preview} = await createCommandPreview(db,principal,command,meta());
    const receipt = await confirmCommandPreview(db,principal,preview.previewId,{propertyId,commandType:command.commandType,confirmation:true,expectedEffectHash:preview.effectHash,reason:{code:'CREATE_STANDARD_ORDER',note:''}},meta());
    if (!receipt.businessCommitted) throw new Error(JSON.stringify(receipt));
    return receipt.result!.orderId as string;
  }
  try {
    const output=[];
    for (const [index,group] of groups.entries()) {
      const orders:Record<string,string>={};
      for (const [i,label] of ['A','B','C'].entries()) {
        const arrival = new Date(Date.UTC(new Date().getUTCFullYear()+2,0,1+index*8+(label==='C'?3:0)));
        const departure = new Date(arrival.getTime()+86400000);
        const quote = await createQuoteForTesting(db,{propertyId,inventoryUnitId:label==='B'?demo.secondRoomId:demo.roomId,stayType:'TRANSIENT',arrivalDate:arrival.toISOString().slice(0,10),departureDate:departure.toISOString().slice(0,10),pricingPolicyVersionId:demo.transientPolicyId});
        orders[label]=await execute({commandType:'CREATE_ORDER',input:{propertyId,quoteId:quote.quoteId,primaryGuest:{fullName:guestName(group,label),nickname:guestName(group,label)},bookingChannelCode:'WECOM',targetCurrentContractAmountMinor:i===1?60000:40000,manualPriceAdjustmentReason:"合成资金验收协议价"}});
      }
      const bill = await syncSyntheticPayment(group,'COLLECTION');
      output.push({group,orders,collectionBillId:bill.id,urls:Object.fromEntries(Object.entries(orders).map(([k,v])=>[k,`/orders/${v}`]))});
    }
    console.log(JSON.stringify({synthetic:true,baseUrl:'使用主模型启动的本机前端 URL；本脚本不启动服务器',login:'admin，密码由操作者使用 seed.ts 中既有演示登录；此输出不包含凭据',groups:output,steps:['A 收款400，B 同一流水收款600','取消B，检查已收未退600','B登记留存600；订单列表资金视图查找归属客户','C使用留存400，说明原客户授权代订；余额200','运行本脚本 --refund 人工一（或对应组），只导入合成成功退款','B登记留存款实际退款200，清单余额归零；A400/C400保持不变']},null,2));
  } finally { await db.destroy(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
