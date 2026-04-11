import { ArrowLeft, Monitor, Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const THEMES = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
] as const

export default function SettingsPage() {
  const navigate = useNavigate()
  const { theme, setTheme } = useTheme()

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

        <div className="mt-4 rounded-sm border border-border bg-card p-6">
          <p className="text-sm font-semibold text-foreground">Version</p>
          <p className="mt-2 font-mono text-xs text-muted-foreground">InfraView v0.3.0</p>
        </div>
      </main>
    </div>
  )
}
