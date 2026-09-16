/**
 * 「这是示例数据」横幅（ticket #31）。
 *
 * 由 [`App.tsx`] 在挂载时拉一次 `is_sample_data_present`——
 * 任何一张表还有 `is_sample = 1` 的行就展示。横幅明确标注示例数
 * 据,并给科长一键清除的入口。
 *
 * 设计要点:
 * - 不主动轮询——横幅是用户决策完就消失的东西,setState 重渲染即
 *   触发重新拉。命令层 (`clear_sample_data`) 返回清除计数,本组
 *   件在调用成功后立即 `onCleared` 回调,让上层决定如何刷新视图。
 * - 清除按钮带二次确认(`window.confirm`)——单座位 app,误点代价高,
 *   多一道保险。
 * - 数据文件位置显示在 banner 副行——不是 modal,不打扰主流程;
 *   科长要复制就复制,不需要就忽略。
 */
import { useEffect, useState } from "react";
import { TriangleAlert, X } from "lucide-react";
import {
  clearSampleData,
  dataFileLocation,
  isSampleDataPresent,
  toAppError,
  type AppError,
  type ClearSampleSummary,
} from "@/lib/ipc";
import { Button } from "@/components/ui/button";

export function SampleDataBanner({
  refreshToken,
  onCleared,
}: {
  /** 父层 `clearSampleData` 成功后 +1,触发重新拉取。 */
  refreshToken: number;
  /** 横幅清除成功时通知父层——views 按 refreshToken 拉数据,不回调则
   * 已删的示例任务在视图里继续残留。 */
  onCleared?: () => void;
}) {
  const [present, setPresent] = useState<boolean | null>(null);
  const [clearing, setClearing] = useState(false);
  const [lastSummary, setLastSummary] = useState<ClearSampleSummary | null>(
    null,
  );
  const [dbPath, setDbPath] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    Promise.all([isSampleDataPresent(), dataFileLocation()])
      .then(([presence, path]) => {
        if (cancelled) return;
        setPresent(presence.present);
        setDbPath(path);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(toAppError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  if (present !== true && !error) {
    return null;
  }

  const handleClear = async () => {
    if (
      !window.confirm(
        "确认清除全部示例数据？清除后不可恢复，但您录入的真实数据不受影响。",
      )
    ) {
      return;
    }
    setClearing(true);
    setError(null);
    try {
      const summary = await clearSampleData();
      setLastSummary(summary);
      setPresent(false);
      onCleared?.();
    } catch (err: unknown) {
      setError(toAppError(err));
    } finally {
      setClearing(false);
    }
  };

  return (
    <div
      role="status"
      className="mx-4 mt-3 flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
      data-testid="sample-data-banner"
    >
      <TriangleAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
      <div className="flex-1 text-sm">
        <div className="font-medium">这是示例数据</div>
        <div className="mt-1 text-amber-800/90 dark:text-amber-200/80">
          科长首次打开 app 时由系统预置,用来演示各个视图的形态。点
          「清除示例」后会留下真实的人员骨架与您录入的全部数据。
        </div>
        {dbPath ? (
          <div
            className="mt-2 font-mono text-xs text-amber-800/80 dark:text-amber-200/70"
            data-testid="db-path-line"
          >
            数据文件:{dbPath}
          </div>
        ) : null}
        {lastSummary ? (
          <div className="mt-1 text-xs text-emerald-700 dark:text-emerald-300">
            已清除示例:子组 {lastSummary.subTeams}、人员
            {" "}{lastSummary.people}、项目 {lastSummary.projects}、任务
            {" "}{lastSummary.tasks}、模板
            {" "}{lastSummary.recurringTemplates}。
          </div>
        ) : null}
        {error ? (
          <div className="mt-1 text-xs text-red-700 dark:text-red-300">
            {error.message}
          </div>
        ) : null}
      </div>
      <Button
        variant="destructive"
        size="sm"
        disabled={clearing}
        onClick={() => {
          void handleClear();
        }}
        data-testid="clear-sample-data"
      >
        <X aria-hidden />
        {clearing ? "清除中…" : "清除示例"}
      </Button>
    </div>
  );
}