import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  TaskDialog,
  type TaskDialogTarget,
} from "@/components/task/TaskDialog";
import { PersonnelView } from "@/views/PersonnelView";
import { TasksView } from "@/views/TasksView";

type Tab = "tasks" | "personnel";

const TABS: { id: Tab; label: string }[] = [
  { id: "tasks", label: "任务" },
  { id: "personnel", label: "人员" },
];

/**
 * App 外壳。
 *
 * 新建任务的入口挂在这里而不是某个视图里——顶栏按钮与 ⌘N 得**在任意界面**
 * 都能唤起弹窗（ticket #19 验收点）。视图只管自己那摊数据。
 */
export default function App() {
  const [tab, setTab] = useState<Tab>("tasks");
  const [dialog, setDialog] = useState<TaskDialogTarget | null>(null);
  // 弹窗保存后 +1，让任务列表重新拉一次
  const [refreshToken, setRefreshToken] = useState(0);

  const openCreate = useCallback(() => setDialog({ mode: "create" }), []);
  const closeDialog = useCallback(() => setDialog(null), []);
  const onTaskSaved = useCallback(() => {
    setDialog(null);
    setRefreshToken((token) => token + 1);
  }, []);

  // ⌘N / Ctrl+N：全局快捷键，和顶栏按钮走同一条路。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        openCreate();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openCreate]);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-6">
          <h1 className="text-xl font-semibold">科室任务管理</h1>
          <nav className="flex gap-1">
            {TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-current={tab === entry.id ? "page" : undefined}
                onClick={() => setTab(entry.id)}
                className={`cursor-pointer rounded-md px-3 py-1.5 text-sm ${
                  tab === entry.id
                    ? "bg-muted font-medium"
                    : "text-muted-foreground hover:bg-muted/60"
                }`}
              >
                {entry.label}
              </button>
            ))}
          </nav>
        </div>
        <Button size="sm" onClick={openCreate}>
          <Plus />
          新建任务
          <kbd className="ml-1 text-xs opacity-70">⌘N</kbd>
        </Button>
      </header>

      {tab === "tasks" ? (
        <TasksView
          refreshToken={refreshToken}
          onOpenTask={(task, assignee) =>
            setDialog({ mode: "edit", task, assignee })
          }
        />
      ) : (
        <PersonnelView />
      )}

      {dialog && (
        <TaskDialog
          // 换任务 = 换一个弹窗实例，contenteditable 的初值才铺得干净
          key={dialog.mode === "edit" ? `edit-${dialog.task.id}` : "create"}
          target={dialog}
          onClose={closeDialog}
          onSaved={onTaskSaved}
        />
      )}
    </main>
  );
}
