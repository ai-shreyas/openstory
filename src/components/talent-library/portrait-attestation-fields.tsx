import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PORTRAIT_RIGHTS_V1 } from '@/lib/compliance/attestations';

type PortraitAttestationFieldsProps = {
  attested: boolean;
  onAttestedChange: (attested: boolean) => void;
  authorizationBasis: string;
  onAuthorizationBasisChange: (value: string) => void;
};

export function PortraitAttestationFields({
  attested,
  onAttestedChange,
  authorizationBasis,
  onAuthorizationBasisChange,
}: PortraitAttestationFieldsProps) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-destructive/40 p-4">
      <div className="flex items-start gap-3">
        <Checkbox
          id="portrait-attestation"
          checked={attested}
          onCheckedChange={(checked) => onAttestedChange(checked === true)}
          aria-describedby="portrait-attestation-text"
        />
        <div className="flex flex-col gap-2">
          <Label htmlFor="portrait-attestation" className="leading-snug">
            {PORTRAIT_RIGHTS_V1.label}
          </Label>
          <p
            id="portrait-attestation-text"
            className="text-xs leading-relaxed text-muted-foreground"
          >
            {PORTRAIT_RIGHTS_V1.text}
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="authorization-basis">Basis for authorization</Label>
        <Input
          id="authorization-basis"
          value={authorizationBasis}
          onChange={(event) => onAuthorizationBasisChange(event.target.value)}
          placeholder="e.g. signed release on file, this is me, contract #123"
          autoComplete="off"
        />
      </div>
    </div>
  );
}
