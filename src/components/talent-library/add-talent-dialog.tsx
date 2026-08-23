import { useState } from 'react';
import { useAuthGate } from '@/components/auth/auth-gate-provider';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useHydrated } from '@/hooks/use-hydrated';
import { useAnalyzeTalentMedia, useCreateTalent } from '@/hooks/use-talent';
import { getFileKey } from '@/lib/utils/upload';
import { PORTRAIT_RIGHTS_V1 } from '@/lib/compliance/attestations';
import type { Talent } from '@/lib/db/schema';
import { Plus, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { PortraitAttestationFields } from './portrait-attestation-fields';
import { TalentMediaUpload } from './talent-media-upload';

type AddTalentDialogProps = {
  trigger?: React.ReactNode;
  /** Called with the newly created talent so callers can auto-select it. */
  onCreated?: (talent: Talent) => void;
};

export const AddTalentDialog: React.FC<AddTalentDialogProps> = ({
  trigger,
  onCreated,
}) => {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [uploadedUrls, setUploadedUrls] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [sheetUrls, setSheetUrls] = useState<Set<string>>(new Set());
  const [sheetFileKeys, setSheetFileKeys] = useState<Set<string>>(new Set());
  // Portrait-rights attestation (#1180). Required whenever reference media is
  // attached, because that is when a real person's likeness can enter the
  // library — the same condition that sets `isHuman` below.
  const [attested, setAttested] = useState(false);
  const [authorizationBasis, setAuthorizationBasis] = useState('');

  const isHydrated = useHydrated();
  const { requireAuth } = useAuthGate();
  const createTalent = useCreateTalent();
  const analyzeMedia = useAnalyzeTalentMedia();

  const closeAndReset = () => {
    setFiles([]);
    setUploadedUrls([]);
    setName('');
    setDescription('');
    setSheetUrls(new Set());
    setSheetFileKeys(new Set());
    // Cleared with the rest of the form: an attestation must be made afresh for
    // each upload, never inherited from the previous one.
    setAttested(false);
    setAuthorizationBasis('');
    setOpen(false);
  };

  const handleClose = () => {
    if (
      files.length > 0 &&
      !window.confirm(
        'Discard uploaded reference media? Your uploads will be lost.'
      )
    ) {
      return;
    }
    closeAndReset();
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    e.stopPropagation();

    // Anonymous visitors can open the dialog and fill the form; the actual
    // add prompts a login.
    if (!requireAuth()) return;

    if (!name.trim()) return;

    const depictsRealPerson = uploadedUrls.length > 0;

    if (depictsRealPerson && (!attested || !authorizationBasis.trim())) {
      toast.error('Confirm you have authorization for this person’s likeness');
      return;
    }

    createTalent.mutate(
      {
        name: name.trim(),
        description: description.trim() || undefined,
        isHuman: depictsRealPerson,
        referenceImageUrls: uploadedUrls,
        characterSheetImageUrls: uploadedUrls.filter((url) =>
          sheetUrls.has(url)
        ),
        portraitAttestation: depictsRealPerson
          ? {
              statementVersion: PORTRAIT_RIGHTS_V1.version,
              authorizationBasis: authorizationBasis.trim(),
            }
          : undefined,
      },
      {
        onSuccess: (talent) => {
          onCreated?.(talent);
          toast.success(
            sheetUrls.size > 0
              ? 'Talent added. Generating portrait from the uploaded sheet…'
              : 'Talent added. Generating talent sheet…'
          );
          closeAndReset();
        },
      }
    );
  };

  const isPending = createTalent.isPending;
  const isUploading = files.length > uploadedUrls.length;

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => (isOpen ? setOpen(true) : handleClose())}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button disabled={!isHydrated}>
            <Plus className="mr-2 h-4 w-4" />
            Add Talent
          </Button>
        )}
      </DialogTrigger>
      <DialogContent
        className="max-w-2xl max-h-[90vh] overflow-y-auto"
        onPointerDownOutside={(e) => {
          if (files.length > 0) {
            e.preventDefault();
            handleClose();
          }
        }}
        onEscapeKeyDown={(e) => {
          if (files.length > 0) {
            e.preventDefault();
            handleClose();
          }
        }}
      >
        <form
          onSubmit={(e) => void handleSubmit(e)}
          className="flex flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle>Add Talent</DialogTitle>
            <DialogDescription>
              Add a new talent to your library.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                name="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Talent name…"
                autoComplete="off"
                required
              />
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="description">Description</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={uploadedUrls.length === 0 || analyzeMedia.isPending}
                  onClick={() => {
                    analyzeMedia.mutate(uploadedUrls, {
                      onSuccess: (result) => {
                        setDescription(result.description);
                        if (!name.trim() && result.suggestedName.trim()) {
                          setName(result.suggestedName.trim());
                        }
                        toast.success('Description generated from photos');
                      },
                      onError: (error) => {
                        toast.error('Could not generate description', {
                          description:
                            error instanceof Error
                              ? error.message
                              : 'Unknown error',
                        });
                      },
                    });
                  }}
                >
                  <Sparkles className="h-4 w-4" />
                  {analyzeMedia.isPending
                    ? 'Generating…'
                    : 'Generate from photos'}
                </Button>
              </div>
              <Textarea
                id="description"
                name="description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Describe the talent's appearance, style…"
                rows={3}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label>Reference Media</Label>
              <TalentMediaUpload
                files={files}
                onFilesChange={setFiles}
                onUploadedUrlsChange={setUploadedUrls}
                sheetFileKeys={sheetFileKeys}
                onFileUploaded={(file, url) => {
                  if (!file.type.startsWith('image/')) return;
                  analyzeMedia.mutate([url], {
                    onSuccess: (result) => {
                      if (!result.isCharacterSheet) return;
                      setSheetUrls((prev) => new Set(prev).add(url));
                      setSheetFileKeys((prev) =>
                        new Set(prev).add(getFileKey(file))
                      );
                      toast.success('Character sheet detected');
                    },
                  });
                }}
                disabled={isPending}
              />
            </div>

            {uploadedUrls.length > 0 ? (
              <PortraitAttestationFields
                attested={attested}
                onAttestedChange={setAttested}
                authorizationBasis={authorizationBasis}
                onAuthorizationBasisChange={setAuthorizationBasis}
              />
            ) : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isPending || isUploading || analyzeMedia.isPending}
            >
              {isPending
                ? 'Creating…'
                : isUploading
                  ? 'Uploading…'
                  : 'Add Talent'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
