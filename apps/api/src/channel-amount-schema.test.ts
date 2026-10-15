import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { CommandEffectSchema, CommandEnvelopeSchema } from "./schemas";
import { validateOrderTargetAmount } from "@qintopia/domain";

describe("渠道金额接口和权威订单校验", () => {
  it.each([
    ["CREATE_ORDER", { propertyId:"prop_test", quoteId:"quote_test", primaryGuest:{fullName:"测试",nickname:"测试"},bookingChannelCode:"YOUMUDAO",channelOrderReference:"test" }],
    ["REPRICE_ORDER",{propertyId:"prop_test",orderId:"order_test"}],
    ["EXTEND_STAY",{propertyId:"prop_test",orderId:"order_test",newDepartureDate:"2026-10-20"}],
    ["RESCHEDULE_STAY",{propertyId:"prop_test",orderId:"order_test",newArrivalDate:"2026-10-15",newDepartureDate:"2026-10-20"}],
    ["SHORTEN_STAY",{propertyId:"prop_test",orderId:"order_test",newDepartureDate:"2026-10-20"}],
    ["MOVE_UNIT",{propertyId:"prop_test",orderId:"order_test",newInventoryUnitId:"unit_test",effectiveDate:"2026-10-15"}]
  ])("%s允许整数分但拒绝分以下精度",(commandType,input) => {
    const envelope = {commandType,input:{...input,targetCurrentContractAmountMinor:27720}};
    expect(Value.Check(CommandEnvelopeSchema,envelope)).toBe(true);
    for(const amount of [27720.1,-1,2147483601]) {
      expect(Value.Check(CommandEnvelopeSchema,{...envelope,input:{...envelope.input,targetCurrentContractAmountMinor:amount}})).toBe(false);
    }
  });
  it("不信任请求传入的渠道，按已加载订单渠道验证", () => {
    expect(validateOrderTargetAmount("YOUMUDAO",27720)).toBe(27720);
    expect(()=>validateOrderTargetAmount("WECOM",27720)).toThrow(/whole-yuan/);
    expect(()=>validateOrderTargetAmount(null,27720)).toThrow(/whole-yuan/);
  });
});


it("渠道调价回执保留渠道证据，不被严格响应契约丢弃", () => {
  const money = (minorUnits: number) => ({currency:"CNY",minorUnits});
  const effect = {orderId:"order_test",inventoryUnitId:"unit_test",stayTimeline:[{serviceDate:"2026-09-21",inventoryUnitId:"unit_test"}],
    bookingChannelCode:"YOUMUDAO",before:{currentContractAmount:money(27600)},policyBaseAmount:money(30800),targetCurrentContractAmount:money(27720),manualAdjustmentMinor:-3080,
    pricing:{coverageSet:[],cashLines:[],cashRemainder:money(30800),currentContractAmount:money(27720)}};
  expect(Value.Check(CommandEffectSchema,effect)).toBe(true);
  expect(Value.Check(CommandEffectSchema,{...effect,bookingChannelCode:"UNKNOWN"})).toBe(false);
});
