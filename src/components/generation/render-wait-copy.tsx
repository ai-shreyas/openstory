import { Link } from '@tanstack/react-router';

type RenderWaitCopyProps = {
  /** Whole minutes remaining, at least 1. */
  etaMinutes: number;
  /** False after the ready email has already been sent for this sequence. */
  willEmail: boolean;
};

/**
 * Copy shown while a first-run storyboard is generating (#1276): people
 * leave the countdown unless we say they can go.
 */
export const RenderWaitCopy: React.FC<RenderWaitCopyProps> = ({
  etaMinutes,
  willEmail,
}) => (
  <span>
    {willEmail ? (
      <span>
        Rendering, about {etaMinutes} min. We&rsquo;ll email you when it&rsquo;s
        ready. Meanwhile:{' '}
        <Link to="/gallery" className="underline underline-offset-2">
          watch a sample in this style
        </Link>
      </span>
    ) : (
      <span>
        Rendering, about {etaMinutes} min. Meanwhile:{' '}
        <Link to="/gallery" className="underline underline-offset-2">
          watch a sample in this style
        </Link>
      </span>
    )}
  </span>
);
