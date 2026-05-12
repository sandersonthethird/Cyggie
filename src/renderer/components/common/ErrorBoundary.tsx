import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Generic class-based error boundary. Catches render exceptions in the
 * subtree, logs them, and renders the caller-provided fallback.
 *
 * Used at the App root (catches every render error so the whole app
 * doesn't white-screen) and inside NoteDetail (route-scoped fallback).
 */

interface Props {
  /** `reset` clears the error state so children remount fresh. Useful for
   *  route-scoped boundaries with a "Retry" button. The App-root boundary
   *  typically ignores it and uses window.location.reload() instead. */
  fallback: (error: Error, reset: () => void) => ReactNode
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  reset = () => this.setState({ error: null })

  render() {
    if (this.state.error) return this.props.fallback(this.state.error, this.reset)
    return this.props.children
  }
}
