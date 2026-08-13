/**
 * Identity verification panel (#1180).
 *
 * Shows the account's real-name verification state and starts a check. Which
 * provider performs the check is a deployment choice, so the panel renders from
 * what the server reports rather than assuming a flow: a hosted provider
 * returns a redirect, manual review returns "submitted".
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  getComplianceStatusFn,
  listMyVerificationsFn,
  startIdentityVerificationFn,
} from '@/functions/compliance';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, ShieldAlert, ShieldQuestion } from 'lucide-react';
import { Suspense } from 'react';
import { toast } from 'sonner';

export const IdentityVerificationSettings: React.FC = () => (
  <Suspense fallback={<Skeleton className="h-64 w-full" />}>
    <IdentityVerificationContent />
  </Suspense>
);

const STATUS_COPY: Record<
  string,
  {
    label: string;
    variant: 'default' | 'secondary' | 'destructive';
    blurb: string;
  }
> = {
  verified: {
    label: 'Verified',
    variant: 'default',
    blurb: 'Your identity is verified. No further action is needed.',
  },
  pending: {
    label: 'In review',
    variant: 'secondary',
    blurb:
      'Your verification is being reviewed. This usually completes within one business day.',
  },
  rejected: {
    label: 'Not verified',
    variant: 'destructive',
    blurb:
      'The last check could not be completed. You can start a new verification below.',
  },
  revoked: {
    label: 'Revoked',
    variant: 'destructive',
    blurb:
      'This account’s verification was revoked. Contact support if you believe this is a mistake.',
  },
  expired: {
    label: 'Expired',
    variant: 'secondary',
    blurb: 'Your verification has lapsed. Verify again to restore access.',
  },
  none: {
    label: 'Not verified',
    variant: 'secondary',
    blurb: 'This account has not completed identity verification.',
  },
};

const IdentityVerificationContent: React.FC = () => {
  const queryClient = useQueryClient();

  const { data: status } = useQuery({
    queryKey: ['compliance-status'],
    queryFn: () => getComplianceStatusFn(),
  });
  const { data: attempts = [] } = useQuery({
    queryKey: ['my-verifications'],
    queryFn: () => listMyVerificationsFn(),
  });

  const startMutation = useMutation({
    mutationFn: () => startIdentityVerificationFn(),
    onSuccess: (result) => {
      if (result.next.kind === 'redirect') {
        // Full navigation, not a router push: the destination is the provider's
        // own hosted flow on another origin.
        window.location.href = result.next.url;
        return;
      }
      void queryClient.invalidateQueries({ queryKey: ['my-verifications'] });
      void queryClient.invalidateQueries({ queryKey: ['compliance-status'] });
      toast.success(
        result.next.kind === 'verified'
          ? 'Identity verified'
          : 'Submitted for review',
        {
          description:
            result.next.kind === 'verified'
              ? undefined
              : 'Check back here — an admin will review the request.',
        }
      );
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : 'Could not start verification'
      );
    },
  });

  const copy =
    STATUS_COPY[status?.verificationStatus ?? 'none'] ?? STATUS_COPY.none;
  const verified = status?.verified ?? false;
  const pending = status?.verificationPending ?? false;

  const Icon = verified ? ShieldCheck : pending ? ShieldQuestion : ShieldAlert;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <Icon className="size-5 text-muted-foreground" aria-hidden />
            <CardTitle>Identity verification</CardTitle>
            {/* Redundant with the icon on purpose — status must not be conveyed
                by colour alone. */}
            <Badge variant={copy?.variant ?? 'secondary'}>{copy?.label}</Badge>
          </div>
          <CardDescription>{copy?.blurb}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm leading-relaxed text-muted-foreground">
            Some models are provided under terms that require the account using
            them to have a verified real-name identity, and uploading a real
            person’s likeness always requires one. We store only the outcome of
            the check — never your identity documents.
          </p>

          {status?.policy === 'disabled' ? (
            <p className="text-sm text-muted-foreground">
              Verification is not required on this deployment.
            </p>
          ) : (
            <div>
              <Button
                onClick={() => startMutation.mutate()}
                disabled={startMutation.isPending || verified || pending}
              >
                {startMutation.isPending
                  ? 'Starting…'
                  : verified
                    ? 'Verified'
                    : pending
                      ? 'In review'
                      : 'Verify my identity'}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {attempts.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>History</CardTitle>
            <CardDescription>
              Every verification attempt on this account.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-4 py-3 text-left">Submitted</th>
                    <th className="px-4 py-3 text-left">Status</th>
                    <th className="px-4 py-3 text-left">Method</th>
                    <th className="px-4 py-3 text-left">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {attempts.map((attempt) => (
                    <tr
                      key={attempt.id}
                      className="border-b last:border-b-0 hover:bg-muted/30"
                    >
                      <td className="px-4 py-3 tabular-nums">
                        {new Date(attempt.createdAt).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3">{attempt.status}</td>
                      <td className="px-4 py-3">
                        {attempt.method?.replace(/_/g, ' ') ?? '—'}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {attempt.rejectionReason ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
};
