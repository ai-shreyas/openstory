/**
 * Sequences E2E Tests
 * Tests sequence creation and viewing flows.
 *
 * Runs under the chromium project with storageState (signed-in). Anonymous
 * routing for `/` and `/sequences/new` is covered in auth.spec.ts.
 */

import { test, expect } from 'playwright/test';

test.describe('Sequences', () => {
  test('can access sequences list page', async ({ page }) => {
    await page.goto('/sequences');

    await expect(page).toHaveURL(/\/sequences/);
  });

  test('home page has script input', async ({ page }) => {
    await page.goto('/');

    await expect(page).toHaveURL('/');
    // The script field is a TipTap-backed contenteditable wrapped in the
    // MarkdownEditor component. Target it by data-slot so the assertion is
    // resilient to internal ProseMirror DOM shape.
    const editor = page.locator('[data-slot="markdown-editor"]');
    await expect(editor).toBeVisible();
  });

  test('composer style row defaults to cinematic and can switch family', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(
      page.getByRole('button', { name: 'Style category: Film & Cinematic' })
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole('button', { name: 'Select Action style' })
    ).toBeVisible();

    await page.getByRole('button', { name: /^Style category:/ }).click();
    await page.getByRole('menuitemradio', { name: 'E-commerce' }).click();
    await expect(
      page.getByRole('button', { name: 'Select Product Ad style' })
    ).toBeVisible();
  });

  test('signed-in user can access /sequences/new', async ({ page }) => {
    // chromium project loads e2e/.auth/user.json — this is the logged-in alias
    // of the home composer (#1104). Anonymous redirect is in auth.spec.ts.
    await page.goto('/sequences/new');

    await expect(page).toHaveURL('/sequences/new');
    const editor = page.locator('[data-slot="markdown-editor"]');
    await expect(editor).toBeVisible();
  });
});
