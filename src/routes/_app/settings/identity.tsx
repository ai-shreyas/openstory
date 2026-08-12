/**
 * Identity Verification Page (#1180)
 * Real-name verification status, history, and the entry point to a new check.
 */

import { IdentityVerificationSettings } from '@/components/settings/identity-verification-settings';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/settings/identity')({
  component: IdentityPage,
  staticData: { breadcrumb: 'Identity' },
});

function IdentityPage() {
  return <IdentityVerificationSettings />;
}
