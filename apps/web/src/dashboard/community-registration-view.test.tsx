import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { CurrentScene, CommunitySnapshot, CommunityPanels } from "./CommunityPanels";
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
