import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ConnectionTagsField } from '@/components/ConnectionWizard/ConnectionTagsField'
import type { ConnectionFormValues } from '@/lib/connectionForms'

interface KafkaConnectionFormProps {
  form: ConnectionFormValues
  onChange: (patch: Partial<ConnectionFormValues>) => void
  isEdit: boolean
}

const saslOff = '__none__'

export function KafkaConnectionForm({ form, onChange, isEdit }: KafkaConnectionFormProps) {
  const saslEnabled = form.kafkaSaslMechanism !== ''

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          Name
        </label>
        <Input
          value={form.name}
          onChange={(event) => onChange({ name: event.target.value })}
          placeholder="Kafka Cluster"
          className="font-mono"
          autoFocus
        />
      </div>

      <div>
        <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          Tags
        </label>
        <ConnectionTagsField value={form.tagsText} onChange={(value) => onChange({ tagsText: value })} />
      </div>

      <div>
        <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          Bootstrap brokers
        </label>
        <Textarea
          value={form.kafkaBrokersText}
          onChange={(event) => onChange({ kafkaBrokersText: event.target.value })}
          placeholder={'broker-1:9092\nbroker-2:9092'}
          className="min-h-20 font-mono text-xs"
        />
        <p className="mt-1 text-[11px] text-muted-foreground">One host:port per line (commas work too).</p>
      </div>

      <div className="space-y-3 rounded-sm border border-border bg-muted/10 px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <label className="block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              SASL authentication
            </label>
            <p className="mt-1 text-[11px] text-muted-foreground">PLAIN and SCRAM mechanisms are supported.</p>
          </div>
          <div className="w-48">
            <Select
              value={form.kafkaSaslMechanism === '' ? saslOff : form.kafkaSaslMechanism}
              onValueChange={(value) => onChange({ kafkaSaslMechanism: value === saslOff ? '' : value })}
            >
              <SelectTrigger className="font-mono text-xs">
                <SelectValue placeholder="Disabled" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={saslOff}>Disabled</SelectItem>
                <SelectItem value="PLAIN">PLAIN</SelectItem>
                <SelectItem value="SCRAM-SHA-256">SCRAM-SHA-256</SelectItem>
                <SelectItem value="SCRAM-SHA-512">SCRAM-SHA-512</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {saslEnabled && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                Username
              </label>
              <Input
                value={form.username}
                onChange={(event) => onChange({ username: event.target.value })}
                placeholder="kafka-user"
                className="font-mono"
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                Password
              </label>
              <Input
                type="password"
                value={form.password}
                onChange={(event) => onChange({ password: event.target.value })}
                placeholder={isEdit ? 'Leave blank to keep current' : '••••••••'}
                className="font-mono"
              />
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-3">
          <div>
            <label className="block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              TLS
            </label>
            <p className="mt-1 text-[11px] text-muted-foreground">Encrypt broker connections.</p>
          </div>
          <Switch checked={form.tlsEnabled} onCheckedChange={(checked) => onChange({ tlsEnabled: checked })} />
        </div>
      </div>
    </div>
  )
}
