import { Link, useMatchRoute, useNavigate } from '@tanstack/react-router';
import { useComposedScript } from '@/hooks/use-scenes';
import { cn } from '@/lib/utils';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FileText, Grid3X3 } from 'lucide-react';

type SequenceTabsProps = {
  sequenceId: string;
};

type TabItem = {
  label: string;
  href: string;
  icon: React.ReactNode;
};

// Landing tab when no sub-path is specified. `useSequenceTabItems` returns
// this as `tabs[0]`; keep them in sync. The Script route redirects an analysed
// sequence into the Scenes script view (#1037), so this stays correct for both.
export function getDefaultSequenceTabPath(sequenceId: string): string {
  return `/sequences/${sequenceId}/script`;
}

/**
 * Once a sequence is analysed there is only one destination: Scenes. Its script
 * is no longer a separate page but a view of the Scenes canvas (#1037), reached
 * by the Canvas/Script toggle, so a top-level Script tab would just bounce
 * through a redirect into the very view the toggle already offers.
 *
 * Before analysis the Script page IS the composer, and Scenes has nothing to
 * show — so that's when the pair is worth rendering.
 */
function useSequenceTabItems(sequenceId: string): TabItem[] {
  const { data: composed } = useComposedScript(sequenceId);
  const isAnalysed = (composed?.script.trim().length ?? 0) > 0;

  const scenes: TabItem = {
    label: 'Scenes',
    href: `/sequences/${sequenceId}/scenes`,
    icon: <Grid3X3 className="h-4 w-4" />,
  };
  if (isAnalysed) return [scenes];

  return [
    {
      label: 'Script',
      href: getDefaultSequenceTabPath(sequenceId),
      icon: <FileText className="h-4 w-4" />,
    },
    scenes,
  ];
}

export { useSequenceTabItems };

export const SequenceTabs: React.FC<SequenceTabsProps> = ({ sequenceId }) => {
  const matchRoute = useMatchRoute();
  const navigate = useNavigate();
  const tabs = useSequenceTabItems(sequenceId);

  const activeIndex = tabs.findIndex((tab) =>
    matchRoute({ to: tab.href, fuzzy: false })
  );
  const activeTab = activeIndex >= 0 ? tabs[activeIndex] : tabs[0];
  if (!activeTab) return null;
  // A single destination is not a choice — an analysed sequence has only
  // Scenes, so the bar would be a lone always-active chip taking canvas height.
  if (tabs.length < 2) return null;
  const activeHref = activeTab.href;

  return (
    <>
      {/* Desktop tabs */}
      <nav className="hidden md:flex items-center gap-2 py-2">
        {tabs.map((tab) => {
          const isActive = matchRoute({ to: tab.href, fuzzy: false });

          return (
            <Link
              key={tab.href}
              to={tab.href}
              className={cn(
                'flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-transparent text-muted-foreground hover:border-muted hover:text-foreground'
              )}
            >
              {tab.icon}
              {tab.label}
            </Link>
          );
        })}
      </nav>

      {/* Mobile: Select dropdown */}
      <div className="md:hidden py-2">
        <Select
          value={activeHref}
          onValueChange={(value) => void navigate({ to: value })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {tabs.map((tab) => (
              <SelectItem key={tab.href} value={tab.href}>
                {tab.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </>
  );
};
