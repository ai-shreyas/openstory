import { expect, test } from '../fixtures/auth.fixture';

test.describe('Images and Videos studio', () => {
  test('signed-in user can open the studio from the sidebar', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Images and Videos' }).click();
    await expect(page).toHaveURL(/\/studio/);
    await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Generate image' })
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Images', exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Videos', exact: true })
    ).toBeVisible();
  });

  test('video mode switches the generate label', async ({ page }) => {
    await page.goto('/studio');
    await page.getByRole('radio', { name: 'Video' }).click();
    await expect(
      page.getByRole('button', { name: 'Generate video' })
    ).toBeVisible();
  });
});
