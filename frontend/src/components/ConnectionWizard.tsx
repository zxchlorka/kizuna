import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowLeft, CheckCircle2, Database, Loader2, X, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useConnectionStore } from '@/stores/connections'
import type { Connection, ConnectionInput } from '@/types/api'

interface ConnectionWizardProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  editConnection?: Connection
}

const blankForm: ConnectionInput = {
  name: '',
  type: 'postgres',
  host: 'localhost',
  port: 5432,
  database: '',
  username: '',
  password: '',
  tags: [],
}

const unchangedPasswordToken = '__keep_existing_password__'

function buildConnectionTestKey(form: ConnectionInput, isEdit: boolean) {
  const passwordKey = isEdit && form.password === '' ? unchangedPasswordToken : form.password

  return JSON.stringify({
    type: form.type,
    host: form.host.trim(),
    port: form.port,
    database: form.database.trim(),
    username: form.username.trim(),
    password: passwordKey,
  })
}

function buildExistingConnectionTestKey(connection: Connection) {
  return JSON.stringify({
    type: connection.type,
    host: connection.host.trim(),
    port: connection.port,
    database: connection.database.trim(),
    username: connection.username.trim(),
    password: unchangedPasswordToken,
  })
}

export function ConnectionWizard({ open, onOpenChange, editConnection }: ConnectionWizardProps) {
  const navigate = useNavigate()
  const store = useConnectionStore()
  const isEdit = !!editConnection
  const [step, setStep] = useState<1 | 2>(1)
  const [form, setForm] = useState<ConnectionInput>(blankForm)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [lastSuccessfulTestKey, setLastSuccessfulTestKey] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{ ok: boolean; latency_ms: number; error?: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const isFormValid = !!(form.name && form.host && form.port && form.database && form.username)
  const currentTestKey = buildConnectionTestKey(form, isEdit)
  const baselineTestKey = editConnection ? buildExistingConnectionTestKey(editConnection) : null
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
      setForm({
        name: editConnection.name,
        type: editConnection.type,
        host: editConnection.host,
        port: editConnection.port,
        database: editConnection.database,
        username: editConnection.username,
        password: '',
        tags: editConnection.tags ?? [],
      })
      return
    }

    setStep(1)
    setForm(blankForm)
  }, [editConnection, open])

  const updateField = <K extends keyof ConnectionInput>(key: K, value: ConnectionInput[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))

    if (key === 'type' || key === 'host' || key === 'port' || key === 'database' || key === 'username' || key === 'password') {
      setTestResult(null)
    }

    setError(null)
  }

  const persist = async (): Promise<string> => {
    if (isEdit && editConnection) {
      const payload: Partial<ConnectionInput> = { ...form }
      if (!payload.password) {
        delete payload.password
      }
      await store.update(editConnection.id, payload)
      return editConnection.id
    }

    const connection = await store.create(form)
    return connection.id
  }

  const handleTest = async () => {
    if (!isFormValid) {
      return
    }

    setTesting(true)
    setTestResult(null)
    setError(null)

    try {
      const result = await store.testConfig({
        ...(editConnection ? { id: editConnection.id } : {}),
        ...form,
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

  const inputCls = cn(
    'w-full rounded-sm border border-input bg-background px-3 py-2 text-sm font-mono outline-none',
    'placeholder:text-muted-foreground/30',
    'focus:border-amber-500/60 focus:ring-0 transition-colors duration-150'
  )
  const labelCls = 'mb-1 block text-[10px] font-medium text-muted-foreground uppercase tracking-[0.12em]'

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-fade-in" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-50 m-auto h-fit max-h-[calc(100vh-2rem)] w-full max-w-lg overflow-y-auto rounded-sm border border-border bg-background shadow-2xl data-[state=open]:animate-fade-in"
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
              <div className="grid grid-cols-3 gap-3">
                <button
                  onClick={() => {
                    updateField('type', 'postgres')
                    setStep(2)
                  }}
                  className="group relative flex flex-col items-center gap-2 rounded-sm border-2 border-amber-500/50 bg-amber-500/5 p-4 transition-colors hover:bg-amber-500/10"
                >
                  <Database className="h-7 w-7 text-blue-400" />
                  <span className="font-mono text-xs font-medium">PostgreSQL</span>
                  <div className="absolute -left-px -top-px h-2 w-2 bg-amber-500" />
                  <div className="absolute -right-px -top-px h-2 w-2 bg-amber-500" />
                  <div className="absolute -left-px -bottom-px h-2 w-2 bg-amber-500" />
                  <div className="absolute -right-px -bottom-px h-2 w-2 bg-amber-500" />
                </button>
                <div className="flex cursor-not-allowed select-none flex-col items-center gap-2 rounded-sm border border-border p-4 opacity-35">
                  <Database className="h-7 w-7 text-red-400" />
                  <span className="font-mono text-xs font-medium">Redis</span>
                  <span className="text-[10px] text-muted-foreground">v0.2</span>
                </div>
                <div className="flex cursor-not-allowed select-none flex-col items-center gap-2 rounded-sm border border-border p-4 opacity-35">
                  <Database className="h-7 w-7 text-orange-400" />
                  <span className="font-mono text-xs font-medium">Kafka</span>
                  <span className="text-[10px] text-muted-foreground">v0.3</span>
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4 px-6 py-5">
              <div>
                <label className={labelCls}>Name</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => updateField('name', e.target.value)}
                  placeholder="My Database"
                  className={inputCls}
                  autoFocus
                />
              </div>

              <div className="flex gap-3">
                <div className="flex-1">
                  <label className={labelCls}>Host</label>
                  <input
                    type="text"
                    value={form.host}
                    onChange={(e) => updateField('host', e.target.value)}
                    placeholder="localhost"
                    className={inputCls}
                  />
                </div>
                <div className="w-24">
                  <label className={labelCls}>Port</label>
                  <input
                    type="number"
                    value={form.port}
                    onChange={(e) => updateField('port', parseInt(e.target.value, 10) || 0)}
                    className={inputCls}
                  />
                </div>
              </div>

              <div>
                <label className={labelCls}>Database</label>
                <input
                  type="text"
                  value={form.database}
                  onChange={(e) => updateField('database', e.target.value)}
                  placeholder="mydb"
                  className={inputCls}
                />
              </div>

              <div className="flex gap-3">
                <div className="flex-1">
                  <label className={labelCls}>Username</label>
                  <input
                    type="text"
                    value={form.username}
                    onChange={(e) => updateField('username', e.target.value)}
                    placeholder="postgres"
                    className={inputCls}
                  />
                </div>
                <div className="flex-1">
                  <label className={labelCls}>
                    Password
                    {isEdit && <span className="ml-1 normal-case opacity-50">(blank = keep)</span>}
                  </label>
                  <input
                    type="password"
                    value={form.password}
                    onChange={(e) => updateField('password', e.target.value)}
                    placeholder={isEdit ? '••••••••' : ''}
                    className={inputCls}
                  />
                </div>
              </div>

              <div>
                <label className={labelCls}>Tags</label>
                <input
                  type="text"
                  value={form.tags.join(', ')}
                  onChange={(e) =>
                    updateField(
                      'tags',
                      e.target.value
                        .split(',')
                        .map((tag) => tag.trim())
                        .filter(Boolean)
                    )
                  }
                  placeholder="production, reporting"
                  className={inputCls}
                />
                <p className="mt-1 text-[10px] text-muted-foreground">Use explicit tags like `production` to enable safety banners.</p>
              </div>

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
