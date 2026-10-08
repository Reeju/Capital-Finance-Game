import { type Page, expect, test } from '@playwright/test';

async function freshHome(page: Page, query = '?aiDelay=0') {
  await page.goto(`/${query}`);
  await expect(page.getByRole('heading', { name: 'Capital' })).toBeVisible();
}

async function startTutorial(page: Page) {
  await freshHome(page);
  await page.getByRole('button', { name: /^Play/ }).click();
  await page.getByLabel('Your name').fill('Tess');
  await page.getByRole('button', { name: /Start with \$500,000/ }).click();
  await expect(page.getByText('Year 1/12')).toBeVisible();
}

async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

test('a fresh player makes a first informed investment in the guided tutorial', async ({ page }) => {
  const t0 = Date.now();
  await startTutorial(page);
  await expect(page.getByText('Tutorial', { exact: true })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Tutorial' })).toContainText('3 action points');
  await expect(page.getByRole('group', { name: /Your finances/ })).toContainText('$500K');
  await noHorizontalScroll(page);

  await page.getByRole('navigation', { name: 'Districts' }).getByRole('button', { name: /Wall Street/ }).click();
  await page.getByRole('button', { name: 'Move here · 1 AP' }).click();
  await expect(page.getByRole('img', { name: '2 of 3 action points left' })).toBeVisible();
  await page.getByRole('button', { name: /MPWR · MetroPower/ }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toContainText('Why it is priced this way');
  await expect(sheet).toContainText('= equity value');
  await sheet.getByLabel(/Shares to buy/).fill('500');
  await expect(sheet).toContainText('You pay');
  await sheet.getByRole('button', { name: /Review buy order/ }).click();
  await expect(sheet.getByRole('status')).toContainText(/Buy 500 MPWR for exactly \$[\d,]+\.\d\d/);
  await sheet.getByRole('button', { name: 'Confirm order' }).click();
  await sheet.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('tab', { name: 'Portfolio' }).click();
  await expect(page.getByRole('button', { name: /500 MPWR/ })).toBeVisible();
  expect(Date.now() - t0).toBeLessThan(120_000);
  await noHorizontalScroll(page);
});

test('a full Quick solo game against the AI reaches a ranked result and survives reloads', async ({ page }) => {
  await startTutorial(page);
  let reloaded = false;
  for (let guard = 0; guard < 400; guard++) {
    if (await page.getByRole('heading', { name: /wins|share the win/ }).isVisible().catch(() => false)) break;
    const tap = async (name: string | RegExp, exact = false) => {
      const b = page.getByRole('button', { name, exact });
      if (!(await b.isVisible().catch(() => false))) return false;
      return b.click({ timeout: 1500 }).then(() => true).catch(() => false); // the board may have moved on; just look again
    };
    if (await tap(/^Start year/)) {
      if (!reloaded && (await page.getByText('Year 4/12').isVisible().catch(() => false))) {
        // save/resume: reload mid-match and continue at the same year
        reloaded = true;
        await page.reload();
        await page.getByRole('button', { name: /^Continue/ }).click();
        await expect(page.getByText('Year 4/12')).toBeVisible();
      }
      continue;
    }
    if (!((await tap('Pass', true)) || (await tap('Reject', true)) || (await tap('Keep my shares')) || (await tap(/^End turn/)))) await page.waitForTimeout(30);
  }
  expect(reloaded).toBe(true);
  await expect(page.getByRole('heading', { name: /wins|share the win/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Final standings' })).toBeVisible();
  await expect(page.getByRole('table').first()).toContainText('Tess');
  await expect(page.getByText('Net worth by year')).toBeVisible();
  await noHorizontalScroll(page);
  await page.getByRole('button', { name: 'Back to the menu' }).click();
  await expect(page.getByText('Finished')).toBeVisible();
});

test('pass-and-play hides each seat behind a privacy curtain', async ({ page }) => {
  await freshHome(page);
  await page.getByRole('button', { name: /Pass and play/ }).click();
  await page.getByLabel('Seat 1 name').fill('Ann');
  await page.getByLabel('Seat 2 name').fill('Bob');
  await page.getByRole('button', { name: /Start with/ }).click();
  const curtain = page.getByRole('dialog', { name: 'Pass the device' });
  await expect(curtain).toContainText('Ann');
  await expect(page.getByRole('group', { name: /Your finances/ })).toHaveCount(0);
  await curtain.getByRole('button', { name: /I am Ann/ }).click();
  await page.getByRole('button', { name: /^End turn/ }).click();
  await expect(curtain).toContainText('Bob');
  await curtain.getByRole('button', { name: /I am Bob/ }).click();
  await expect(page.getByText('Year 1/12')).toBeVisible();
  await page.getByRole('button', { name: /^End turn/ }).click();
  // deals window: the auction prompts a seat, again behind the curtain
  await expect(curtain).toBeVisible();
});

test('layouts work in portrait and landscape phone sizes with large text', async ({ page }) => {
  await startTutorial(page);
  for (const size of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(size);
    await noHorizontalScroll(page);
    await expect(page.getByRole('group', { name: /Your finances/ })).toBeVisible();
    const small = await page.evaluate(() => [...document.querySelectorAll('button')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && (r.height < 43.5 || r.width < 43.5) && !b.classList.contains('link') && !b.classList.contains('chip'); }).map((b) => b.textContent));
    expect(small).toEqual([]);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => document.documentElement.style.setProperty('--scale', '2'));
  await noHorizontalScroll(page);
  expect(await page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize))).toBeGreaterThanOrEqual(16);
});

test('the installed shell and a saved match work offline after the first load', async ({ page, context }) => {
  await startTutorial(page);
  await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration())?.active, null, { timeout: 30_000 });
  await page.waitForTimeout(1500); // let precaching finish
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Capital' })).toBeVisible();
  await page.getByRole('button', { name: /^Continue/ }).click();
  await expect(page.getByText('Year 1/12')).toBeVisible();
  await page.getByRole('navigation', { name: 'Districts' }).getByRole('button', { name: /Wall Street/ }).click();
  await page.getByRole('button', { name: 'Move here · 1 AP' }).click();
  await expect(page.getByRole('img', { name: '2 of 3 action points left' })).toBeVisible();
  await page.getByRole('button', { name: 'Leave to the main menu' }).click();
  await page.getByRole('button', { name: /Online room/ }).click();
  await expect(page.getByText('Online play is unavailable on this build.')).toBeVisible();
  await context.setOffline(false);
});

