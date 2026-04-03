import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import * as Dialog from '@radix-ui/react-dialog'
import { Database, X, Loader2, CheckCircle2, XCircle, ArrowLeft } from 'lucide-react'
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
}

export function ConnectionWizard({ open, onOpenChange, editConnection }: ConnectionWizardProps) {
  const navigate = useNavigate()
  const store = useConnectionStore()
  const isEdit = !!editConnection

  // step 1 = type selector, step 2 = form+test+save
  const [step, setStep] = useState<1 | 2>(1)
  const [form, setForm] = useState<ConnectionInput>(blankForm)
  const [savedId, setSavedId] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; latency_ms: number; error?: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setTesting(false)
    setSaving(false)
    setTestResult(null)
    setError(null)
    if (editConnection) {
      setStep(2)
      setSavedId(editConnection.id)
      setForm({
        name: editConnection.name,
        type: editConnection.type,
        host: editConnection.host,
        port: editConnection.port,
        database: editConnection.database,
        username: editConnection.username,
        password: '',
      })
    } else {
      setStep(1)
      setSavedId(null)
      setForm(blankForm)
    }
  }, [editConnection, open])

  const updateField = <K extends keyof ConnectionInput>(key: K, value: ConnectionInput[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
    // Reset test result when user edits fields
    setTestResult(null)
    setError(null)
  }

  const isFormValid = !!(form.name && form.host && form.port && form.database && form.username)

  // Persist connection (create or update), returns id
  const persist = async (): Promise<string> => {
    if (isEdit && savedId) {
      const payload: Partial<ConnectionInput> = { ...form }
      if (!payload.password) delete payload.password
      await store.update(savedId, payload)
      return savedId
    }
    if (savedId) {
      // Already created during a previous test run — just update
      const payload: Partial<ConnectionInput> = { ...form }
      await store.update(savedId, payload)
      return savedId
    }
    const conn = await store.create(form)
    setSavedId(conn.id)
    return conn.id
  }

  const handleTest = async () => {
    if (!isFormValid) return
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
    if (!isFormValid) return
    setSaving(true)
    setError(null)
    try {
      const id = await persist()
      onOpenChange(false)
      if (!isEdit) navigate(`/connections/${id}`)
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
          className="fixed inset-0 z-50 m-auto w-full max-w-lg h-fit max-h-[calc(100vh-2rem)] rounded-sm border border-border bg-background shadow-2xl data-[state=open]:animate-fade-in overflow-y-auto"
        >
          {/* ── Header ─────────────────────────────────────── */}
          <div className="flex items-center justify-between border-b border-border px-6 py-4">
            <Dialog.Title className="font-bold font-mono text-sm">
              {isEdit ? 'Edit Connection' : 'New Connection'}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                Step {step} of {isEdit ? 1 : 2}
              </span>
            </Dialog.Title>
            <Dialog.Close className="rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          {/* ── Step 1: Type selector ───────────────────────── */}
          {step === 1 && (
            <div className="px-6 py-5 space-y-4">
              <p className="text-xs text-muted-foreground">Select connection type</p>
              <div className="grid grid-cols-3 gap-3">
                <button
                  onClick={() => { updateField('type', 'postgres'); setStep(2) }}
                  className="group relative flex flex-col items-center gap-2 rounded-sm border-2 border-amber-500/50 bg-amber-500/5 p-4 hover:bg-amber-500/10 transition-colors"
                >
                  <Database className="h-7 w-7 text-blue-400" />
                  <span className="text-xs font-medium font-mono">PostgreSQL</span>
                  <div className="absolute -left-px -top-px h-2 w-2 bg-amber-500" />
                  <div className="absolute -right-px -top-px h-2 w-2 bg-amber-500" />
                  <div className="absolute -left-px -bottom-px h-2 w-2 bg-amber-500" />
                  <div className="absolute -right-px -bottom-px h-2 w-2 bg-amber-500" />
                </button>
                <div className="flex flex-col items-center gap-2 rounded-sm border border-border p-4 opacity-35 cursor-not-allowed select-none">
                  <Database className="h-7 w-7 text-red-400" />
                  <span className="text-xs font-medium font-mono">Redis</span>
                  <span className="text-[10px] text-muted-foreground">v0.2</span>
                </div>
                <div className="flex flex-col items-center gap-2 rounded-sm border border-border p-4 opacity-35 cursor-not-allowed select-none">
                  <Database className="h-7 w-7 text-orange-400" />
                  <span className="text-xs font-medium font-mono">Kafka</span>
                  <span className="text-[10px] text-muted-foreground">v0.3</span>
                </div>
              </div>
            </div>
          )}

          {/* ── Step 2: Form + inline test + save ──────────── */}
          {step === 2 && (
            <div className="px-6 py-5 space-y-4">
              {/* Fields */}
              <div>
                <label className={labelCls}>Name</label>
                <input type="text" value={form.name} onChange={(e) => updateField('name', e.target.value)} placeholder="My Database" className={inputCls} autoFocus />
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className={labelCls}>Host</label>
                  <input type="text" value={form.host} onChange={(e) => updateField('host', e.target.value)} placeholder="localhost" className={inputCls} />
                </div>
                <div className="w-24">
                  <label className={labelCls}>Port</label>
                  <input type="number" value={form.port} onChange={(e) => updateField('port', parseInt(e.target.value) || 0)} className={inputCls} />
                </div>
              </div>
              <div>
                <label className={labelCls}>Database</label>
                <input type="text" value={form.database} onChange={(e) => updateField('database', e.target.value)} placeholder="mydb" className={inputCls} />
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className={labelCls}>Username</label>
                  <input type="text" value={form.username} onChange={(e) => updateField('username', e.target.value)} placeholder="postgres" className={inputCls} />
                </div>
                <div className="flex-1">
                  <label className={labelCls}>
                    Password
                    {isEdit && <span className="ml-1 normal-case opacity-50">(blank = keep)</span>}
                  </label>
                  <input type="password" value={form.password} onChange={(e) => updateField('password', e.target.value)} placeholder={isEdit ? '••••••••' : ''} className={inputCls} />
                </div>
              </div>

              {/* ── Inline test result ── */}
              {(testing || testResult || error) && (
                <div className={cn(
                  'flex items-center gap-2 rounded-sm border px-3 py-2.5 text-xs font-mono',
                  testResult?.ok && 'border-green-500/30 bg-green-500/5 text-green-500',
                  (testResult && !testResult.ok || error) && 'border-red-500/30 bg-red-500/5 text-red-400',
                  testing && 'border-border bg-muted/30 text-muted-foreground'
                )}>
                  {testing && <><Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" /> Testing connection…</>}
                  {testResult?.ok && <><CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> Connected — {testResult.latency_ms}ms</>}
                  {(testResult && !testResult.ok) && <><XCircle className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{testResult.error}</span></>}
                  {(!testResult && error) && <><XCircle className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{error}</span></>}
                </div>
              )}

              {/* ── Footer ── */}
              <div className="flex items-center justify-between pt-1">
                {/* Back / spacer */}
                {!isEdit ? (
                  <button onClick={() => setStep(1)} className="flex items-center gap-1 rounded-sm px-3 py-2 text-xs text-muted-foreground hover:bg-muted font-mono transition-colors">
                    <ArrowLeft className="h-3.5 w-3.5" /> Back
                  </button>
                ) : <div />}

                {/* Right actions */}
                <div className="flex items-center gap-2">
                  {/* Test button — subtle */}
                  <button
                    onClick={handleTest}
                    disabled={!isFormValid || testing || saving}
                    className={cn(
                      'rounded-sm border px-3 py-2 text-xs font-mono transition-colors',
                      isFormValid && !testing && !saving
                        ? 'border-amber-500/40 bg-amber-500/8 text-amber-500 hover:bg-amber-500/15 hover:border-amber-500/70'
                        : 'border-border text-muted-foreground/40 cursor-not-allowed'
                    )}
                  >
                    {testing ? <span className="flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" />Testing…</span> : 'Test'}
                  </button>

                  {/* Save button */}
                  <button
                    onClick={handleSave}
                    disabled={!isFormValid || testing || saving}
                    className={cn(
                      'rounded-sm px-4 py-2 text-xs font-medium font-mono transition-colors',
                      isFormValid && !testing && !saving
                        ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                        : 'bg-muted text-muted-foreground/40 cursor-not-allowed'
                    )}
                  >
                    {saving ? <span className="flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" />Saving…</span> : isEdit ? 'Save Changes' : 'Save'}
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
