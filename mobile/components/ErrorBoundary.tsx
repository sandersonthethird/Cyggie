import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Generic class-based error boundary. Catches render exceptions in the
 * subtree, logs them, and renders the caller-provided fallback.
 *
 * Ported from the desktop's [ErrorBoundary](../../src/renderer/components/common/ErrorBoundary.tsx)
 * with no behavioral changes — JSX is RN-compatible because we leave
 * rendering to the caller's fallback function. Item 2 uses this to wrap
 * the SummarySection so a malformed markdown payload from
 * react-native-markdown-display can't white-screen the meeting detail.
 */

interface Props {
  /**
   * `reset` clears the error state so children remount fresh. Useful for
   * scoped boundaries with a "Retry" affordance.
   */
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
