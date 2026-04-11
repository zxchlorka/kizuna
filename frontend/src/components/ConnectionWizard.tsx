import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowLeft, CheckCircle2, Database, Loader2, Server, X, XCircle } from 'lucide-react'
import { PostgresConnectionForm } from '@/components/ConnectionWizard/PostgresConnectionForm'
import { RedisConnectionForm } from '@/components/ConnectionWizard/RedisConnectionForm'
import {
  buildConnectionInput,
  createConnectionForm,
  createConnectionFormFromConnection,
  validateConnectionForm,
  type ConnectionFormValues,
} from '@/lib/connectionForms'
import { cn } from '@/lib/utils'
import { useConnectionStore } from '@/stores/connections'
import type { Connection, ConnectionInput, RedisConnectionInput } from '@/types/api'

interface ConnectionWizardProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  editConnection?: Connection
}

const unchangedPasswordToken = '__keep_existing_password__'

function buildConnectionTestKey(form: ConnectionFormValues, isEdit: boolean) {
  const input = buildConnectionInput(form)
  const passwordKey = isEdit && input.password === '' ? unchangedPasswordToken : input.password

  return JSON.stringify({
    type: input.type,
    host: input.host.trim(),
    port: input.port,
    database: String(input.database).trim(),
    username: input.username.trim(),
    password: passwordKey,
    redis_config:
      input.type === 'redis'
        ? {
            mode: input.redis_config.mode ?? 'standalone',
            addresses: input.redis_config.addresses ?? [],
            sentinel_addrs: input.redis_config.sentinel_addrs ?? [],
            master_name: input.redis_config.master_name ?? '',
            separator: input.redis_config.separator ?? ':',
            tls_enabled: input.redis_config.tls_enabled ?? false,
          }
        : null,
  })
}

function toUpdatePayload(form: ConnectionFormValues, editConnection: Connection): Partial<ConnectionInput> {
  const input = buildConnectionInput(form)

  if (input.type === 'redis') {
    const payload: Partial<RedisConnectionInput> = { ...input }
    if (!payload.password) {
      delete payload.password
    }
    return payload
  }

  const payload: Partial<ConnectionInput> = {
    ...input,
    visible_schemas: editConnection.visible_schemas ?? null,
  }
  if (!payload.password) {
    delete payload.password
  }
  return payload
}

