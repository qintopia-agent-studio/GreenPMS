import { describe, expect, it } from "vitest";
import { communityEvents } from "./dashboard-community";
const order={id:"order",status:"CHECKED_OUT",departure_date:"2026-10-12"};
const shorten={id:"shorten",order_id:"order",amendment_type:"SHORTEN_STAY",payload:{completionMode:"EARLY_CHECK_OUT",before:{departureDate:"2026-10-15"},after:{departureDate:"2026-10-12"}},command_id:"command",sequence:2,reason_note:"工作行程调整",created_at:new Date("2026-10-12")};
const checkout={...shorten,id:"checkout",amendment_type:"CHECK_OUT",sequence:3,payload:{}};
const local=(date:Date)=>date.toISOString().slice(0,10);
describe("community effective departure evidence",()=>{
 it("reads before/after dates and reason from the applied early checkout",()=>{expect(communityEvents([order],[shorten,checkout],local)).toEqual([{orderId:"order",date:"2026-10-12",nights:3,reason:"工作行程调整",kind:"EARLY"}])});
 it("excludes revoked early checkout",()=>{expect(communityEvents([order],[shorten,checkout,{...checkout,id:"reversal",amendment_type:"REVOKE_CHECK_OUT",sequence:4,payload:{checkoutAmendmentId:"checkout"}}],local)).toEqual([])});
 it("does not mistake future shortening for actual departure",()=>{expect(communityEvents([order],[{...shorten,payload:{...shorten.payload,completionMode:"SHORTEN_IN_HOUSE"}},checkout],local)).toEqual([])});
 it("requires paired committed checkout and matching final departure",()=>{expect(communityEvents([order],[shorten],local)).toEqual([]);expect(communityEvents([{...order,departure_date:"2026-10-14"}],[shorten,checkout],local)).toEqual([])});
 it("excludes unreturned or cancelled final states",()=>{expect(communityEvents([{...order,status:"CHECKED_IN"}],[shorten,checkout],local)).toEqual([]);expect(communityEvents([{...order,status:"CANCELLED"}],[shorten,checkout],local)).toEqual([])});
});
