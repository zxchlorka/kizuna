import { useEffect, useState } from 'react'
import { ArrowLeft, Monitor, Moon, Pencil, Sun, Trash2 } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useNavigate } from 'react-router-dom'
import { CreateLinkDialog } from '@/components/links/CreateLinkDialog'
import { Button } from '@/components/ui/button'
import { linkSummary } from '@/lib/links'
import { cn } from '@/lib/utils'
import { useConnectionStore } from '@/stores/connections'
import { useLinksStore } from '@/stores/links'
import { useToastStore } from '@/stores/toast'
import type { LinkRecord } from '@/types/api'

const THEMES = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
] as const

export default function SettingsPage() {
  const navigate = useNavigate()
  const { theme, setTheme } = useTheme()
  const links = useLinksStore((state) => state.links)
  const fetchLinks = useLinksStore((state) => state.fetch)
  const removeLink = useLinksStore((state) => state.remove)
  const fetchConnections = useConnectionStore((state) => state.fetch)
  const pushToast = useToastStore((state) => state.push)
  const [editing, setEditing] = useState<LinkRecord | null>(null)

  useEffect(() => {
    void fetchLinks().catch(() => undefined)
    void fetchConnections().catch(() => undefined)
  }, [fetchLinks, fetchConnections])

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 border-b border-border/60 bg-background/90 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-4xl items-center justify-between px-6">
          <div>
            <p className="text-sm font-semibold text-foreground">Settings</p>
            <p className="text-xs text-muted-foreground">Application preferences</p>
          </div>
          <Button variant="outline" size="sm" className="h-8 gap-1.5 font-mono text-xs" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-3.5 w-3.5" />
            Back
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-10">
        <div className="rounded-sm border border-border bg-card p-6">
          <div className="mb-5">
            <p className="text-sm font-semibold text-foreground">Theme</p>
            <p className="mt-1 text-xs text-muted-foreground">Switch between light, dark, and system appearance.</p>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {THEMES.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => setTheme(value)}
                className={cn(
                  'flex items-center gap-3 rounded-sm border px-4 py-4 text-left transition-colors',
                  theme === value
                    ? 'border-amber-500/50 bg-amber-500/10 text-foreground'
                    : 'border-border bg-background hover:border-amber-500/30 hover:bg-amber-500/5'
                )}
              >
                <div className="flex h-9 w-9 items-center justify-center rounded-sm border border-border bg-muted/20">
                  <Icon className="h-4 w-4 text-accent-amber" />
                </div>
                <div>
                  <p className="font-mono text-sm">{label}</p>
                  <p className="text-xs text-muted-foreground">{value === 'system' ? 'Follow OS setting' : `${label} mode only`}</p>
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="mt-6 rounded-sm border border-border bg-card p-6">
          <div className="mb-5">
            <p className="text-sm font-semibold text-foreground">Cross-source links</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Right-click a Kafka message to open a linked Redis key or Postgres row. Create links from the message
              menu; remove them here.
            </p>
          </div>
          {links.length === 0 ? (
            <p className="font-mono text-xs text-muted-foreground">No links yet.</p>
          ) : (
            <div className="space-y-2">
              {links.map((link) => (
                <div
                  key={link.id}
                  className="flex items-center justify-between gap-3 rounded-sm border border-border bg-background px-3 py-2"
                >
                  <div className="min-w-0 truncate font-mono text-xs text-foreground">{linkSummary(link)}</div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => setEditing(link)}
                      aria-label="Edit link"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() =>
                        void removeLink(link.id).catch((error) =>
                          pushToast({ tone: 'error', title: 'Delete failed', message: (error as Error).message })
                        )
                      }
                      aria-label="Delete link"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <CreateLinkDialog
            open={editing !== null}
            editLink={editing ?? undefined}
            onOpenChange={(next) => {
              if (!next) setEditing(null)
            }}
          />
        </div>

        <div className="mt-4 rounded-sm border border-border bg-card p-6">
          <p className="text-sm font-semibold text-foreground">Version</p>
          <p className="mt-2 font-mono text-xs text-muted-foreground">Kizuna v0.4.0</p>
        </div>
      </main>
    </div>
  )
}
