import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ConnectionTagsField } from '@/components/ConnectionWizard/ConnectionTagsField'
import { cn } from '@/lib/utils'
import type { ConnectionFormValues } from '@/lib/connectionForms'

interface RedisConnectionFormProps {
  form: ConnectionFormValues
  onChange: (patch: Partial<ConnectionFormValues>) => void
  isEdit: boolean
}

export function RedisConnectionForm({ form, onChange, isEdit }: RedisConnectionFormProps) {
  const [advancedOpen, setAdvancedOpen] = useState(true)
  const showStandaloneAddress = form.mode === 'standalone'

  const handleModeChange = (mode: ConnectionFormValues['mode']) => {
    if (mode === 'standalone') {
      onChange({
        mode,
        clusterAddressesText: '',
        sentinelMasterName: '',
        sentinelAddressesText: '',
        database: form.database || '0',
      })
      return
    }

    if (mode === 'cluster') {
      onChange({
        mode,
        database: '0',
        sentinelMasterName: '',
        sentinelAddressesText: '',
      })
      return
    }

    onChange({
      mode,
      database: '0',
      clusterAddressesText: '',
    })
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          Name
        </label>
        <Input
          value={form.name}
          onChange={(event) => onChange({ name: event.target.value })}
          placeholder="Redis Cache"
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

      <div className="space-y-2 rounded-sm border border-border bg-muted/10 px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <label className="block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              Connection mode
            </label>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Standalone, cluster, and sentinel are all supported from this form.
            </p>
          </div>
          <div className="w-40">
            <Select value={form.mode} onValueChange={(value) => handleModeChange(value as ConnectionFormValues['mode'])}>
              <SelectTrigger className="font-mono text-xs">
                <SelectValue placeholder="Select mode" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="standalone">Standalone</SelectItem>
                <SelectItem value="cluster">Cluster</SelectItem>
                <SelectItem value="sentinel">Sentinel</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {showStandaloneAddress && (
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
        )}

        {form.mode === 'cluster' && (
          <div>
            <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              Cluster brokers
            </label>
            <Textarea
              value={form.clusterAddressesText}
              onChange={(event) => onChange({ clusterAddressesText: event.target.value })}
              placeholder={`redis-1:6379
redis-2:6379
redis-3:6379`}
              className="font-mono"
            />
            <p className="mt-1 text-[10px] text-muted-foreground">
              One broker address per line. Host and port are discovered from this list.
            </p>
          </div>
        )}

        {form.mode === 'sentinel' && (
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                Master name
              </label>
              <Input
                value={form.sentinelMasterName}
                onChange={(event) => onChange({ sentinelMasterName: event.target.value })}
                placeholder="mymaster"
                className="font-mono"
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                Sentinel addresses
              </label>
              <Textarea
                value={form.sentinelAddressesText}
                onChange={(event) => onChange({ sentinelAddressesText: event.target.value })}
                placeholder={`sentinel-1:26379
sentinel-2:26379`}
                className="font-mono"
              />
              <p className="mt-1 text-[10px] text-muted-foreground">
                One sentinel address per line.
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Username
          </label>
          <Input
            value={form.username}
            onChange={(event) => onChange({ username: event.target.value })}
            placeholder="optional"
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

      <div className="space-y-3 rounded-sm border border-border bg-muted/10 px-3 py-3">
        <button
          type="button"
          onClick={() => setAdvancedOpen((current) => !current)}
          className="flex w-full items-center justify-between text-left"
        >
          <div>
            <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              Advanced settings
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Database, separator, and transport toggles live here.
            </p>
          </div>
          <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', advancedOpen && 'rotate-180')} />
        </button>

        {advancedOpen && (
          <div className="space-y-3 pt-1">
            {form.mode === 'standalone' && (
              <div>
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                  Database
                </label>
                <Input
                  type="number"
                  min="0"
                  max="15"
                  value={form.database}
                  onChange={(event) => onChange({ database: event.target.value })}
                  placeholder="0"
                  className="font-mono"
                />
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Used by standalone Redis connections only.
                </p>
              </div>
            )}

            <div>
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                Separator
              </label>
              <Input
                value={form.separator}
                onChange={(event) => onChange({ separator: event.target.value || ':' })}
                placeholder=":"
                className="font-mono"
              />
            </div>

            <div className="flex items-center justify-between rounded-sm border border-border bg-background px-3 py-2.5">
              <div>
                <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">TLS</div>
                <p className="mt-1 text-[11px] text-muted-foreground">Enable encrypted transport when required.</p>
              </div>
              <Switch checked={form.tlsEnabled} onCheckedChange={(checked) => onChange({ tlsEnabled: checked })} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
