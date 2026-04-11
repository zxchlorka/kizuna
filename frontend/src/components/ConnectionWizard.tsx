import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowLeft, CheckCircle2, Database, Loader2, X, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useConnectionStore } from '@/stores/connections'
import type { Connection } from '@/types/api'
import {
  buildConnectionInput,
  createConnectionForm,
  createConnectionFormFromConnection,
  validateConnectionForm,
  type ConnectionFormValues,
} from '@/lib/connectionForms'
import { ConnectionTypeSelector } from '@/components/ConnectionWizard/ConnectionTypeSelector'
import { PostgresConnectionForm } from '@/components/ConnectionWizard/PostgresConnectionForm'
import { RedisConnectionForm } from '@/components/ConnectionWizard/RedisConnectionForm'

interface ConnectionWizardProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  editConnection?: Connection
}

export function ConnectionWizard({ open, onOpenChange, editConnection }: ConnectionWizardProps) {
  const navigate = useNavigate()
  const store = useConnectionStore()
  const isEdit = !!editConnection

  const [step, setStep] = useState<1 | 2>(1)
  const [form, setForm] = useState<ConnectionFormValues>(createConnectionForm())
  const [savedId, setSavedId] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; latency_ms: number; error?: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    setTesting(false)
    setSaving(false)
    setTestResult(null)
    setError(null)

    if (editConnection) {
      setStep(2)
      setSavedId(editConnection.id)
      setForm(createConnectionFormFromConnection(editConnection))
      return
    }

    setStep(1)
    setSavedId(null)
    setForm(createConnectionForm())
  }, [editConnection, open])

  const validationError = validateConnectionForm(form, isEdit || savedId !== null)

  const updateForm = (patch: Partial<ConnectionFormValues>) => {
    setForm((prev) => ({ ...prev, ...patch }))
    setTestResult(null)
    setError(null)
  }

  const handleTypeSelect = (type: ConnectionFormValues['type']) => {
    setForm((prev) => ({
      ...createConnectionForm(type),
      name: prev.name,
      tagsText: prev.tagsText,
    }))
    setStep(2)
  }

  const persist = async (): Promise<string> => {
    const payload = buildConnectionInput(form)

    if (isEdit && savedId) {
      const updatePayload: Partial<typeof payload> = { ...payload }
      if (typeof updatePayload.password === 'string' && updatePayload.password.trim() === '') {
        delete updatePayload.password
      }
      await store.update(savedId, updatePayload)
      return savedId
    }

    if (savedId) {
      const updatePayload: Partial<typeof payload> = { ...payload }
      if (typeof updatePayload.password === 'string' && updatePayload.password.trim() === '') {
        delete updatePayload.password
      }
      await store.update(savedId, updatePayload)
      return savedId
    }

    const conn = await store.create(payload)
    setSavedId(conn.id)
    return conn.id
  }

  const handleTest = async () => {
    if (validationError) {
      setError(validationError)
      return
    }

    setTesting(true)
    setTestResult(null)
    setError(null)
    try {
      const id = await persist()
      const result = await store.test(id)
      setTestResult(result)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    if (validationError) {
      setError(validationError)
      return
    }

    setSaving(true)
    setError(null)
    try {
      const id = await persist()
      onOpenChange(false)
      if (!isEdit) {
        navigate(`/connections/${id}`)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const hasFeedback = testing || testResult !== null || error !== null

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-fade-in" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-50 m-auto h-fit max-h-[calc(100vh-2rem)] w-full max-w-2xl overflow-y-auto rounded-sm border border-border bg-background shadow-2xl data-[state=open]:animate-fade-in"
        >
          <div className="flex items-center justify-between border-b border-border px-6 py-4">
            <Dialog.Title className="font-mono text-sm font-bold">
              {isEdit ? 'Edit Connection' : 'New Connection'}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                Step {step} of {isEdit ? 1 : 2}
              </span>
            </Dialog.Title>
            <Dialog.Close className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          {step === 1 && !isEdit && (
            <div className="px-6 py-5">
              <ConnectionTypeSelector selectedType={form.type} onSelectType={handleTypeSelect} />
            </div>
          )}

          {step === 2 && (
            <div className="px-6 py-5">
              <div className="mb-4 flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                <Database className="h-3.5 w-3.5" />
                {form.type === 'redis' ? 'Redis connection details' : 'PostgreSQL connection details'}
              </div>

              {form.type === 'postgres' ? (
                <PostgresConnectionForm form={form} onChange={updateForm} isEdit={isEdit} />
              ) : (
                <RedisConnectionForm form={form} onChange={updateForm} isEdit={isEdit} />
              )}

              <div className="mt-4">
                {hasFeedback && (
                  <div
                    className={cn(
                      'flex items-center gap-2 rounded-sm border px-3 py-2.5 text-xs font-mono',
                      testResult?.ok && 'border-green-500/30 bg-green-500/5 text-green-500',
                      (testResult && !testResult.ok) || error ? 'border-red-500/30 bg-red-500/5 text-red-400' : '',
                      testing && 'border-border bg-muted/30 text-muted-foreground'
                    )}
                  >
                    {testing && (
                      <>
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                        Testing connection...
                      </>
                    )}
                    {testResult?.ok && (
                      <>
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                        Connected - {testResult.latency_ms}ms
                      </>
                    )}
                    {testResult && !testResult.ok && (
                      <>
                        <XCircle className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{testResult.error}</span>
                      </>
                    )}
                    {!testResult && error && (
                      <>
                        <XCircle className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{error}</span>
                      </>
                    )}
                  </div>
                )}

                {!hasFeedback && validationError && (
                  <p className="mt-2 text-[11px] text-muted-foreground">{validationError}</p>
                )}
              </div>

              <div className="flex items-center justify-between pt-5">
                {!isEdit ? (
                  <button
                    type="button"
                    onClick={() => setStep(1)}
                    className="flex items-center gap-1 rounded-sm px-3 py-2 font-mono text-xs text-muted-foreground transition-colors hover:bg-muted"
                  >
                    <ArrowLeft className="h-3.5 w-3.5" />
                    Back
                  </button>
                ) : (
                  <div />
                )}

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleTest}
                    disabled={Boolean(validationError) || testing || saving}
                    className={cn(
                      'rounded-sm border px-3 py-2 font-mono text-xs transition-colors',
                      !validationError && !testing && !saving
                        ? 'border-amber-500/40 bg-amber-500/8 text-amber-500 hover:border-amber-500/70 hover:bg-amber-500/15'
                        : 'cursor-not-allowed border-border text-muted-foreground/40'
                    )}
                  >
                    {testing ? (
                      <span className="flex items-center gap-1.5">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Testing...
                      </span>
                    ) : (
                      'Test'
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={Boolean(validationError) || testing || saving}
                    className={cn(
                      'rounded-sm px-4 py-2 font-mono text-xs font-medium transition-colors',
                      !validationError && !testing && !saving
                        ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                        : 'cursor-not-allowed bg-muted text-muted-foreground/40'
                    )}
                  >
                    {saving ? (
                      <span className="flex items-center gap-1.5">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Saving...
                      </span>
                    ) : isEdit ? 'Save Changes' : 'Save'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
