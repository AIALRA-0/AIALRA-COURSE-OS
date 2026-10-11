import { Component, type ReactNode } from "react";

type WorkspaceLoadBoundaryProps = { children: ReactNode; onReturnToLearning?: () => void };
type WorkspaceLoadBoundaryState = { failed: boolean };

export class WorkspaceLoadBoundary extends Component<WorkspaceLoadBoundaryProps, WorkspaceLoadBoundaryState> {
  state: WorkspaceLoadBoundaryState = { failed: false };

  static getDerivedStateFromError(): WorkspaceLoadBoundaryState {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="workspace-loader" role="alert">
      <strong>当前工作区载入失败</strong>
      <span>可能是网络中断、登录过期或页面组件异常；请刷新本页，如果出现登录入口，请正常登录后继续</span>
      <button type="button" className="quiet-button" onClick={() => window.location.reload()}>刷新本页</button>
      {this.props.onReturnToLearning && <button type="button" className="quiet-button" onClick={this.props.onReturnToLearning}>返回学习</button>}
    </div>;
  }
}
