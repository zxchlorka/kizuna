import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { ConnectionTagsField } from '@/components/ConnectionWizard/ConnectionTagsField'
import { describeDsn, parseDsn } from '@/lib/postgresDsn'
import type { ConnectionFormValues } from '@/lib/connectionForms'

interface PostgresConnectionFormProps {
  form: ConnectionFormValues
  onChange: (patch: Partial<ConnectionFormValues>) => void
  isEdit: boolean
}

export function PostgresConnectionForm({ form, onChange, isEdit }: PostgresConnectionFormProps) {
  const [filledFrom, setFilledFrom] = useState<string | null>(null)
  const [dsnText, setDsnText] = useState('')

  const applyDsn = (text: string) => {
    setDsnText(text)
    const parsed = parseDsn(text)
    if (!parsed) {
      setFilledFrom(null)
      return
    }
    onChange({
      ...(parsed.host !== undefined ? { host: parsed.host } : {}),
      ...(parsed.port !== undefined ? { port: String(parsed.port) } : {}),
      ...(parsed.database !== undefined ? { database: parsed.database } : {}),
      ...(parsed.username !== undefined ? { username: parsed.username } : {}),
      ...(parsed.password !== undefined ? { password: parsed.password } : {}),
    })
    setFilledFrom(describeDsn(parsed))
  }

  // A connection string is how these are actually shared — in a wiki, a ticket,
  // a colleague's message — so pasting one into the first field it fits should
  // fill the form rather than land in Host verbatim. Both shapes Postgres itself
  // accepts are recognised; anything else pastes normally.
  const handlePaste = (event: React.ClipboardEvent<HTMLInputElement>) => {
    const parsed = parseDsn(event.clipboardData.getData('text'))
    if (!parsed) {
      return
    }
    event.preventDefault()

    onChange({
      ...(parsed.host !== undefined ? { host: parsed.host } : {}),
      ...(parsed.port !== undefined ? { port: String(parsed.port) } : {}),
      ...(parsed.database !== undefined ? { database: parsed.database } : {}),
      ...(parsed.username !== undefined ? { username: parsed.username } : {}),
      // An edit form shows a masked password it never received; overwriting it
      // from a DSN that carries one is intended, leaving it alone otherwise.
      ...(parsed.password !== undefined ? { password: parsed.password } : {}),
    })
    setFilledFrom(describeDsn(parsed))
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          Connection string <span className="normal-case tracking-normal opacity-60">— optional, fills the rest</span>
        </label>
        <Input
          value={dsnText}
          onChange={(event) => applyDsn(event.target.value)}
          onPaste={(event) => {
            // Handled here as well as onChange so a paste fills the form in the
            // same tick, rather than after React round-trips the value.
            const pasted = event.clipboardData.getData('text')
            if (parseDsn(pasted)) {
              event.preventDefault()
              applyDsn(pasted)
            }
          }}
          placeholder="postgres://user:pass@host:5432/dbname"
          className="font-mono"
        />
        {filledFrom && (
          <p className="mt-1 font-mono text-[11px] text-amber-600 dark:text-amber-400">Filled: {filledFrom}.</p>
        )}
      </div>

      <div>
        <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          Name
        </label>
        <Input
          value={form.name}
          onChange={(event) => onChange({ name: event.target.value })}
          placeholder="Analytics Primary"
          className="font-mono"
          autoFocus
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_96px]">
        <div>
          <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Host
          </label>
          <Input
            value={form.host}
            onChange={(event) => onChange({ host: event.target.value })}
            onPaste={handlePaste}
            placeholder="localhost"
            className="font-mono"
          />
          {filledFrom && (
            <p className="mt-1 font-mono text-[11px] text-amber-600 dark:text-amber-400">
              Filled from the pasted string: {filledFrom}.
            </p>
          )}
        </div>
        <div>
          <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Port
          </label>
          <Input
            type="number"
            value={form.port}
            onChange={(event) => onChange({ port: event.target.value })}
            className="font-mono"
          />
        </div>
      </div>

      <div>
        <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          Database
        </label>
        <Input
          value={form.database}
          onChange={(event) => onChange({ database: event.target.value })}
          placeholder="mydb"
          className="font-mono"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Username
          </label>
          <Input
            value={form.username}
            onChange={(event) => onChange({ username: event.target.value })}
            placeholder="postgres"
            className="font-mono"
          />
        </div>
        <div>
          <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Password
            {isEdit && <span className="ml-1 normal-case opacity-50">(blank = keep)</span>}
          </label>
          <Input
            type="password"
            value={form.password}
            onChange={(event) => onChange({ password: event.target.value })}
            placeholder={isEdit ? '••••••••' : ''}
            className="font-mono"
          />
        </div>
      </div>

      <div>
        <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          Tags
        </label>
        <ConnectionTagsField value={form.tagsText} onChange={(value) => onChange({ tagsText: value })} />
      </div>
    </div>
  )
}

