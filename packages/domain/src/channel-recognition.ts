import { DomainError } from '@qintopia/contracts';
/** 合同变动与真实退款分开；未完成退款的余额不能被同价操作再次认成销售。 */
export function channelRecognitionDelta(kind:'SALE'|'CORRECTION',prior:number,net:bigint,target:number):number {
 if(!Number.isSafeInteger(prior)||!Number.isSafeInteger(target)||prior<0||target<0||prior>2147483600||target>2147483600||net<0n)throw new DomainError('VALIDATION_ERROR','渠道金额超出支持范围');
 if(kind==='CORRECTION'){
  if(net<BigInt(prior))throw new DomainError('VALIDATION_ERROR','渠道当前应结与已计余额不一致，请先核对历史资料');
  // 当前待退/待结部分尚未降低已确认收入，更正它不应凭空增加或减少已收/应结事实。
  return net===BigInt(prior)?target-prior:Number(BigInt(target)>net?BigInt(target)-net:0n);
 }
 if(target<=prior)return 0;
 if(net<BigInt(prior))throw new DomainError('VALIDATION_ERROR','渠道当前应结与已计余额不一致，请先核对历史资料');
 return Number(BigInt(target)>net?BigInt(target)-net:0n);
}