test('two separate browser sessions create, join and play an online room', async ({ browser }) => {
  const hostCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const guestCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();
  await host.goto('/');
  await host.getByRole('button', { name: /Online room/ }).click();
  await host.getByLabel('Your name').fill('Hana');
  await host.getByRole('button', { name: 'Create room' }).click();
  const heading = host.getByRole('heading', { name: /^Room [A-Z0-9]{8}$/ });
  await expect(heading).toBeVisible();
  const code = ((await heading.textContent()) ?? '').replace('Room ', '');

  await guest.goto(`/#/room/${code}`);
  await guest.getByLabel('Your name').fill('Gus');
  await expect(guest.getByLabel(/Invite code/)).toHaveValue(code);
  await guest.getByRole('button', { name: 'Join', exact: true }).click();
  await guest.getByRole('button', { name: 'I am ready' }).click();
  await host.getByRole('button', { name: 'Start the match' }).click();

  await expect(host.getByText('Year 1/12')).toBeVisible();
  await expect(guest.getByText('Year 1/12')).toBeVisible();
  await expect(host.getByRole('timer')).toBeVisible();
  // the host moves; the guest sees it and cannot act out of turn
  await host.getByRole('navigation', { name: 'Districts' }).getByRole('button', { name: /Wall Street/ }).click();
  await host.getByRole('button', { name: 'Move here · 1 AP' }).click();
  await expect(guest.getByRole('navigation', { name: 'Districts' }).getByRole('button', { name: /Wall Street/ })).toContainText('Hana');
  await expect(guest.getByRole('button', { name: /^End turn/ })).toHaveCount(0);
  // reconnect mid-turn: the host reloads and comes back to the same seat and AP without re-joining
  await host.reload();
  await expect(host.getByText('Year 1/12')).toBeVisible();
  await expect(host.getByRole('img', { name: '2 of 3 action points left' })).toBeVisible();
  await host.getByRole('button', { name: /^End turn/ }).click();
  await expect(guest.getByRole('button', { name: /^End turn/ })).toBeVisible();
  await hostCtx.close();
  await guestCtx.close();
});

test('exports a match, rejects a corrupted file and re-imports the good one by replaying it', async ({ page }) => {
  await startTutorial(page);
  await page.getByRole('navigation', { name: 'Districts' }).getByRole('button', { name: /Wall Street/ }).click();
  await page.getByRole('button', { name: 'Move here · 1 AP' }).click();
  await page.getByRole('button', { name: 'Leave to the main menu' }).click();
  await page.getByRole('button', { name: /^Settings/ }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export', exact: true }).click()]);
  const path = await download.path();
  const good = (await import('node:fs')).readFileSync(path, 'utf8');
  expect(JSON.parse(good).format).toBe('capital-save');
  expect(good).not.toContain('"rng":{}'); // a full local save, unlike an online projection

  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Delete all local data' }).click();
  await expect(page.getByRole('status')).toContainText('All local data deleted');

  const input = page.getByLabel('Import a saved match file');
  const tampered = JSON.parse(good);
  tampered.initial.players.s1.cash = 99_999_999_00; // hand-edited riches
  await input.setInputFiles({ name: 'tampered.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(tampered)) });
  await expect(page.getByRole('status')).toContainText(/corrupted|integrity/);
  await input.setInputFiles({ name: 'junk.json', mimeType: 'application/json', buffer: Buffer.from('{"format":"capital-save","script":"<img onerror=alert(1)>"}') });
  await expect(page.getByRole('status')).toContainText('not a valid Capital save');
  await input.setInputFiles({ name: 'good.json', mimeType: 'application/json', buffer: Buffer.from(good) });
  await expect(page.getByRole('status')).toContainText('Imported');
  await page.getByRole('button', { name: '‹ Back' }).click();
  await page.getByRole('button', { name: /^Continue/ }).click();
  await expect(page.getByRole('img', { name: '2 of 3 action points left' })).toBeVisible();
});

test('a second tab opens the same match read-only instead of forking the save', async ({ page, context }) => {
  await startTutorial(page);
  const other = await context.newPage();
  await other.goto('/?aiDelay=0');
  await other.getByRole('button', { name: /^Continue/ }).click();
  await expect(other.getByRole('status').filter({ hasText: 'open in another tab' })).toBeVisible();
  await expect(other.getByRole('button', { name: /^End turn/ })).toHaveCount(0);
  await other.close();
  await page.getByRole('button', { name: /^End turn/ }).click();
  await expect(page.getByRole('button', { name: /^End turn/ })).toHaveCount(0);
});
