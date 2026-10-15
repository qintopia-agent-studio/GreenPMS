/** 一次性期初承接；默认只读校验，写入要求数据库所有者及精确计划SHA。无生产默认连接。 */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
interface Opening {sourceKind:'PAYMENT_BILL'|'STAY_FACT'|'MEMBER_FACT'|'CHANNEL_REFUND';sourceId:string;amountMinor:string;evidenceNote:string}
interface Plan {unresolved?:string[];propertyId:string;recognitionFrom:string;currency:string;baselines:Array<{month:string;amountMinor:string;evidenceNote:string}>;opening:Opening[]}
function ensure(condition:unknown,message:string):asserts condition {if(!condition)throw new Error(message)}
const args=process.argv.slice(2);const at=(flag:string)=>args.indexOf(flag)>=0?args[args.indexOf(flag)+1]:undefined;
async function main(){
 const path=at('--plan');ensure(path,'必须显式指定--plan');
 const data=await readFile(path);const sha=createHash('sha256').update(data).digest('hex');
 const plan=JSON.parse(data.toString()) as Plan;
 ensure(typeof plan.propertyId==='string'&&/^\d{4}-\d{2}-01$/.test(plan.recognitionFrom)&&Array.isArray(plan.opening)&&Array.isArray(plan.baselines)&&plan.baselines.length>0,'计划结构无效');
 const write=args.includes('--apply');ensure(!write||!plan.unresolved?.length,'尚有未解决的期初来源，不能启用正式统计');ensure(!write||at('--expected-sha')===sha,'写入必须提供完全匹配的--expected-sha，计划变化不得自动重试');
 const connectionString=process.env.MIGRATION_DATABASE_URL??process.env.DATABASE_URL;ensure(connectionString,'必须显式配置测试或获准目标数据库；无默认连接');
 const client=new pg.Client({connectionString,connectionTimeoutMillis:10000,options:'-c statement_timeout=30000 -c lock_timeout=5000'});
 try{await client.connect();await client.query(write?'BEGIN ISOLATION LEVEL SERIALIZABLE':'BEGIN READ ONLY');
  const identity=(await client.query(`SELECT current_user=pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=current_database()`)).rows[0];
  ensure(!write||identity.owner,'写入只允许目标数据库所有者，运行身份不能配置封账基准');
  const property=(await client.query('SELECT currency,timezone FROM properties WHERE id=$1',[plan.propertyId])).rows[0];ensure(property&&property.currency===plan.currency,'门店或币种不一致');
  const keys=new Set<string>();
  for(const row of plan.opening){
   ensure(['PAYMENT_BILL','STAY_FACT','MEMBER_FACT','CHANNEL_REFUND'].includes(row.sourceKind)&&typeof row.sourceId==='string'&&/^\d+$/.test(row.amountMinor)&&row.evidenceNote?.trim(),'期初来源必须有有效金额及依据');
   const key=`${row.sourceKind}:${row.sourceId}`;ensure(!keys.has(key),`来源重复：${key}`);keys.add(key);
   ensure(BigInt(row.amountMinor).toString()===row.amountMinor,'期初金额必须使用规范整数分字符串');
   const applied=(await client.query('SELECT amount_minor::text AS amount,currency FROM operating_sales_opening WHERE property_id=$1 AND source_kind=$2 AND source_id=$3',[plan.propertyId,row.sourceKind,row.sourceId])).rows[0];
   if(applied){ensure(applied.amount===row.amountMinor&&applied.currency===plan.currency,'已有期初来源与计划不同，禁止覆盖');continue;}
   let source:{amount:string;currency:string;contract?:number}|undefined;
   if(row.sourceKind==='PAYMENT_BILL')source=(await client.query(`SELECT amount_minor::text AS amount,'CNY'::text AS currency FROM external_payment_bills WHERE property_id=$1 AND id=$2 AND kind='COLLECTION' AND state='SUCCESS' AND NOT needs_review`,[plan.propertyId,row.sourceId])).rows[0];
   if(row.sourceKind==='STAY_FACT')source=(await client.query(`SELECT f.amount_minor::text AS amount,f.currency FROM collection_facts f JOIN orders o ON o.id=f.order_id WHERE o.property_id=$1 AND f.fact_id=$2 AND f.fact_type='COLLECTION' AND NOT EXISTS(SELECT 1 FROM collection_facts rev WHERE rev.reverses_fact_id=f.fact_id AND rev.created_at<($3::date::timestamp AT TIME ZONE $4) AND NOT EXISTS(SELECT 1 FROM stay_collection_membership_transfers t WHERE t.source_reversal_fact_id=rev.fact_id AND t.source_collection_fact_id=f.fact_id AND t.property_id=o.property_id))`,[plan.propertyId,row.sourceId,plan.recognitionFrom,property.timezone])).rows[0];
   if(row.sourceKind==='MEMBER_FACT')source=(await client.query(`SELECT f.amount_minor::text AS amount,f.currency FROM membership_payment_facts f JOIN membership_orders o ON o.id=f.membership_order_id WHERE o.property_id=$1 AND f.fact_id=$2 AND f.fact_type='COLLECTION' AND f.source_type<>'STAY_COLLECTION_TRANSFER' AND NOT EXISTS(SELECT 1 FROM membership_payment_facts rev WHERE rev.reverses_fact_id=f.fact_id AND rev.created_at<($3::date::timestamp AT TIME ZONE $4))`,[plan.propertyId,row.sourceId,plan.recognitionFrom,property.timezone])).rows[0];
   if(row.sourceKind==='CHANNEL_REFUND')source=(await client.query(`SELECT sum(amount_minor)::text AS amount,min(currency) AS currency,(SELECT p.current_contract_amount_minor FROM orders o JOIN pricing_revisions p ON p.id=o.current_revision_id WHERE o.property_id=$1 AND o.id=$2) AS contract FROM channel_operating_facts WHERE property_id=$1 AND order_id=$2 HAVING count(*)>0`,[plan.propertyId,row.sourceId])).rows[0];
   ensure(source&&source.currency===plan.currency&&BigInt(row.amountMinor)<=BigInt(source.amount)&&BigInt(row.amountMinor)>=0n,`期初来源不存在、币种不符或超过可证明金额：${key}`);
   if(row.sourceKind==='CHANNEL_REFUND')ensure(Number.isSafeInteger(source.contract)&&BigInt(source.contract!)<=BigInt(source.amount)-BigInt(row.amountMinor),`期初退款与当前渠道应结不一致：${key}；须先核对历史应结，不在登记新退款时顺带补改旧金额`);
  }
  for(const b of plan.baselines){
   ensure(/^\d{4}-\d{2}-01$/.test(b.month)&&b.month<plan.recognitionFrom&&/^-?\d+$/.test(b.amountMinor)&&b.evidenceNote?.trim(),'封账月份必须在新口径之前，并提供金额及依据');
   ensure(BigInt(b.amountMinor).toString()===b.amountMinor,'封账金额必须使用规范整数分字符串');
   const existing=(await client.query('SELECT amount_minor::text AS amount,recognition_from::text AS start,evidence_sha256 AS hash FROM operating_sales_baselines WHERE property_id=$1 AND month=$2 AND currency=$3',[plan.propertyId,b.month,plan.currency])).rows[0];
   if(existing)ensure(existing.amount===b.amountMinor&&existing.start===plan.recognitionFrom&&existing.hash===sha,'已有封账基准不同，禁止覆盖或无依据重开');
  }
  if(write){
   await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`operating-sales-opening:${plan.propertyId}`]);
   for(const row of plan.opening){
    const existing=(await client.query('SELECT amount_minor::text AS amount,currency FROM operating_sales_opening WHERE property_id=$1 AND source_kind=$2 AND source_id=$3',[plan.propertyId,row.sourceKind,row.sourceId])).rows[0];
    if(existing){ensure(existing.amount===row.amountMinor&&existing.currency===plan.currency,'已有期初来源与计划不同，禁止覆盖');continue;}
    await client.query('INSERT INTO operating_sales_opening(property_id,source_kind,source_id,amount_minor,currency,evidence_note) VALUES($1,$2,$3,$4,$5,$6)',[plan.propertyId,row.sourceKind,row.sourceId,row.amountMinor,plan.currency,`${row.evidenceNote}; plan_sha256=${sha}`]);
   }
   for(const b of plan.baselines){
    const existing=(await client.query('SELECT amount_minor::text AS amount,recognition_from::text AS start,evidence_sha256 AS hash FROM operating_sales_baselines WHERE property_id=$1 AND month=$2 AND currency=$3',[plan.propertyId,b.month,plan.currency])).rows[0];
    if(existing){ensure(existing.amount===b.amountMinor&&existing.start===plan.recognitionFrom&&existing.hash===sha,'已有封账基准不同，禁止覆盖或无依据重开');continue;}
    await client.query('INSERT INTO operating_sales_baselines(property_id,month,amount_minor,currency,recognition_from,evidence_note,evidence_sha256) VALUES($1,$2,$3,$4,$5,$6,$7)',[plan.propertyId,b.month,b.amountMinor,plan.currency,plan.recognitionFrom,b.evidenceNote,sha]);
   }
   await client.query('COMMIT');
  }else await client.query('ROLLBACK');
  console.log(JSON.stringify({status:write?'applied':'validated_read_only',planSha256:sha,propertyId:plan.propertyId,sources:plan.opening.length,baselines:plan.baselines.length,unresolved:plan.unresolved??[]}));
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}finally{await client.end()}
}
void main().catch(error=>{console.error(JSON.stringify({status:'failed',message:error instanceof Error?error.message:String(error)}));process.exitCode=1});
