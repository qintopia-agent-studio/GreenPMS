import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { CommunitySnapshot, CommunityPanels } from "./CommunityPanels";
import { sampleDashboard } from "./preview/sample";

describe("production-shaped registrations render without documents",()=>{
 it("shows registration facts with an explicit basis, without changing unique visitor values",()=>{
  const data=sampleDashboard("sample-a","","zero");
  data.community.current={date:data.businessDate,total:null,paid:0,volunteer:0,reception:0,otherFree:0,unlinked:36,registered:{total:36,paid:31,volunteer:5,reception:0,otherFree:0}};
  data.community.trend=[{...data.community.current,date:data.range.to}];
  data.community.dailyAverage=null;data.community.visitors=null;
  const scene=renderToStaticMarkup(<MemoryRouter><CommunitySnapshot data={data} onDetail={()=>{}}/></MemoryRouter>);
  const trend=renderToStaticMarkup(<MemoryRouter><CommunityPanels data={data}/></MemoryRouter>);
  expect(scene).toContain('36');expect(scene).toContain('31');expect(scene).toContain('登记在住人数');expect(scene).toContain('尚未跨单去重');
  expect(trend).toContain('日均登记在住');expect(trend).toContain('本期去重接待');expect(trend).toContain('尚不完整');
  expect(data.community.current.total).toBeNull();expect(data.community.visitors).toBeNull();
 });
});
