/**
 * "Ask Tom for Credits" request (#1096) — sent to the founder when a user hits
 * the billing gate and asks for credits instead of buying. Server-only —
 * rendered by email-service.tsx.
 */

import { Heading, Section, Text } from '@react-email/components';
import { EmailLayout, headingClass, paragraphClass } from './email-layout';

interface FounderCreditRequestEmailProps {
  appName: string;
  userName: string;
  userEmail: string;
  teamId: string;
  balanceDisplay: string;
}

const detailRowClass = 'm-0 text-sm leading-6 text-gray-700';

export const FounderCreditRequestEmail: React.FC<
  FounderCreditRequestEmailProps
> = ({ appName, userName, userEmail, teamId, balanceDisplay }) => (
  <EmailLayout appName={appName} preview={`${userEmail} is asking for credits`}>
    <Section>
      <Heading as="h2" className={headingClass}>
        Credit request
      </Heading>
      <Text className={paragraphClass}>
        A user tapped &ldquo;Ask Tom for Credits&rdquo; on the billing gate.
        Reply to them directly, or send a gift code.
      </Text>

      <Section className="my-6 rounded-lg bg-gray-100 p-6">
        <Text className={detailRowClass}>
          <strong>Name:</strong> {userName || '—'}
        </Text>
        <Text className={detailRowClass}>
          <strong>Email:</strong> {userEmail}
        </Text>
        <Text className={detailRowClass}>
          <strong>Team:</strong> {teamId}
        </Text>
        <Text className={detailRowClass}>
          <strong>Balance:</strong> {balanceDisplay}
        </Text>
      </Section>
    </Section>
  </EmailLayout>
);
