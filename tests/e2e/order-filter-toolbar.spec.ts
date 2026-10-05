/** Read-only UI acceptance against an explicitly opted-in local demo server.
 * No fixture reset, payment commands, or modification of manual acceptance orders.
 */
import { expect, test } from '@playwright/test';

test.skip(process.env.ORDER_FILTER_TOOLBAR_E2E !== 'true', 'Explicit local toolbar acceptance opt-in required');

test.beforeEach(async ({page}, info) => {
  const baseURL = info.project.use.baseURL;
  if (!baseURL || !['127.0.0.1', 'localhost'].includes(new URL(baseURL).hostname)) throw new Error('Local demo acceptance only');
  await page.goto('/accounts');
  await page.getByTestId('login-username').fill('admin');
  await page.getByTestId('login-password').fill('demo-pass-2026');
  await page.getByTestId('login-submit').click();
  await expect(page.getByRole('heading', {name: '我的账号'})).toBeVisible();
  await page.goto('/orders');
  await expect(page.getByRole('combobox', {name: '资金视图', exact: true})).toBeVisible();
});

test('one compact desktop row or accessible mobile wrap, with three equal-width dropdowns', async ({page}, info) => {
  const toolbar = page.locator('.orders-filter-toolbar');
  await expect(toolbar.getByRole('combobox')).toHaveCount(3);
  const status = toolbar.getByRole('combobox', {name: '按订单状态筛选', exact: true});
  await expect(status).toHaveValue('ALL');
  await expect(status.locator('option:checked')).toHaveText('预订及入住状态');
  const controls = await toolbar.locator('input, select').evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect();
    return {x:rect.x, y:rect.y, width:rect.width, height:rect.height};
  }));
  expect(controls).toHaveLength(4);
  if (!info.project.use.isMobile) {
    expect(controls[0]!.width).toBeLessThanOrEqual(300);
    expect(controls[0]!.width).toBeGreaterThanOrEqual(240);
    for (const control of controls) {
      expect(Math.abs(control.y - controls[0]!.y)).toBeLessThan(1);
      expect(control.height).toBe(40);
    }
    for (const dropdown of controls.slice(1)) expect(dropdown.width).toBe(148);
    for (const width of [1024, 900]) {
      await page.setViewportSize({width,height:720});
      const boxes = await toolbar.locator('input, select').evaluateAll(elements => elements.map(element => {
        const rect = element.getBoundingClientRect();
        return {y:rect.y,width:rect.width,right:rect.right};
      }));
      for (const box of boxes) {
        expect(Math.abs(box.y - boxes[0]!.y)).toBeLessThan(1);
        expect(box.right).toBeLessThanOrEqual(width);
      }
      for (const dropdown of boxes.slice(1)) expect(dropdown.width).toBe(148);
    }
    await page.setViewportSize({width:1280,height:720});
  } else {
    expect((await toolbar.boundingBox())!.height).toBeLessThan(250);
    for (const control of controls) {
      expect(control.height).toBeGreaterThanOrEqual(44);
      expect(control.x).toBeGreaterThanOrEqual(0);
      expect(control.x + control.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    }
  }
  await page.screenshot({path:info.outputPath('compact-order-toolbar.png'),fullPage:true});
});

test('retained view hides unrelated filters and restores the original order search selections', async ({page}, info) => {
  const status = page.getByRole('combobox', {name:'按订单状态筛选',exact:true});
  const funds = page.getByRole('combobox', {name:'按收退款核对筛选',exact:true});
  await status.selectOption('RESERVED');
  await funds.selectOption('OVERPAID');
  await page.getByRole('searchbox', {name:'搜索订单',exact:true}).fill('合成验收-人工一');
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('合成验收-人工一');
  await page.getByRole('combobox', {name:'资金视图',exact:true}).selectOption('RETAINED');
  await expect(status).toHaveCount(0);
  await expect(funds).toHaveCount(0);
  const toolbar = page.locator('.retained-funds-toolbar');
  await expect(toolbar.getByRole('combobox')).toHaveCount(1);
  const search = toolbar.getByRole('searchbox', {name:'搜索客户 / 联系方式 / 来源订单',exact:true});
  const responsePromise = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/v2/retained-funds' && url.searchParams.get('query') === '留存界面查询检查';
  });
  await search.fill('留存界面查询检查');
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  expect(new URL(response.url()).searchParams.has('funds')).toBe(false);
  expect(new URL(response.url()).searchParams.get('status')).toBe('AVAILABLE');
  expect(new URL(page.url()).searchParams.get('q')).toBe('合成验收-人工一');
  await page.screenshot({path:info.outputPath('compact-retained-toolbar.png'),fullPage:true});
  await page.getByRole('combobox', {name:'资金视图',exact:true}).selectOption('ORDERS');
  await expect(status).toHaveValue('RESERVED');
  await expect(funds).toHaveValue('OVERPAID');
  await expect(page.getByRole('searchbox', {name:'搜索订单',exact:true})).toHaveValue('合成验收-人工一');
});

test('no unnecessary view switch when disabled without retained history', async ({page}) => {
  await page.route('**/api/v2/retained-funds?*', route => route.fulfill({json:{enabled:false,items:[],hasMore:false,nextBeforeId:null}}));
  await page.reload();
  await expect(page.getByRole('heading', {name:'订单',exact:true})).toBeVisible();
  await expect(page.getByRole('combobox', {name:'资金视图',exact:true})).toHaveCount(0);
  await expect(page.locator('.orders-filter-toolbar').getByRole('combobox')).toHaveCount(2);
});
