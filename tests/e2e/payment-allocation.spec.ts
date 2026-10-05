/** Run ONLY with a coordinator-owned config pointing at already running dedicated
 * acceptance servers. Do not use npm test:e2e (its setup resets a different DB).
 * Seed once using setup-payment-allocation-acceptance.ts. No reset in this spec.
 */
import { expect, test, type Page } from '@playwright/test';
import { createDatabase } from '../../packages/db/src/database.ts';
import { sql } from 'kysely';
import { acceptanceDatabaseUrl, guestName, paymentReference, propertyId, refundReference, syncSyntheticPayment, type AcceptanceGroup } from './payment-allocation-helpers.ts';

test.skip(process.env.PAYMENT_ALLOCATION_ACCEPTANCE_E2E !== 'true', 'Explicit isolated acceptance opt-in required');
async function confirm(page:Page) {
  const response = page.waitForResponse(r => r.url().includes('/command-previews/') && r.url().endsWith('/confirm') && r.request().method()==='POST');
  await expect(page.getByTestId('confirm-command')).toBeEnabled({timeout:15000});
  await page.getByTestId('confirm-command').click();
  const receipt = await (await response).json();
  expect(receipt.businessCommitted,JSON.stringify(receipt)).toBe(true);
}
async function view(page:Page,id:string) {
  const response=await page.request.get(`/api/v1/orders/${id}`);
  expect(response.ok(),await response.text()).toBe(true); return response.json();
}
async function selectBill(page:Page,reference:string,refund=false) {
  await page.getByRole('button',{name:refund?'选择企业微信退款':'选择企业微信收款',exact:true}).click();
  await page.getByRole('button',{name:'查找完整清单',exact:true}).click();
  const dialog=page.getByRole('dialog').filter({has:page.getByLabel('付款人昵称 / 单号')});
  await dialog.getByLabel('付款人昵称 / 单号').fill(reference);
  await dialog.getByRole('spinbutton',{name:'金额（元）',exact:true}).fill('');
  await dialog.getByRole('button').filter({hasText:`编号：${reference}`}).click();
}
async function collect(page:Page,id:string,group:AcceptanceGroup,amount:string) {
  await page.goto(`/orders/${id}`);
  await page.getByTestId('record-collection').click();
  await selectBill(page,paymentReference(group));
  await page.getByTestId('fact-amount-yuan').fill(amount);
  await page.getByRole('button',{name:'下一步',exact:true}).click(); await confirm(page);
}
async function retained(page:Page,sourceOrderId:string) {
  const response=await page.request.get(`/api/v2/retained-funds?propertyId=${propertyId}&orderId=${sourceOrderId}&status=ALL`);
  expect(response.ok(),await response.text()).toBe(true);return (await response.json()).items;
}
async function fillRetained(page:Page,amount:string,note:string,apply=false) {
  await page.getByLabel('本次金额（元）',{exact:true}).fill(amount);
  await page.getByLabel(apply?'使用授权说明（代订须记录款项归属人授权）':'客户确认说明 / 处理原因',{exact:true}).fill(note);
  await page.getByLabel('已核实款项归属及客户意向，不以姓名或付款昵称自动认定').check();
  await page.getByRole('button',{name:'继续核对',exact:true}).click();await confirm(page);
}

