import { expect, test } from '../fixtures/auth.fixture';

test.describe('Images and Videos studio', () => {
  test('signed-in user can open Images from the sidebar', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Images', exact: true }).click();
    await expect(page).toHaveURL(/\/images/);
    await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Generate image' })
    ).toBeVisible();
  });

  test('signed-in user can open Videos from the sidebar', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Videos', exact: true }).click();
    await expect(page).toHaveURL(/\/videos/);
    await expect(
      page.getByRole('button', { name: 'Generate video' })
    ).toBeVisible();
  });

  test('/studio redirects to /images', async ({ page }) => {
    await page.goto('/studio');
    await expect(page).toHaveURL(/\/images/);
  });
});
