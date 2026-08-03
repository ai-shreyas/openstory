/**
 * Super-simple feedback dialog — one message field, send email + product event.
 */

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { submitFeedbackFn } from '@/functions/feedback';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

type FeedbackDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function FeedbackDialog({ open, onOpenChange }: FeedbackDialogProps) {
  const [message, setMessage] = useState('');

  const mutation = useMutation({
    mutationFn: (text: string) => submitFeedbackFn({ data: { message: text } }),
    onSuccess: () => {
      setMessage('');
    },
  });

  const handleOpenChange = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setMessage('');
      mutation.reset();
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = message.trim();
    if (!trimmed || mutation.isPending) return;
    mutation.mutate(trimmed);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        {mutation.isSuccess ? (
          <>
            <DialogHeader>
              <DialogTitle>Thanks</DialogTitle>
              <DialogDescription>
                We got your message and will read it soon.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={() => handleOpenChange(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Feedback</DialogTitle>
              <DialogDescription>
                Bugs, ideas, or anything else — send a short note.
              </DialogDescription>
            </DialogHeader>

            <Textarea
              name="message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="What's on your mind?"
              rows={5}
              required
              maxLength={2000}
              className="min-h-28 resize-y"
            />

            {mutation.isError && (
              <p role="alert" className="text-sm text-destructive">
                {mutation.error instanceof Error
                  ? mutation.error.message
                  : 'Failed to send'}
              </p>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => handleOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={mutation.isPending || !message.trim()}
              >
                {mutation.isPending ? 'Sending…' : 'Send'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
