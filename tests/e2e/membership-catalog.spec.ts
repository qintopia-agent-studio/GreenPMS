import { expect, test } from "@playwright/test";
test("administrator configures, edits, stops and copies membership products",async({page},info)=>{
 test.setTimeout(60000);
 await page.goto("/");await page.getByTestId("login-username").fill("admin");await page.getByTestId("login-password").fill("demo-pass-2026");await page.getByTestId("login-submit").click();await expect(page.getByRole("heading",{name:"房间与床位逐日房态"}).or(page.getByRole("heading",{name:"房态任务",exact:true}))).toBeVisible();
 await page.goto("/settings/memberships");await expect(page.getByRole("heading",{name:"会员产品",exact:true})).toBeVisible();
 const name=`可配置验收-${info.project.name}`;
 await page.getByRole("button",{name:"新增产品",exact:true}).click();
 const editor = page.getByRole("dialog");
 await editor.getByRole("button", { name: "总夜数说明", exact: true }).click();
 const help = editor.getByRole("tooltip");
 await expect(help).toBeVisible();
 await expect(help).toContainText("不是每种房型各有一份额度");
 const bounds = await help.boundingBox();
 expect(bounds).not.toBeNull();
 expect(bounds!.x).toBeGreaterThanOrEqual(0);
 expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
 await page.keyboard.press("Escape");
 await expect(help).toBeHidden();
 await expect(editor).toBeVisible();
 await page.getByLabel("产品名称",{exact:true}).fill(name);await page.getByLabel("售价（元）",{exact:true}).fill("1800");await page.getByLabel("总夜数",{exact:true}).fill("20");
 await page.getByLabel("标间（独卫）（间夜）",{exact:true}).check();await page.getByLabel("大床房（独卫）（间夜）",{exact:true}).check();
 await page.getByLabel("有效期",{exact:true}).fill("6");await page.getByRole("combobox",{name:"期限单位",exact:true}).selectOption("M",{timeout:10000});
 await page.getByRole("button",{name:"核对产品",exact:true}).click();await expect(page.getByTestId("command-effect")).toContainText("20 间夜");
 await page.getByTestId("reason-note").fill("合成浏览器验收");await page.getByTestId("command-return-to-edit").click();await expect(page.getByLabel("产品名称",{exact:true})).toHaveValue(name);await expect(page.getByLabel("总夜数",{exact:true})).toHaveValue("20");await page.getByRole("button",{name:"核对产品",exact:true}).click();await expect(page.getByTestId("reason-note")).toHaveValue("合成浏览器验收");await page.getByTestId("confirm-command").click();
 const card=page.getByTestId("membership-product-row").filter({has:page.getByRole("heading",{name,exact:true})});await expect(card).toBeVisible();await expect(card).toContainText("6 个月");

 // Cancelling a returned draft must not leak its reason into a different operation.
 await card.getByRole("button",{name:"编辑",exact:true}).click();
 await page.getByRole("button",{name:"核对产品",exact:true}).click();
 await page.getByTestId("reason-note").fill("此修改已取消");
 await page.getByTestId("command-return-to-edit").click();
 await page.getByRole("dialog").getByRole("button",{name:"取消",exact:true}).click();
 await card.getByRole("button",{name:"停售",exact:true}).click();
 await expect(page.getByTestId("reason-note")).toHaveValue("");
 await page.getByRole("dialog").getByRole("button",{name:"关闭",exact:true}).click();

 const commit=async()=>{await expect(page.getByTestId("confirm-command")).toBeEnabled();await page.getByTestId("confirm-command").click();await expect(page.locator("dialog.modal-wide")).toBeHidden({timeout:15000});};
 await page.goto("/members");await page.getByTestId("create-member").click();
 await page.getByTestId("member-full-name").fill(`配置套餐会员-${info.project.name}`);await page.getByTestId("member-nickname").fill(`配置套餐会员-${info.project.name}`);
 await page.getByTestId("member-identity-card").fill(`E2E-CATALOG-${info.project.name}`);await page.getByTestId("member-phone").fill(info.project.name==="desktop"?"13999110001":"13999110002");await page.getByTestId("member-wechat").fill(`catalog-${info.project.name}`);
 await page.getByRole("button",{name:"核对并创建",exact:true}).click();await commit();await expect(page.getByRole("heading",{name:`配置套餐会员-${info.project.name}`,exact:true})).toBeVisible();const memberUrl=page.url();
 await page.getByTestId("create-membership-order").click();await page.getByTestId("membership-product").selectOption({label:`${name} · ¥1,800.00`});await expect(page.getByLabel("会员产品信息")).toContainText("6 个月");await expect(page.getByTestId("membership-agreed-price-yuan")).toHaveValue("1800");
 await page.getByRole("button",{name:"核对会员订单",exact:true}).click();await commit();await expect(page.getByTestId("membership-order-item")).toContainText("待生效");await page.goto("/settings/memberships");
 await card.getByRole("button",{name:"编辑",exact:true}).click();await page.getByLabel("售价（元）",{exact:true}).fill("1900");await page.getByRole("button",{name:"核对产品",exact:true}).click();await expect(page.getByTestId("command-effect")).toContainText("修改前");await page.getByTestId("reason-note").fill("合成改价");await page.getByTestId("confirm-command").click();await expect(card).toContainText("1,900");
 await card.getByRole("button",{name:"停售",exact:true}).click();await expect(page.getByTestId("command-effect")).toContainText("停售");await page.getByTestId("reason-note").fill("合成停售");await page.getByTestId("confirm-command").click();await expect(card.getByRole("button",{name:"恢复销售",exact:true})).toBeVisible();
 await card.getByRole("button",{name:"复制",exact:true}).click();await expect(page.getByLabel("产品名称",{exact:true})).toHaveValue(name);await page.getByLabel("产品名称",{exact:true}).fill(`${name}-副本`);await page.getByRole("button",{name:"核对产品",exact:true}).click();await page.getByTestId("reason-note").fill("合成复制");await page.getByTestId("confirm-command").click();await expect(page.getByRole("heading",{name:`${name}-副本`,exact:true})).toBeVisible();
 await page.goto(memberUrl);const order=page.getByTestId("membership-order-item");await expect(order).toContainText("1,800");await order.getByTestId("record-membership-payment").click();await page.getByTestId("membership-payment-yuan").fill("1800");await page.getByTestId("membership-payment-reference").fill(`CATALOG-PAY-${info.project.name}`);await page.getByRole("button",{name:"核对收款信息",exact:true}).click();await commit();
 await order.getByTestId("activate-membership-order").click();await expect(page.getByTestId("command-effect")).toContainText("20 间夜");await commit();await expect(order.getByTestId("membership-activation-summary")).toContainText("已发放 20 间夜");await expect(order).toContainText("1,800");

});

