import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Locator } from "playwright-core";

async function assertSingleScroll(dialog: Locator) {
  const scrollers = await dialog.evaluate(root => [...root.querySelectorAll<HTMLElement>("*")]
    .filter(element => element.closest("dialog") === root
      && /^(auto|scroll)$/.test(getComputedStyle(element).overflowY)
      && element.scrollHeight > element.clientHeight + 1)
    .map(element => element.className));
  assert.ok(scrollers.length <= 1, `Only one vertical scroll area: ${scrollers.join(", ")}`);
  if (scrollers.length) assert.equal(scrollers[0], "modal-body");
}

async function main() {
  const base=process.env.WECOM_ACCEPTANCE_URL ?? "http://127.0.0.1:4219";
  if(new URL(base).hostname!=="127.0.0.1") throw Error("Local synthetic acceptance only");
  const collectionOrder=process.env.WECOM_COLLECTION_ORDER_ID;
  const refundOrder=process.env.WECOM_REFUND_ORDER_ID;
  if(!collectionOrder||!refundOrder)throw Error("Synthetic order IDs required");
  const evidence=resolve("docs/implementation/evidence/wecom-selector");await mkdir(evidence,{recursive:true});
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:960}});
  let localReads=0;
  const errors:string[]=[];
  page.on("pageerror",error=>errors.push(error.message));
  page.on("request",request=>{if(request.url().includes("/api/v1/external-payments?"))localReads++;});
  try {
    await page.goto(base);
    await page.getByLabel("账号",{exact:true}).fill("operator");
    await page.getByLabel("密码",{exact:true}).fill("demo-pass-2026");
    await page.getByTestId("login-submit").click();
    await page.getByLabel("账号",{exact:true}).waitFor({state:"hidden"});
    await page.goto(`${base}/orders/${collectionOrder}`);
    await page.getByRole("button",{name:"收款",exact:true}).click();
    let dialog=page.getByRole("dialog",{name:"登记收款",exact:true});
    await dialog.getByRole("button",{name:"选择企业微信收款",exact:true}).click();
    await dialog.locator(".external-payment-option").first().waitFor();
    assert.equal(await dialog.locator(".external-payment-option").count(),5);
    assert.match(await dialog.locator(".external-payment-option").first().innerText(),/小秦|山间晚风|旅途中的小林|周末来住|南方有雨|阿泽/);
    assert.equal(await dialog.getByRole("button",{name:/刷新收退款/}).count(),0);
    await assertSingleScroll(dialog);
    await page.screenshot({path:resolve(evidence,"desktop-recommendations.png"),fullPage:true});
    await dialog.locator(".external-payment-option").first().click();
    assert.equal(await dialog.getByTestId("fact-amount-yuan").inputValue(),"120");
    const chosen=await dialog.locator(".external-payment-trigger").innerText();
    const before=localReads;
    await page.waitForTimeout(16_000);
    assert.ok(localReads>before,"automatically rereads the PMS while preserving the provisional choice");
    assert.equal(await dialog.locator(".external-payment-trigger").innerText(),chosen);
    await dialog.getByRole("button",{name:"取消",exact:true}).click();
    await page.getByRole("button",{name:"收款",exact:true}).click();
    dialog=page.getByRole("dialog",{name:"登记收款",exact:true});
    await dialog.getByRole("button",{name:"选择企业微信收款",exact:true}).click();
    assert.equal(await dialog.locator(".external-payment-option").count(),5);
    await dialog.getByRole("button",{name:"查找完整清单",exact:true}).click();
    const full=page.getByRole("dialog",{name:"选择企业微信收款 · 完整清单",exact:true});
    await full.getByLabel("处理状态").selectOption("ALL");
    await full.getByLabel("付款人昵称 / 单号").fill("SYNTHETIC-PAID");
    const matched=full.locator(".external-payment-option").filter({hasText:"SYNTHETIC-PAID"});
    await matched.waitFor();assert.ok(await matched.isDisabled());assert.match(await matched.innerText(),/已匹配/);
    await full.getByLabel("付款人昵称 / 单号").fill("SYNTHETIC-HISTORY");
    const history=full.locator(".external-payment-option").filter({hasText:"SYNTHETIC-HISTORY"});
    await history.waitFor();assert.ok(await history.isDisabled());assert.match(await history.innerText(),/历史不纳入/);
    await full.getByLabel("付款人昵称 / 单号").fill("");
    await full.getByLabel("处理状态").selectOption("AVAILABLE");
    await full.locator(".external-payment-option:not(:disabled)").first().waitFor();
    for (const viewport of [{width:375,height:667},{width:768,height:768},{width:1024,height:768},{width:1440,height:900}]) {
      await page.setViewportSize(viewport);
      await assertSingleScroll(full);
      const body = full.locator(":scope > .modal-shell > .modal-body");
      await body.evaluate(element => { element.scrollTop = 0; });
      assert.ok(await body.evaluate(element => element.scrollHeight > element.clientHeight));
      assert.equal(await page.evaluate(() => getComputedStyle(document.body).overflowY), "hidden");
      assert.equal(await dialog.locator(":scope > .modal-shell > .modal-body").evaluate(element => getComputedStyle(element).overflowY), "hidden");
      const pageScroll = await page.evaluate(() => window.scrollY);
      await body.hover();
      await page.mouse.wheel(0, 450);
      await page.waitForFunction(() => document.querySelector(".external-payment-modal > .modal-shell > .modal-body")!.scrollTop > 0);
      assert.equal(await page.evaluate(() => window.scrollY), pageScroll);
      await full.locator(".external-payment-option").last().scrollIntoViewIfNeeded();
      const last = await full.locator(".external-payment-option").last().boundingBox();
      const bounds = await body.boundingBox();
      assert.ok(last && bounds && last.y + last.height <= bounds.y + bounds.height + 1, "last row stays reachable");
      await full.getByRole("button",{name:"关闭",exact:true}).isVisible().then(visible => assert.ok(visible));
      await body.evaluate(element => { element.scrollTop = 0; });
      await page.screenshot({path:resolve(evidence,`full-single-scroll-${viewport.width}.png`)});
    }
    await page.screenshot({path:resolve(evidence,"desktop-full-list.png")});
    await full.getByRole("button",{name:"关闭",exact:true}).click();
    assert.equal(await dialog.locator(":scope > .modal-shell > .modal-body").evaluate(element => getComputedStyle(element).overflowY), "auto");
    await dialog.getByRole("button",{name:"选择企业微信收款",exact:true}).click();
    await assertSingleScroll(dialog);
    await dialog.getByRole("button",{name:"查找完整清单",exact:true}).click();
    await full.locator(".external-payment-option:not(:disabled)").last().click();
    await full.waitFor({state:"hidden"});
    assert.equal(await dialog.getByTestId("fact-amount-yuan").inputValue(), "120");
    await dialog.getByRole("button",{name:"取消",exact:true}).click();
    await page.setViewportSize({width:390,height:844});
    await page.goto(`${base}/orders/${refundOrder}`);
    await page.getByRole("button",{name:"退款",exact:true}).first().click();
    const refund=page.getByRole("dialog",{name:"登记退款",exact:true});
    await Promise.all([
      page.waitForResponse(response => response.url().includes("external-payments?") && response.url().includes("amountMinor=3000") && response.status() === 200),
      refund.getByTestId("fact-amount-yuan").fill("30")
    ]);
    await refund.getByRole("button",{name:"选择企业微信退款",exact:true}).click();
    await refund.locator(".external-payment-option").first().waitFor();
    await page.screenshot({path:resolve(evidence,"mobile-refund.png")});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    let refundCheck: string;
    if (await refund.locator(".external-payment-option").count()) {
      await refund.locator(".external-payment-option").first().click();
      assert.equal(await refund.getByTestId("fact-amount-yuan").inputValue(),"30");
      await refund.getByTestId("refund-reason").fill("合成退款验收");
      await refund.getByRole("button",{name:"下一步",exact:true}).click();
      await page.getByTestId("command-effect").waitFor();
      assert.match(await page.getByTestId("command-effect").innerText(),/SYNTHETIC-REFUND-1/);
      refundCheck = "mobile refund and independent ID preview";
    } else {
      // Preserve any matching the user already performed in this shared demo.
      await refund.getByRole("button",{name:"查找完整清单",exact:true}).click();
      const refundList = page.getByRole("dialog",{name:"选择企业微信退款 · 完整清单",exact:true});
      await refundList.getByLabel("处理状态").selectOption("ALL");
      const matchedRefund = refundList.locator(".external-payment-option").filter({hasText:"SYNTHETIC-REFUND-1"});
      await matchedRefund.waitFor();
      assert.ok(await matchedRefund.isDisabled());
      assert.match(await matchedRefund.innerText(), /已匹配/);
      await assertSingleScroll(refundList);
      await page.screenshot({path:resolve(evidence,"mobile-refund-matched.png"),fullPage:true});
      refundCheck = "previously matched refund remains visible and disabled";
    }
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({result:"passed",localReads,evidence,checks:["five recommendations","amount autofill","automatic local refresh preserves choice","cancel does not reserve","matched and historical disabled","one scroll area at 375/768/1024/1440px","wheel scroll and last row reachable","background locked and restored","full list selection",refundCheck]}));
  }finally{await browser.close()}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
