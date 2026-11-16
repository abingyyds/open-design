import { mountHostedPreviewFixture, PREVIEW_READ_BUDGET } from '@/playwright/hosted-preview';
import { expect, test as toolsDevTest } from '@/playwright/suite';

const test = toolsDevTest.extend<{ preview: Awaited<ReturnType<typeof mountHostedPreviewFixture>> }>({
  preview: async ({ toolsDev }, use) => {
    const preview = await mountHostedPreviewFixture(toolsDev.url.web(), toolsDev.dataDir);
    try {
      await use(preview);
    } finally {
      await preview.close();
    }
  },
  baseURL: async ({ preview }, use) => {
    await use(preview.origin);
  },
});

test.afterEach(async ({ preview }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  // Snapshot before browser teardown can interrupt pending requests.
  const snapshot = JSON.stringify(preview.requests.slice(-64), null, 2);
  await testInfo.attach('hosted-preview-requests', {
    body: snapshot,
    contentType: 'application/json',
  });
});

test('Chromium retries a real daemon 429 with the original exhausted preview scope', async ({ page, preview }) => {
  await page.context().addCookies([preview.session]);
  const query = new URLSearchParams({ project: preview.project, file: preview.file });
  await page.goto(`/preview-presentation?${query}`);
  const frame = page.locator('iframe[title="Presentation"]');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(frame.contentFrame().getByText('Recovered preview')).toBeVisible();
  expect(preview.requests.filter(({ route }) => route !== 'asset').map(({ route, status }) => ({ route, status }))).toEqual([
    { route: 'entry', status: 302 },
    { route: 'document', status: 429 },
    { route: 'verify', status: 200 },
    { route: 'scoped-redirect', status: 302 },
    { route: 'document', status: 200 },
  ]);
  expect(preview.requests.find(({ route }) => route === 'entry')?.boundNavigation).toBe(true);
  expect(preview.requests.find(({ route }) => route === 'verify')?.sameOrigin).toBe(true);
  expect((await preview.readRange(PREVIEW_READ_BUDGET, PREVIEW_READ_BUDGET)).status).toBe(413);
  const assets = preview.requests.filter(({ route }) => route === 'asset');
  expect(assets.map(({ status }) => status)).toEqual([...Array.from({ length: 10 }, () => 206), 413]);
  expect(preview.requests.filter(({ sameScope }) => sameScope !== undefined).every(({ sameScope }) => sameScope)).toBe(true);
});
