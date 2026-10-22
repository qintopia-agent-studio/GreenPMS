import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { CurrentScene, CommunitySnapshot, CommunityPanels, ResidentPeopleList } from "./CommunityPanels";
import { sampleDashboard } from "./preview/sample";

describe("production-shaped registrations render without documents",()=>{
 it("shows registration facts with an explicit basis, without changing unique visitor values",()=>{
  const data=sampleDashboard("sample-a","","zero");
  data.community.current={date:data.businessDate,total:null,paid:0,volunteer:0,reception:0,otherFree:0,unlinked:36,registered:{total:36,paid:31,volunteer:5,reception:0,otherFree:0}};
  data.community.trend=[{...data.community.current,date:data.range.to}];
  data.community.dailyAverage=null;data.community.visitors=null;
  const scene=renderToStaticMarkup(<MemoryRouter><CurrentScene data={data} onDetail={()=>{}}/></MemoryRouter>);
  const trend=renderToStaticMarkup(<MemoryRouter><CommunityPanels data={data}/></MemoryRouter>);
  expect(scene).toContain('36');expect(scene).toContain('31');expect(scene).toContain('登记在住人数');expect(scene).toContain('尚未跨单去重');
  expect(trend).toContain('日均登记在住');expect(trend).toContain('本期去重接待');expect(trend).toContain('尚不完整');
  expect(scene).toContain('当日居民数');expect(scene).toContain('在住会员');
  expect(data.community.current.total).toBeNull();expect(data.community.visitors).toBeNull();
 });
});


it("今日指标与31人登记总数均可见，不将其标成跨单去重人数",()=>{
 const data=sampleDashboard("sample-a","","zero");
 data.community.current={date:data.businessDate,total:null,paid:0,volunteer:0,reception:0,otherFree:0,unlinked:31,registered:{total:31,paid:26,volunteer:5,reception:0,otherFree:0}};
 data.current.todayOrders=3;data.current.todayCollections=[{currency:"CNY",amountMinor:"27720",count:1}];
 const html=renderToStaticMarkup(<MemoryRouter><CurrentScene data={data} onDetail={()=>{}}/></MemoryRouter>);
 expect(html).toContain("今日新增订单");expect(html).toContain("今日登记金额");expect(html).toContain("¥277.20");
 expect(html).toMatch(/31/);expect(html).toContain("登记在住人数");expect(html).toContain("尚未跨单去重");
 expect(data.community.current.total).toBeNull();
});

it("labels approximate nickname-based headcounts and keeps return records explicitly in条", async () => {
 const { ResidenceChanges } = await import("./ResidenceChanges");
 const data=sampleDashboard("sample-a","","complete");
 data.community.identityApproximate=true;
 const html=renderToStaticMarkup(<MemoryRouter><CommunitySnapshot data={data} onDetail={()=>{}}/><CommunityPanels data={data}/><ResidenceChanges data={data}/></MemoryRouter>);
 expect(html).toContain("昵称/姓名近似去重人数");
 expect(html).toContain("续住与回访为近似统计");
 expect(html).toContain("再次入住记录 · 按条计");
});

it("会员缺项保留已确认人数和核对入口，不用待核对替代全部居民", () => {
 const data=sampleDashboard("sample-a","","zero");
 data.community.residentCurrent={date:data.businessDate,total:null,longStay:25,member:null,memberReview:2,knownTotal:25,knownMember:1,residentReview:1,reviewItems:[{orderId:"sample-identity-review",memberId:"sample-member",reason:"住客日期或权益使用记录缺少依据"}]};
 const html=renderToStaticMarkup(<MemoryRouter><CurrentScene data={data} onDetail={()=>{}}/></MemoryRouter>);
 expect(html).toContain('25<small>人 · 已确认');
 expect(html).toContain('1<small>人 · 已确认');
 expect(html).toContain('另 1 条待核对');
 expect(html).toContain('查看在住名单');
});

it("非会员追加住客缺实际日期时，也能打开居民核对记录", () => {
 const data=sampleDashboard("sample-a","","zero");
 data.community.residentCurrent={date:data.businessDate,total:null,longStay:1,member:0,memberReview:0,knownTotal:1,knownMember:0,residentReview:1,reviewItems:[{orderId:"sample-dates-review",memberId:null,reason:"追加住客缺少实际入住日期"}]};
 const html=renderToStaticMarkup(<MemoryRouter><CurrentScene data={data} onDetail={()=>{}}/></MemoryRouter>);
 expect(html).toContain("核对居住日期");
 expect(html).toContain("另 1 条待核对");
});

