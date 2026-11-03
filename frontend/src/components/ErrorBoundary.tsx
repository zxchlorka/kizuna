import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, ArrowLeft, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface ErrorBoundaryProps {
  // A new key (the route changed) clears the error, so leaving the broken
  // screen is enough to recover from it.
  resetKey: string
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

// Without this, any error thrown while rendering unmounted the whole app and
// left an empty page with no way out but a manual reload.
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('render failed', error, info.componentStack)
  }

  componentDidUpdate(prev: ErrorBoundaryProps) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div role="alert" className="w-full max-w-lg rounded-sm border border-destructive/40 bg-card p-6">
          <div className="flex items-center gap-2 text-sm font-medium text-destructive">
            <AlertTriangle className="h-4 w-4" />
            This screen failed to render
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            Your connections and saved data are untouched. Go back to the connection list, or reload to try this screen again.
          </p>
          <pre className="mt-4 max-h-40 overflow-auto whitespace-pre-wrap rounded-sm border border-border bg-muted/30 p-3 font-mono text-[11px] text-muted-foreground">
            {error.message}
          </pre>
          <div className="mt-5 flex gap-2">
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => window.location.assign('/')}>
              <ArrowLeft className="h-3.5 w-3.5" />
              Connection list
            </Button>
            <Button size="sm" className="gap-1.5" onClick={() => window.location.reload()}>
              <RefreshCw className="h-3.5 w-3.5" />
              Reload
            </Button>
          </div>
        </div>
      </div>
    )
  }
}