export function ConnectionWizard({ open, onOpenChange, editConnection }: ConnectionWizardProps) {
  const navigate = useNavigate()
  const store = useConnectionStore()
  const isEdit = !!editConnection
  const [step, setStep] = useState<1 | 2>(1)
  const [form, setForm] = useState<ConnectionFormValues>(() => createConnectionForm('postgres'))
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [lastSuccessfulTestKey, setLastSuccessfulTestKey] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{ ok: boolean; latency_ms: number; error?: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const validationError = useMemo(() => validateConnectionForm(form, isEdit), [form, isEdit])
  const isFormValid = validationError === null
  const currentTestKey = useMemo(() => buildConnectionTestKey(form, isEdit), [form, isEdit])
  const baselineTestKey = useMemo(
    () => (editConnection ? buildConnectionTestKey(createConnectionFormFromConnection(editConnection), true) : null),
    [editConnection]
  )
  const requiresSuccessfulTest = !isEdit || currentTestKey !== baselineTestKey
  const canSave = isFormValid && !testing && !saving && (!requiresSuccessfulTest || lastSuccessfulTestKey === currentTestKey)

  useEffect(() => {
    if (!open) {
      return
    }

    setTesting(false)
    setSaving(false)
    setLastSuccessfulTestKey(null)
    setTestResult(null)
    setError(null)

    if (editConnection) {
      setStep(2)
      setForm(createConnectionFormFromConnection(editConnection))
      return
    }

    setStep(1)
    setForm(createConnectionForm('postgres'))
  }, [editConnection, open])

  const updateForm = (patch: Partial<ConnectionFormValues>) => {
    setForm((prev) => ({ ...prev, ...patch }))
    setTestResult(null)
    setError(null)
  }

  const persist = async (): Promise<string> => {
    if (isEdit && editConnection) {
      await store.update(editConnection.id, toUpdatePayload(form, editConnection))
      return editConnection.id
    }

    const connection = await store.create(buildConnectionInput(form))
    return connection.id
  }

  const handleTest = async () => {
    if (!isFormValid) {
      setError(validationError)
      return
    }

    setTesting(true)
    setTestResult(null)
    setError(null)

    try {
      const result = await store.testConfig({
        ...(editConnection ? { id: editConnection.id } : {}),
        ...buildConnectionInput(form),
      })
      setTestResult(result)
      setLastSuccessfulTestKey(currentTestKey)
    } catch (e) {
      setLastSuccessfulTestKey(null)
      setError((e as Error).message)
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    if (!isFormValid) {
      setError(validationError)
      return
    }

    if (requiresSuccessfulTest && lastSuccessfulTestKey !== currentTestKey) {
      setError(isEdit ? 'Run a successful connection test before saving updated access settings.' : 'Run a successful connection test before saving.')
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

  const selectType = (type: 'postgres' | 'redis') => {
    setForm(createConnectionForm(type))
    setStep(2)
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-fade-in" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-50 m-auto h-fit max-h-[calc(100vh-2rem)] w-full max-w-4xl overflow-y-auto rounded-sm border border-border bg-background shadow-2xl data-[state=open]:animate-fade-in"
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

          {step === 1 && (
            <div className="space-y-4 px-6 py-5">
              <p className="text-xs text-muted-foreground">Select connection type</p>
              <div className="grid gap-3 sm:grid-cols-3">
                <button
                  type="button"
                  onClick={() => selectType('postgres')}
                  className="group relative flex flex-col items-center gap-2 rounded-sm border-2 border-amber-500/50 bg-amber-500/5 p-4 transition-colors hover:bg-amber-500/10"
                >
                  <Database className="h-7 w-7 text-blue-400" />
                  <span className="font-mono text-xs font-medium">PostgreSQL</span>
                  <div className="absolute -left-px -top-px h-2 w-2 bg-amber-500" />
                  <div className="absolute -right-px -top-px h-2 w-2 bg-amber-500" />
                  <div className="absolute -left-px -bottom-px h-2 w-2 bg-amber-500" />
                  <div className="absolute -right-px -bottom-px h-2 w-2 bg-amber-500" />
                </button>
                <button
                  type="button"
                  onClick={() => selectType('redis')}
                  className="group relative flex flex-col items-center gap-2 rounded-sm border border-border bg-background p-4 transition-colors hover:border-red-500/50 hover:bg-red-500/5"
                >
                  <Server className="h-7 w-7 text-red-400" />
                  <span className="font-mono text-xs font-medium">Redis</span>
                  <span className="text-[10px] text-muted-foreground">Standalone / Cluster / Sentinel</span>
                </button>
                <div className="flex cursor-not-allowed select-none flex-col items-center gap-2 rounded-sm border border-border p-4 opacity-35">
                  <Database className="h-7 w-7 text-orange-400" />
                  <span className="font-mono text-xs font-medium">Kafka</span>
                  <span className="text-[10px] text-muted-foreground">Next slice</span>
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4 px-6 py-5">
              {form.type === 'redis' ? (
                <RedisConnectionForm form={form} onChange={updateForm} isEdit={isEdit} />
              ) : (
                <PostgresConnectionForm form={form} onChange={updateForm} isEdit={isEdit} />
              )}

              {(testing || testResult || error) && (
                <div
                  className={cn(
                    'flex items-center gap-2 rounded-sm border px-3 py-2.5 text-xs font-mono',
                    testResult?.ok && 'border-green-500/30 bg-green-500/5 text-green-500',
                    ((testResult && !testResult.ok) || error) && 'border-red-500/30 bg-red-500/5 text-red-400',
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

              <div className="space-y-2 pt-1">
                <div className="flex items-center justify-between">
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
                      disabled={!isFormValid || testing || saving}
                      className={cn(
                        'rounded-sm border px-3 py-2 font-mono text-xs transition-colors',
                        isFormValid && !testing && !saving
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
                      disabled={!canSave}
                      className={cn(
                        'rounded-sm px-4 py-2 font-mono text-xs font-medium transition-colors',
                        canSave
                          ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                          : 'cursor-not-allowed bg-muted text-muted-foreground/40'
                      )}
                    >
                      {saving ? (
                        <span className="flex items-center gap-1.5">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Saving...
                        </span>
                      ) : isEdit ? (
                        'Save Changes'
                      ) : (
                        'Save'
                      )}
                    </button>
                  </div>
                </div>

                {!canSave && isFormValid && !testing && !saving && requiresSuccessfulTest && (
                  <p className="text-right font-mono text-[10px] text-muted-foreground">
                    {isEdit ? 'Re-test the updated connection before saving.' : 'Successful test required before saving a new connection.'}
                  </p>
                )}
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
