import { Component, ErrorInfo, ReactNode } from "react";

type RuntimeErrorBoundaryProps = { children: ReactNode };
type RuntimeErrorBoundaryState = { error: Error | null };

/** Keeps a single broken view from turning the packaged desktop window blank. */
export class RuntimeErrorBoundary extends Component<RuntimeErrorBoundaryProps, RuntimeErrorBoundaryState> {
  state: RuntimeErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): RuntimeErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Maestro UI render error", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="runtime-fatal" role="alert">
        <div className="runtime-fatal-card">
          <div className="eyebrow">Maestro runtime</div>
          <h1>Esta tela encontrou um erro</h1>
          <p>O serviço continua protegido. Recarregue a interface para buscar um estado novo.</p>
          <button type="button" className="btn-new" onClick={() => window.location.reload()}>
            Recarregar interface
          </button>
        </div>
      </main>
    );
  }
}
