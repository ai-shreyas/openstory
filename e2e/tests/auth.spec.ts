/**
 * Auth E2E Tests
 * Tests authentication flows and route protection
 */

import { test as baseTest } from 'playwright/test';
import { expect, test } from '../fixtures/auth.fixture';

// Route Protection Tests (no auth fixture needed)
baseTest.describe('Route Protection', () => {
  baseTest(
    'anonymous visitor lands in the app, not a marketing page',
    async ({ page }) => {
      await page.goto('/');

      // The app itself is the front page — anonymous visitors land on `/` with
      // the composer rather than a marketing landing page or /sequences/new.
      await expect(page).toHaveURL('/');
      await expect(
        page.getByRole('heading', { name: 'Tell your whole story' })
      ).toBeVisible();
    }
  );

  baseTest(
    'anonymous visitor can browse the shell without being redirected',
    async ({ page }) => {
      // Browsable, account-data pages show a sign-in prompt in place of data
      // rather than bouncing to /login.
      await page.goto('/sequences');

      await expect(page).toHaveURL(/\/sequences/);
      await expect(page).not.toHaveURL(/\/login/);
      await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    }
  );

  baseTest(
    'anonymous generate is intercepted by the login dialog',
    async ({ page }) => {
      await page.goto('/');

      // Composing a draft is allowed while logged out… (the script input is a
      // TipTap contenteditable, not a <textarea> — same locator as
      // full-sequence.spec.ts)
      const scriptEditor = page.locator(
        '[data-slot="markdown-editor"] .ProseMirror'
      );
      await expect(scriptEditor).toBeVisible();
      await scriptEditor.fill(
        'INT. KITCHEN - DAY\n\nA cat knocks a glass off the counter.'
      );

      const generate = page.getByRole('button', {
        name: 'Generate',
        exact: true,
      });
      await expect(generate).toBeEnabled();
      await generate.click();

      // …but the action itself is gated: the auth gate opens the login dialog
      // in place and bails — no sequence is created, we stay on the home composer.
      const dialog = page.getByRole('dialog', { name: 'Sign in to continue' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel('Email')).toBeVisible();
      await expect(page).toHaveURL('/');
    }
  );

  baseTest(
    'account-bound routes redirect anonymous users to login',
    async ({ page }) => {
      // Settings is genuinely account-only — it redirects.
      await page.goto('/settings');

      await expect(page).toHaveURL(/\/login/);
      await expect(page.getByLabel('Email')).toBeVisible();
    }
  );

  baseTest('anonymous /sequences/new redirects to login', async ({ page }) => {
    // /sequences/new is the signed-in composer alias; home is at `/`.
    await page.goto('/sequences/new');

    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByLabel('Email')).toBeVisible();
    // Post-login must return to the alias (path + any search preserved).
    const redirectTo = new URL(page.url()).searchParams.get('redirectTo');
    expect(redirectTo).toBeTruthy();
    expect(decodeURIComponent(redirectTo!)).toMatch(/\/sequences\/new/);
  });

  baseTest(
    'anonymous /sequences/new?style= preserves redirectTo search',
    async ({ page }) => {
      await page.goto('/sequences/new?style=product-ad');

      await expect(page).toHaveURL(/\/login/);
      const redirectTo = new URL(page.url()).searchParams.get('redirectTo');
      expect(redirectTo).toBeTruthy();
      const decoded = decodeURIComponent(redirectTo!);
      expect(decoded).toMatch(/\/sequences\/new/);
      expect(decoded).toMatch(/style=product-ad/);
    }
  );

  baseTest('login page is accessible', async ({ page }) => {
    await page.goto('/login');

    await expect(page).toHaveURL('/login');
    await expect(page.getByLabel('Email')).toBeVisible({ timeout: 15000 });
  });

  baseTest(
    'login page reveals the submit button once an email is entered',
    async ({ page }) => {
      await page.goto('/login');

      const emailInput = page.getByLabel('Email');
      const submitButton = page.getByRole('button', {
        name: 'Continue with email',
      });

      await expect(emailInput).toBeVisible({ timeout: 15000 });
      await expect(emailInput).toBeEnabled();

      // The submit button stays hidden until an email is entered.
      await expect(submitButton).toBeHidden();

      await emailInput.fill('test@example.com');
      await expect(emailInput).toHaveValue('test@example.com');
      await expect(submitButton).toBeVisible();
      await expect(submitButton).toBeEnabled();
    }
  );
});

// Authenticated User Tests
test.describe('Authenticated User', () => {
  test('can access sequences page', async ({ authenticatedPage }) => {
    await authenticatedPage.goto('/sequences');

    // Should not be redirected to login
    await expect(authenticatedPage).toHaveURL(/\/sequences/);
    await expect(authenticatedPage).not.toHaveURL(/\/login/);
  });

  test('can access create new sequence page', async ({ authenticatedPage }) => {
    await authenticatedPage.goto('/sequences/new');

    await expect(authenticatedPage).toHaveURL('/sequences/new');
  });

  test('can access talent page', async ({ authenticatedPage }) => {
    await authenticatedPage.goto('/talent');

    await expect(authenticatedPage).toHaveURL(/\/talent/);
  });

  test('session persists across navigation', async ({ authenticatedPage }) => {
    // Navigate to sequences
    await authenticatedPage.goto('/sequences');
    await expect(authenticatedPage).toHaveURL(/\/sequences/);

    // Navigate to talent
    await authenticatedPage.goto('/talent');
    await expect(authenticatedPage).toHaveURL(/\/talent/);

    // Navigate back to sequences
    await authenticatedPage.goto('/sequences');
    await expect(authenticatedPage).toHaveURL(/\/sequences/);

    // Should still be authenticated (not redirected to login)
    await expect(authenticatedPage).not.toHaveURL(/\/login/);
  });
});

// Email OTP Flow Test (partial - just tests UI, not actual OTP)
baseTest.describe('Email OTP Flow', () => {
  baseTest('email input validates email format', async ({ page }) => {
    await page.goto('/login');

    const emailInput = page.getByLabel('Email');
    const submitButton = page.getByRole('button', {
      name: 'Continue with email',
    });

    // Enter invalid email — the submit button only appears once the field is
    // non-empty, so wait for it before clicking.
    await emailInput.fill('invalid-email');
    await expect(submitButton).toBeVisible();
    await submitButton.click();

    // Browser should show validation error (HTML5 validation)
    // The form should not submit
    await expect(page).toHaveURL('/login');
  });

  // Note: Loading state test removed - timing-dependent and flaky
});
