import { buildMentionItems } from '@/components/scenes/prompt-mention/mention-items';
import { useSequenceCharacters } from '@/hooks/use-sequence-characters';
import { useSequenceElements } from '@/hooks/use-sequence-elements';
import { useSequenceLocations } from '@/hooks/use-sequence-locations';
import { useMemo } from 'react';

/**
 * The @-mention autocomplete items for a sequence — the same canonical
 * cast/element/location tags the #683 server-side parser recognises.
 *
 * Shared by every editor that pills them (the inspector's script + prompt
 * fields and the script document's scene blocks) so the three lists are fetched
 * once per sequence and can't drift apart between surfaces.
 */
export function useSequenceMentionItems(sequenceId: string) {
  const { data: elements } = useSequenceElements(sequenceId);
  const { data: characters } = useSequenceCharacters(sequenceId);
  const { data: locations } = useSequenceLocations(sequenceId);

  const items = useMemo(
    () =>
      buildMentionItems({
        characters: characters ?? [],
        elements: elements ?? [],
        locations: locations ?? [],
      }),
    [characters, elements, locations]
  );

  // The raw lists come back too — callers that also build reference images or
  // resolve tags need the underlying rows, not just the pill items, and would
  // otherwise re-subscribe to the same three queries.
  return { items, characters, elements, locations };
}
