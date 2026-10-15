import {describe,expect,it} from 'vitest';
import {channelRecognitionDelta as delta} from './channel-recognition';
describe('渠道金额变动只确认真实新增部分',()=>{
 it('同价或降价不因历史退款/待结差额补回收入',()=>{
  expect(delta('SALE',30000,20000n,30000)).toBe(0);
  expect(delta('SALE',30000,30000n,20000)).toBe(0);
  expect(delta('SALE',20000,30000n,25000)).toBe(0);
  expect(delta('SALE',20000,30000n,35000)).toBe(5000);
 });
 it('原成交角分错误更正精确归属，不把待退金额当新增',()=>{
  expect(delta('CORRECTION',161000,161000n,161028)).toBe(28);
  expect(delta('CORRECTION',27600,27600n,27720)).toBe(120);
  expect(delta('CORRECTION',20000,30000n,30000)).toBe(0);
  expect(delta('CORRECTION',20000,30000n,15000)).toBe(0);
  expect(delta('CORRECTION',20000,30000n,35000)).toBe(5000);
 });
 it('不以新成交或退款悄悄修复不一致的期初金额',()=>{
  expect(()=>delta('SALE',30000,20000n,35000)).toThrow(/历史资料/);
  expect(()=>delta('CORRECTION',30000,20000n,25000)).toThrow(/历史资料/);
 });
});
