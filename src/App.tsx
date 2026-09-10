import { useState } from "react";
import { Activity } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ping, toAppError, type AppError, type PingReply } from "@/lib/ipc";

/**
 * v1 脚手架窗口：业务视图（今日 / 本周、人员矩阵、项目看板）由后续票落地，
 * 这里只留一个自检入口，确认前端 ↔ 命令层 ↔ SQLite 这条链路是通的。
 */
export default function App() {
  const [reply, setReply] = useState<PingReply | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [checking, setChecking] = useState(false);

  async function selfCheck() {
    setChecking(true);
    try {
      setReply(await ping());
      setError(null);
    } catch (thrown) {
      setReply(null);
      setError(toAppError(thrown));
    } finally {
      setChecking(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-10">
      <div className="space-y-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">科室任务管理</h1>
        <p className="text-muted-foreground text-sm">
          v1 脚手架。业务视图将逐票落地。
        </p>
      </div>

      <Button onClick={selfCheck} disabled={checking}>
        <Activity />
        {checking ? "自检中…" : "自检"}
      </Button>

      {reply && (
        <p className="text-muted-foreground text-sm">
          命令层已就绪（{reply.message}）· 服务端时间 {reply.now} · 数据库版本{" "}
          {reply.schemaVersion ?? "空库"}
        </p>
      )}
      {error && <p className="text-destructive text-sm">{error.message}</p>}
    </main>
  );
}