it("没有待核对记录时仍可展开已确认会员名单", () => {
 const data=sampleDashboard("sample-a","","zero");
 data.community.residentCurrent={date:data.businessDate,total:1,longStay:0,member:1,memberReview:0,
   memberItems:[{orderId:"ordinary",memberId:"member",occupantId:"guest",occupantName:"阿青（青女士）",memberName:"阿青（青女士）",roomCode:"201",arrivalDate:"2026-10-17",departureDate:"2026-10-25",basis:"MEMBER_ENTITLEMENT"}]};
 const html=renderToStaticMarkup(<MemoryRouter><CurrentScene data={data} onDetail={()=>{}}/></MemoryRouter>);
 expect(html).toContain("查看在住名单"); expect(html).toContain('aria-expanded="false"');
 const list=renderToStaticMarkup(<MemoryRouter><ResidentPeopleList resident={data.community.residentCurrent}/></MemoryRouter>);
 expect(list).toContain("会员权益住宿"); expect(list).toContain("阿青（青女士）");
 expect(list).toContain("使用会员权益"); expect(list).toContain("2026-10-17 至 2026-10-25");
 expect(list).toContain('href="/orders/ordinary"'); expect(list).toContain('href="/members?memberId=member"');
 expect(list).not.toContain("待核对登记");
});

it("展开名单直接显示每位住客、关联会员和短原因，不再要求猜测记录编号", () => {
 const resident={date:"2026-10-22",total:null,longStay:0,member:null,memberReview:2,knownMember:1,
   memberItems:[{orderId:"known",memberId:"known-member",occupantId:"known-guest",occupantName:"已确认住客",memberName:"已确认会员",basis:"MEMBER_ENTITLEMENT" as const}],
   reviewItems:[{orderId:"shared",memberId:"payer",occupantId:"guest-a",occupantName:"小溪（林女士）",memberName:"大树（王先生）",roomCode:"202",arrivalDate:"2026-10-20",departureDate:"2026-10-25",reasonLabel:"权益使用记录待核对",reason:"权益覆盖与核销事实的关联不完整。"},
     {orderId:"shared",memberId:"payer",occupantId:"guest-b",occupantName:"小叶",memberName:"大树（王先生）",reasonLabel:"实际在住日期待核对",reason:"该住客在入住后追加，独立入住日期尚未记录。"}]};
 const list=renderToStaticMarkup(<MemoryRouter><ResidentPeopleList resident={resident}/></MemoryRouter>);
 expect(list).toContain("会员权益住宿"); expect(list).toContain("待核对登记");
 expect(list).toContain("小溪（林女士）"); expect(list).toContain("小叶"); expect(list).toContain("大树（王先生）");
 expect(list).toContain("权益使用记录待核对"); expect(list).toContain("实际在住日期待核对");
 expect(list).toContain("本房间住期"); expect(list).toContain("2 条登记");
 expect(list).not.toContain("待核对记录 1"); expect(list).not.toContain("独立入住日期尚未记录");
 expect(list).toContain('aria-label="核对原因说明"');
});


it("权益住宿不把缺少会员档案当作身份核对，保留历史权益来源", () => {
 const resident={date:"2026-10-22",total:1,longStay:0,member:1,memberReview:0,memberItems:[{orderId:"legacy-order",memberId:null,occupantId:"guest",occupantName:"实际住客",memberName:"历史会员合同",roomCode:"201",arrivalDate:"2026-10-20",departureDate:"2026-10-25",basis:"MEMBER_ENTITLEMENT" as const}]};
 const list=renderToStaticMarkup(<MemoryRouter><ResidentPeopleList resident={resident}/></MemoryRouter>);
 expect(list).toContain("实际住客"); expect(list).toContain("历史会员合同"); expect(list).toContain("使用会员权益");
 expect(list).not.toContain("待核对登记"); expect(list).not.toContain("权益来源待核对"); expect(list).not.toContain("本人"); expect(list).not.toContain("证件身份");
});
