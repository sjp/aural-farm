import { Component, type ComponentChildren, type JSX } from "preact";

interface Props {
  children: ComponentChildren;
}

/** Catches a crash in the control panel and offers a reload instead of a blank page. */
export class PanelErrorBoundary extends Component<Props, { crashed: boolean }> {
  override state = { crashed: false };

  static override getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true };
  }

  override componentDidCatch(error: unknown): void {
    console.error("The control panel crashed:", error);
  }

  override render(): JSX.Element | ComponentChildren {
    if (!this.state.crashed) {
      return this.props.children;
    }
    return (
      <div className="panel panel-crashed" role="alert">
        <p className="sound-error">The controls crashed.</p>
        <button
          type="button"
          className="primary"
          onClick={() => {
            window.location.reload();
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}
