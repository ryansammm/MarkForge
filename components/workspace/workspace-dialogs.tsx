'use client'

import { useId, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * The two dialogs the tree needs: ask for a name, and confirm something
 * irreversible. Both are deliberately plain — nothing in a file tree benefits from
 * being surprising.
 */

interface PromptDialogProps {
  open: boolean
  title: string
  description?: string
  label: string
  initialValue?: string
  /** Shown under the field — e.g. how many documents a rename will touch. */
  hint?: React.ReactNode
  confirmLabel?: string
  busy?: boolean
  error?: string | null
  onSubmit: (value: string) => void
  onOpenChange: (open: boolean) => void
}

export function PromptDialog({ open, initialValue = '', onOpenChange, ...rest }: PromptDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {/* Keyed and mounted only while open, so the field starts from
            `initialValue` every time rather than being reset by an effect. */}
        {open && (
          <PromptForm key={initialValue} initialValue={initialValue} onOpenChange={onOpenChange} {...rest} />
        )}
      </DialogContent>
    </Dialog>
  )
}

type PromptFormProps = Omit<PromptDialogProps, 'open'> & { initialValue: string }

function PromptForm({
  title,
  description,
  label,
  initialValue,
  hint,
  confirmLabel = 'Save',
  busy = false,
  error,
  onSubmit,
  onOpenChange,
}: PromptFormProps) {
  const [value, setValue] = useState(initialValue)
  const inputId = useId()

  const trimmed = value.trim()
  const canSubmit = trimmed.length > 0 && !busy

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (canSubmit) onSubmit(trimmed)
      }}
    >
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description && <DialogDescription>{description}</DialogDescription>}
      </DialogHeader>

      <div className="flex flex-col gap-2 py-4">
        <label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">
          {label}
        </label>
        <Input
          id={inputId}
          value={value}
          autoFocus
          spellCheck={false}
          onChange={(event) => setValue(event.target.value)}
          className="font-mono text-sm"
        />
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSubmit}>
          {busy && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
          {confirmLabel}
        </Button>
      </DialogFooter>
    </form>
  )
}

interface ConfirmDialogProps {
  open: boolean
  title: string
  description: React.ReactNode
  confirmLabel?: string
  busy?: boolean
  error?: string | null
  onConfirm: () => void
  onOpenChange: (open: boolean) => void
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Delete',
  busy = false,
  error,
  onConfirm,
  onOpenChange,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-destructive" />
            {title}
          </DialogTitle>
        </DialogHeader>

        {/* Outside DialogDescription: that renders a <p>, and these bodies contain
            lists and block elements, which are not valid inside one. */}
        <div className="text-sm text-muted-foreground">{description}</div>

        {error && <p className="pt-2 text-xs text-destructive">{error}</p>}

        <DialogFooter className="pt-4">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm} disabled={busy}>
            {busy && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
