import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { ConnectionTagsField } from '@/components/ConnectionWizard/ConnectionTagsField'
import { parseDsn } from '@/lib/postgresDsn'
import type { ConnectionFormValues } from '@/lib/connectionForms'
import type { PostgresSSLMode } from '@/types/api'

interface PostgresConnectionFormProps {
  form: ConnectionFormValues
  onChange: (patch: Partial<ConnectionFormValues>) => void
  isEdit: boolean
}

const SSL_MODES: { value: PostgresSSLMode; label: string; hint: string }[] = [
  { value: 'disable', label: 'disable', hint: 'No TLS. The password crosses the network in the clear.' },
  { value: 'prefer', label: 'prefer', hint: 'TLS when the server offers it, plaintext when it does not. Not verified either way.' },
  { value: 'require', label: 'require', hint: 'TLS always. Without a CA below nothing about the certificate is checked.' },
  { value: 'verify-ca', label: 'verify-ca', hint: 'The certificate must be signed by a trusted CA. Its hostname is not checked.' },
  { value: 'verify-full', label: 'verify-full', hint: 'Signed by a trusted CA and issued for this host. Use this against anything real.' },
]

// A DSN that names an sslmode is describing the server's requirement, so it is
// worth honouring — a pasted "?sslmode=require" should not land in a form that
// then connects in the clear.
const parsedSslMode = (value: string | undefined): PostgresSSLMode | undefined =>
  SSL_MODES.some((mode) => mode.value === value) ? (value as PostgresSSLMode) : undefined

export function PostgresConnectionForm({ form, onChange, isEdit }: PostgresConnectionFormProps) {
  const [dsnText, setDsnText] = useState('')
  const activeMode = SSL_MODES.find((mode) => mode.value === form.pgSslMode) ?? SSL_MODES[0]

  const applyDsn = (text: string) => {
    setDsnText(text)
    const parsed = parseDsn(text)
    if (!parsed) {
      return
    }
    const sslMode = parsedSslMode(parsed.sslmode)
    onChange({
      ...(parsed.host !== undefined ? { host: parsed.host } : {}),
      ...(parsed.port !== undefined ? { port: String(parsed.port) } : {}),
      ...(parsed.database !== undefined ? { database: parsed.database } : {}),
      ...(parsed.username !== undefined ? { username: parsed.username } : {}),
      ...(parsed.password !== undefined ? { password: parsed.password } : {}),
      ...(sslMode !== undefined ? { pgSslMode: sslMode } : {}),
    })
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

    const sslMode = parsedSslMode(parsed.sslmode)
    onChange({
      ...(parsed.host !== undefined ? { host: parsed.host } : {}),
      ...(parsed.port !== undefined ? { port: String(parsed.port) } : {}),
      ...(parsed.database !== undefined ? { database: parsed.database } : {}),
      ...(parsed.username !== undefined ? { username: parsed.username } : {}),
      // An edit form shows a masked password it never received; overwriting it
      // from a DSN that carries one is intended, leaving it alone otherwise.
      ...(parsed.password !== undefined ? { password: parsed.password } : {}),
      ...(sslMode !== undefined ? { pgSslMode: sslMode } : {}),
    })
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

      <div className="space-y-4 rounded-md border border-border/60 p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <label className="block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              TLS
            </label>
            <p className="mt-1 text-[11px] text-muted-foreground">{activeMode.hint}</p>
          </div>
          <div className="w-36 shrink-0">
            <Select
              value={form.pgSslMode}
              onValueChange={(value) => onChange({ pgSslMode: value as PostgresSSLMode })}
            >
              <SelectTrigger className="font-mono text-xs">
                <SelectValue placeholder="sslmode" />
              </SelectTrigger>
              <SelectContent>
                {SSL_MODES.map((mode) => (
                  <SelectItem key={mode.value} value={mode.value}>
                    {mode.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {form.pgSslMode !== 'disable' && (
          <>
            <div>
              <label
                htmlFor="pg-ssl-root-cert"
                className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground"
              >
                CA certificate (PEM)
              </label>
              <Textarea
                id="pg-ssl-root-cert"
                value={form.pgSslRootCert}
                onChange={(event) => onChange({ pgSslRootCert: event.target.value })}
                placeholder={'-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----'}
                className="min-h-24 resize-y font-mono text-xs"
                spellCheck={false}
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Needed for a certificate the system does not already trust — a private CA, or a cloud
                provider's own root. Leave blank to verify against the system trust store.
              </p>
            </div>

            <div>
              <label
                htmlFor="pg-ssl-server-name"
                className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground"
              >
                Server name <span className="normal-case tracking-normal opacity-60">— optional</span>
              </label>
              <Input
                id="pg-ssl-server-name"
                value={form.pgSslServerName}
                onChange={(event) => onChange({ pgSslServerName: event.target.value })}
                placeholder="db.internal.example"
                className="font-mono"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                The name the certificate is checked against, when it differs from Host — connecting
                through a tunnel, an IP address, or a proxy.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="pg-ssl-client-cert"
                  className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground"
                >
                  Client certificate
                </label>
                <Textarea
                  id="pg-ssl-client-cert"
                  value={form.pgSslClientCert}
                  onChange={(event) => onChange({ pgSslClientCert: event.target.value })}
                  placeholder={'-----BEGIN CERTIFICATE-----'}
                  className="min-h-20 resize-y font-mono text-xs"
                  spellCheck={false}
                />
              </div>
              <div>
                <label
                  htmlFor="pg-ssl-client-key"
                  className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground"
                >
                  Client key
                  {isEdit && form.pgSslClientCert && (
                    <span className="ml-1 normal-case opacity-50">(blank = keep)</span>
                  )}
                </label>
                <Textarea
                  id="pg-ssl-client-key"
                  value={form.pgSslClientKey}
                  onChange={(event) => onChange({ pgSslClientKey: event.target.value })}
                  placeholder={isEdit && form.pgSslClientCert ? '••••••••' : '-----BEGIN PRIVATE KEY-----'}
                  className="min-h-20 resize-y font-mono text-xs"
                  spellCheck={false}
                />
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Only for servers that authenticate clients by certificate. The key is encrypted with the
              rest of the configuration and is never sent back to this form.
            </p>
          </>
        )}
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

