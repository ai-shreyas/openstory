import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { PORTRAIT_RIGHTS_V1 } from '@/lib/compliance/attestations';
import { toast } from 'sonner';
import { PortraitAttestationFields } from './portrait-attestation-fields';
import { TalentMediaUpload } from './talent-media-upload';

type AddTalentMediaDialogProps = {
  talentId: string;
  trigger?: React.ReactNode;
};

export const AddTalentMediaDialog: React.FC<AddTalentMediaDialogProps> = ({
  talentId,
  trigger,
}) => {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [uploadCount, setUploadCount] = useState(0);
  const [attested, setAttested] = useState(false);
  const [authorizationBasis, setAuthorizationBasis] = useState('');

  const handleClose = () => {
    setFiles([]);
    setUploadCount(0);
    setAttested(false);
    setAuthorizationBasis('');
    setOpen(false);
  };

  const canUpload = attested && authorizationBasis.trim().length > 0;

  const isUploading = files.length > uploadCount;

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => (isOpen ? setOpen(true) : handleClose())}
    >
      <DialogTrigger asChild>
        {trigger ?? <Button variant="outline">Add Media</Button>}
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add Reference Media</DialogTitle>
          <DialogDescription>
            Upload images or videos to use as reference for this talent.
          </DialogDescription>
        </DialogHeader>

        <PortraitAttestationFields
          attested={attested}
          onAttestedChange={setAttested}
          authorizationBasis={authorizationBasis}
          onAuthorizationBasisChange={setAuthorizationBasis}
        />

        <TalentMediaUpload
          files={files}
          onFilesChange={(next) => {
            if (!canUpload) {
              toast.error(
                'Confirm you have authorization for this person’s likeness'
              );
              return;
            }
            setFiles(next);
          }}
          talentId={talentId}
          portraitAttestation={
            canUpload
              ? {
                  statementVersion: PORTRAIT_RIGHTS_V1.version,
                  authorizationBasis: authorizationBasis.trim(),
                }
              : undefined
          }
          disabled={!canUpload}
          onComplete={() => setUploadCount((c) => c + 1)}
        />

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button onClick={handleClose} disabled={isUploading}>
            {isUploading ? 'Uploading…' : 'Done'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
