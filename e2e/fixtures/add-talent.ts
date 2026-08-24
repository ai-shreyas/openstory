/**
 * Shared Add Talent dialog helpers for talent-page and sequence-page e2e.
 */

import { expect, type Locator, type Page } from 'playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { waitForLibraryPageLoad, waitForUploadComplete } from './test-utils';

export const TEST_IMAGE_JPEG = readFileSync(
  path.join(import.meta.dirname, 'test-image.jpg')
);

export function uniqueTalentName(label: string): string {
  return `E2E ${label} ${crypto.randomUUID().slice(0, 8)}`;
}

export function addTalentDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Add Talent' });
}

export async function openAddTalentFromLibrary(page: Page): Promise<Locator> {
  await page.goto('/talent');
  await waitForLibraryPageLoad(page, 'Add Talent');
  await page.getByRole('button', { name: 'Add Talent' }).first().click();
  const dialog = addTalentDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function openAddTalentFromSequence(page: Page): Promise<{
  picker: Locator;
  dialog: Locator;
}> {
  await page.goto('/sequences/new');
  // Style grid can SSR before React hydrates. Generate-enabled is the same
  // gate sequence-flow.spec uses: handlers are attached and composer state
  // is live. Clicking Talent before that is a no-op.
  await expect(page.getByRole('grid', { name: 'Style selection' })).toBeVisible(
    {
      timeout: 15_000,
    }
  );
  await expect(page.getByRole('button', { name: /Generate/i })).toBeEnabled({
    timeout: 15_000,
  });
  await page.locator('main').getByRole('button', { name: 'Talent' }).click();
  // DialogTitle is not always the accessible name; match on the heading copy.
  const picker = page
    .getByRole('dialog')
    .filter({ hasText: 'Select Talent for Casting' });
  await expect(picker).toBeVisible({ timeout: 10_000 });
  await picker.getByRole('button', { name: 'Add Talent' }).last().click();
  const dialog = addTalentDialog(page);
  await expect(dialog).toBeVisible();
  return { picker, dialog };
}

export async function uploadNamedTalentImage(
  page: Page,
  filename: string
): Promise<void> {
  const dialog = addTalentDialog(page);
  const fileChooserPromise = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Browse files' }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    name: filename,
    mimeType: 'image/jpeg',
    buffer: TEST_IMAGE_JPEG,
  });
  await waitForUploadComplete(page);
}

export async function waitForSubjectKind(
  page: Page,
  kind: 'Human' | 'Animated' | 'Other'
): Promise<Locator> {
  const radio = addTalentDialog(page).getByRole('radio', { name: kind });
  await expect(radio).toBeVisible({ timeout: 15_000 });
  await expect(radio).toBeChecked();
  return radio;
}

export async function attestPortraitRights(page: Page): Promise<void> {
  const dialog = addTalentDialog(page);
  await dialog
    .getByRole('checkbox', { name: /authorization to use this person/i })
    .check();
  await dialog
    .getByLabel('Basis for authorization')
    .fill('E2E fixture image — synthetic, depicts no real person');
}

export async function attestAssetRights(page: Page): Promise<void> {
  await addTalentDialog(page)
    .getByRole('checkbox', { name: /hold the rights to this asset/i })
    .check();
}

export async function submitAddTalent(page: Page): Promise<void> {
  const dialog = addTalentDialog(page);
  await dialog.getByRole('button', { name: 'Add Talent' }).click();
  await expect(dialog).not.toBeVisible({ timeout: 15_000 });
}
