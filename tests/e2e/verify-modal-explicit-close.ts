import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Locator } from "playwright-core";

async function main() {
  const base = process.env.WECOM_ACCEPTANCE_URL ?? "http://127.0.0.1:4219";
  const order = process.env.WECOM_COLLECTION_ORDER_ID;
  if (new URL(base).hostname !== "127.0.0.1" || !order) throw Error("Local acceptance URL and synthetic order required");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const evidence = resolve("docs/implementation/evidence/wecom-selector");
  await mkdir(evidence, { recursive: true });
  try {
    await page.goto(base);
    await page.getByLabel("账号", { exact: true }).fill("operator");
    await page.getByLabel("密码", { exact: true }).fill("demo-pass-2026");
    await page.getByTestId("login-submit").click();
    await page.getByLabel("账号", { exact: true }).waitFor({ state: "hidden" });
    for (const viewport of [{ width: 1280, height: 900 }, { width: 375, height: 667 }]) {
      await page.setViewportSize(viewport);
      await page.goto(`${base}/orders/${order}`);
      await page.getByRole("button", { name: "收款", exact: true }).click();
      const form = page.getByRole("dialog", { name: "登记收款", exact: true });
      const amount = form.getByTestId("fact-amount-yuan");
      const note = form.getByTestId("collection-note");
      await amount.fill("120");
      await note.fill("误点外部不应丢失的收款备注");
      const assertDraft = async () => {
        assert.ok(await form.isVisible());
        assert.equal(await amount.inputValue(), "120");
        assert.equal(await note.inputValue(), "误点外部不应丢失的收款备注");
      };
      async function accidentalDismiss(dialog: Locator) {
        await page.mouse.click(2, 2);
        assert.ok(await dialog.isVisible(), "outside click must not dismiss");
        await dialog.locator(":scope > .modal-shell > .modal-body").focus();
        await page.keyboard.press("Escape");
        assert.ok(await dialog.isVisible(), "Escape must not discard the form");
        // Also cover the browser-native cancel event independently of keydown.
        await dialog.evaluate(element => element.dispatchEvent(new Event("cancel", { cancelable: true })));
        assert.ok(await dialog.isVisible(), "native cancel must not dismiss");
      }
      await accidentalDismiss(form);
      await assertDraft();
      await note.scrollIntoViewIfNeeded();
      const bounds = await note.boundingBox();
      assert.ok(bounds);
      await page.mouse.move(bounds.x + 10, bounds.y + 10);
      await page.mouse.down();
      await page.mouse.move(2, 2);
      await page.mouse.up();
      await assertDraft();
      await form.getByRole("button", { name: "选择企业微信收款", exact: true }).click();
      // Escape may collapse the recommendation list without closing its form.
      await form.getByRole("button", { name: "查找完整清单", exact: true }).focus();
      await page.keyboard.press("Escape");
      assert.equal(await form.locator(".external-payment-dropdown").count(), 0);
      await assertDraft();
      await form.getByRole("button", { name: "选择企业微信收款", exact: true }).click();
      await form.getByRole("button", { name: "查找完整清单", exact: true }).click();
      const full = page.getByRole("dialog", { name: "选择企业微信收款 · 完整清单", exact: true });
      await full.getByLabel("付款人昵称 / 单号").fill("SYNTHETIC");
      await full.getByLabel("金额（元）").fill("120");
      await accidentalDismiss(full);
      assert.equal(await full.getByLabel("付款人昵称 / 单号").inputValue(), "SYNTHETIC");
      assert.equal(await full.getByLabel("金额（元）").inputValue(), "120");
      await full.getByRole("button", { name: "关闭", exact: true }).click();
      await full.waitFor({ state: "hidden" });
      await assertDraft();
      await page.screenshot({ path: resolve(evidence, `explicit-close-${viewport.width}.png`) });
      await form.getByRole("button", { name: "关闭", exact: true }).click();
      await form.waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "收款", exact: true }).click();
      await form.getByRole("button", { name: "取消", exact: true }).click();
      await form.waitFor({ state: "hidden" });
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: "passed", checks: ["desktop and mobile outside click", "Escape and native cancel preserve input", "drag ending outside preserves input", "nested list preserves filters and parent draft", "recommendation Escape only collapses list", "explicit close and cancel work"], evidence }));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