test('合成验收：合付、取消未退、留存清单、授权代订及剩余真实模拟退款',async({page},info)=>{
  acceptanceDatabaseUrl();
  const baseURL=info.project.use.baseURL;
  if (!baseURL || !['127.0.0.1','localhost'].includes(new URL(baseURL).hostname)) throw new Error('Only explicitly configured local acceptance servers are allowed');
  const group=info.project.name as AcceptanceGroup;
  if (!['desktop','mobile'].includes(group)) throw new Error('Use desktop/mobile project names; manual groups are never consumed');
  const db=createDatabase(acceptanceDatabaseUrl());
  let ids:Record<string,string>;
  try {
    ids={};
    for(const label of ['A','B','C']) {
      const found=await db.selectFrom('orders').select('id').where(sql<string>`primary_guest_snapshot->>'fullName'`,'=',guestName(group,label)).executeTakeFirstOrThrow();
      ids[label]=found.id;
    }
    const existing=await db.selectFrom('collection_facts').select('fact_id').where('order_id','in',Object.values(ids)).execute();
    expect(existing,'Fixture already consumed; coordinator must explicitly recreate dedicated acceptance data').toHaveLength(0);
  }finally{await db.destroy();}
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/accounts');
  await page.getByTestId('login-username').fill('admin');
  // Existing synthetic demo credential only; no provider or business credentials.
  await page.getByTestId('login-password').fill('demo-pass-2026');
  await page.getByTestId('login-submit').click();
  await expect(page.getByRole('heading',{name:'我的账号'})).toBeVisible();
  // Verify the HTTP server actually points at the same synthetic fixture BEFORE writes.
  const initial=await view(page,ids.B!);expect(initial.order.primary_guest_snapshot.fullName).toBe(guestName(group,'B'));
  await collect(page,ids.A!,group,'400');
  const partialResponse=await page.request.get(`/api/v2/external-payments?propertyId=${propertyId}&kind=COLLECTION&status=ALL&query=${encodeURIComponent(paymentReference(group))}`);
  expect(partialResponse.ok()).toBe(true);
  const partial=(await partialResponse.json()).items.find((x:{reference:string})=>x.reference===paymentReference(group));
  expect(partial.remainingMinor).toBe(60000);expect(partial.status).toBe('PARTIALLY_MATCHED');
  await collect(page,ids.B!,group,'600');
  await page.goto(`/orders/${ids.B}`);
  await page.getByRole('button',{name:'取消订单',exact:true}).click();
  await page.getByTestId('lifecycle-reason').fill('合成验收：客户取消B，尚未退款');
  await page.getByRole('button',{name:'继续核对',exact:true}).click();await confirm(page);
  await page.reload();
  const cancelled=await view(page,ids.B!);expect(cancelled.order.status).toBe('CANCELLED');expect(cancelled.amounts.netRecordedCollection.minorUnits).toBe(60000);
  expect(cancelled.collectionFacts.filter((f:{fact_type:string})=>f.fact_type==='REFUND')).toHaveLength(0);
  await expect(page.getByTestId('order-amounts').getByText('已记录净收款',{exact:true})).toBeVisible();
  await expect(page.getByTestId('order-amounts').getByText('已记录净收款',{exact:true}).locator('..')).toContainText('600.00');
  await page.screenshot({path:info.outputPath('cancelled-unrefunded-600.png'),fullPage:true});
  const owner=`合成验收-${group}-款项归属客户`;
  await page.getByRole('button',{name:'登记客户留存',exact:true}).click();
  await page.getByLabel('款项归属客户',{exact:true}).fill(owner);
  await page.getByLabel('联系方式 / 核验依据').fill('合成客户编号；不是真实联系方式');
  await fillRetained(page,'600','合成验收：已核实客户要求保留600供下次使用');
  expect((await retained(page,ids.B!))[0].remainingMinor).toBe(60000);
  await page.goto('/orders');await page.getByLabel('资金视图').selectOption('RETAINED');
  await page.getByLabel('搜索客户 / 联系方式 / 来源订单').fill(owner);
  const row=page.getByRole('row').filter({hasText:owner});await expect(row).toContainText('600.00');await expect(row).toContainText(ids.B!);
  await page.screenshot({path:info.outputPath('retained-funds-list-600.png'),fullPage:true});
  await page.goto(`/orders/${ids.C}`);await page.getByRole('button',{name:'使用客户留存款',exact:true}).click();
  await page.getByLabel('搜索客户 / 联系方式 / 来源订单').fill(owner);
  await page.getByRole('row').filter({hasText:owner}).getByRole('button',{name:'选择并核对归属'}).click();
  await fillRetained(page,'400','合成验收：款项归属客户明确授权为C入住人代订并使用400元',true);
  expect((await retained(page,ids.B!))[0].remainingMinor).toBe(20000);
  expect((await view(page,ids.C!)).amounts.netRecordedCollection.minorUnits).toBe(40000);
  // Import only now: pre-importing refunds correctly freezes the collection.
  await syncSyntheticPayment(group,'REFUND');
  await page.goto(`/orders/${ids.B}`);await page.getByRole('button',{name:'登记留存款实际退款',exact:true}).click();
  await selectBill(page,refundReference(group),true);
  await fillRetained(page,'200','合成验收：模拟渠道已成功退款200，仅登记，不发起支付');
  const funds=(await retained(page,ids.B!))[0];expect(funds.remainingMinor).toBe(0);expect(funds.usedMinor).toBe(40000);expect(funds.refundedMinor).toBe(20000);
  expect((await view(page,ids.A!)).amounts.netRecordedCollection.minorUnits).toBe(40000);
  expect((await view(page,ids.B!)).amounts.netRecordedCollection.minorUnits).toBe(0);
  expect((await view(page,ids.C!)).amounts.netRecordedCollection.minorUnits).toBe(40000);
  const finalViews=await Promise.all(Object.values(ids).map(id=>view(page,id)));
  const facts=finalViews.flatMap(v=>v.collectionFacts) as Array<{fact_type:string;amount_minor:number}>;
  const total=(kind:string)=>facts.filter(f=>f.fact_type===kind).reduce((n,f)=>n+f.amount_minor,0);
  expect(total('COLLECTION')).toBe(100000);expect(total('REFUND')).toBe(20000);
  expect(total('REALLOCATION_OUT')).toBe(40000);expect(total('REALLOCATION_IN')).toBe(40000);
  const finalPayments=await page.request.get(`/api/v2/external-payments?propertyId=${propertyId}&kind=COLLECTION&status=ALL&query=${encodeURIComponent(paymentReference(group))}`);
  expect(finalPayments.ok()).toBe(true);
  expect((await finalPayments.json()).items.find((x:{reference:string})=>x.reference===paymentReference(group)).remainingMinor).toBe(0);
  await page.goto('/orders');await page.getByLabel('资金视图').selectOption('RETAINED');await page.getByLabel('搜索客户 / 联系方式 / 来源订单').fill(owner);
  await expect(page.getByText('没有符合条件的留存记录。')).toBeVisible();
  await page.getByLabel('包含已处理历史').check();await expect(page.getByRole('row').filter({hasText:owner})).toContainText('200.00');
  await page.screenshot({path:info.outputPath('retained-settled-history.png'),fullPage:true});expect(errors).toEqual([]);
});
