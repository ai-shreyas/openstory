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
            Drop a character sheet or reference photos. Confirm likeness
            authorization before the files upload.
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
          onFilesChange={setFiles}
          talentId={talentId}
          portraitAttestation={
            canUpload
              ? {
                  statementVersion: PORTRAIT_RIGHTS_V1.version,
                  authorizationBasis: authorizationBasis.trim(),
                }
              : undefined
          }
          onComplete={() => setUploadCount((c) => c + 1)}
        />

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button
            onClick={handleClose}
            disabled={isUploading || (files.length > 0 && !canUpload)}
          >
            {isUploading
              ? 'Uploading…'
              : files.length > 0 && !canUpload
                ? 'Confirm authorization to upload'
                : 'Done'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