test("membership preview rejects forged evidence and recovers a lost receipt without another confirm", async ({page},info) => {
 test.setTimeout(60000);
 test.skip(info.project.name!=="desktop","桌面验证协议，手机另测完整操作");
 await page.goto("/");await page.getByTestId("login-username").fill("admin");await page.getByTestId("login-password").fill("demo-pass-2026");await page.getByTestId("login-submit").click();await expect(page.getByRole("heading",{name:"房间与床位逐日房态"})).toBeVisible();
 await page.goto("/settings/memberships");
 const card=page.getByTestId("membership-product-row").filter({has:page.getByRole("heading",{name:"可配置验收-desktop-副本",exact:true})});
 await page.route("**/api/v1/command-previews",async route=>{const response=await route.fetch();const body=await response.json();body.preview.effect.after.current.currency=undefined;await route.fulfill({response,json:body});},{times:1});
 await card.getByRole("button",{name:"停售",exact:true}).click();await expect(page.getByTestId("confirm-command")).toBeDisabled();await page.getByRole("dialog").getByRole("button",{name:"关闭",exact:true}).click();
 let confirms=0;let key="";
 await page.route("**/api/v1/command-previews/*/confirm",async route=>{confirms++;key=route.request().headers()["idempotency-key"]??"";const response=await route.fetch();expect(response.status()).toBe(200);await route.abort("failed");},{times:1});
 await card.getByRole("button",{name:"停售",exact:true}).click();await page.getByTestId("reason-note").fill("合成丢回执恢复");await page.getByTestId("confirm-command").click();
 await expect(page.getByRole("button",{name:"查询原操作结果",exact:true})).toBeVisible();await page.getByTestId("command-close").click();await page.reload();
 await page.getByTestId("command-recovery").getByRole("button").click();
 const resolved=page.waitForResponse(response=>response.url().endsWith("/api/v1/command-results/resolve")&&response.request().postDataJSON().idempotencyKey===key&&response.status()===200);
 await page.getByRole("button",{name:"查询原操作结果",exact:true}).click();await resolved;
 await expect(card.getByRole("button",{name:"恢复销售",exact:true})).toBeVisible();expect(confirms).toBe(1);
});
