import { Input } from '@/components/ui/input'
import { ConnectionTagsField } from '@/components/ConnectionWizard/ConnectionTagsField'
import type { ConnectionFormValues } from '@/lib/connectionForms'

interface PostgresConnectionFormProps {
  form: ConnectionFormValues
  onChange: (patch: Partial<ConnectionFormValues>) => void
  isEdit: boolean
}

export function PostgresConnectionForm({ form, onChange, isEdit }: PostgresConnectionFormProps) {
  return (
    <div className="space-y-4">
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

      <div>
        <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          Tags
        </label>
        <ConnectionTagsField value={form.tagsText} onChange={(value) => onChange({ tagsText: value })} />
      </div>
    </div>
  )
}

