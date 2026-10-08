import { useEffect, useMemo, useState } from "react";
import { Pencil, ShieldAlert } from "lucide-react";
import {
  holidayCalendar,
  toAppError,
  type AppError,
  type HolidayCalendarDay,
} from "@/lib/api";
import {
  CELLS_PER_WINDOW,
  WEEKDAY_HEADERS,
  buildHolidayGrid,
  cellStyleOf,
  formatLocalDateIso,
  mondayOf,
  type HolidayGrid,
} from "./holidayCalendarGrid";

/**
 * 「节假日日历」视图（ticket #62,只读视图）。
 *
 * 布局：
 * - 顶部说明 + 4 周窗口信息（Mon 起 → 27 天后周日,共 28 格）。
 * - 主体 4 行 × 7 列日历,周一..周日列头。
 * - 每格按 `cellStyleOf(kind, source)` 涂底；带 name 的格子在左上挂
 *   节日名 chip；source=override 的格子右上挂「app 内覆盖」小徽章。
 *
 * 设计要点：
 * - **4 周窗口固定**——当前周 Monday 起 + 27 天（设计决策 §1）。跨年
 *   时 IPC 一次性拉闭区间 [Mon, Mon+27],主进程按文件名年份截断后
 *   合并返回。
 * - **周末默认**在客户端填底：IPC 只返 Seed / Override 行,缺失格按
 *   Sat/Sun = holiday / weekday = workday、source = default（设计决
 *   策 §2）。
 * - **不挂"调休"chip**（设计决策 §3）——seed workday 走 workday 同色,
 *   仅靠 name chip 区分（name = "国庆调休" 等）。
 * - **只读**（设计决策 §4）——点击目前什么都不做；issue #63 会接弹
 *   菜单做 override。
 */
export function HolidayCalendarView({
  refreshToken,
  now,
}: {
  /** 父层保存任务 / 切换 tab 后 +1,触发重新拉取。 */
  refreshToken: number;
  /** 测试用——生产环境不传,组件内自己 `new Date()`。 */
  now?: Date;
}) {
  const [calendarResponse, setCalendarResponse] = useState<HolidayCalendarDay[]>(
    [],
  );
  const [today, setToday] = useState<Date>(() => now ?? new Date());
  const [error, setError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // 一次渲染里固定 today——避免时钟漂移导致窗口滑动。
    const current = now ?? new Date();
    setToday(current);
    const start = mondayOf(current);
    const end = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate() + CELLS_PER_WINDOW - 1,
    );
    setBusy(true);
    holidayCalendar({
      startInclusive: formatLocalDateIso(start),
      endInclusive: formatLocalDateIso(end),
    })
      .then((rows) => {
        if (cancelled) return;
        setCalendarResponse(rows);
        setError(null);
      })
      .catch((thrown) => {
        if (!cancelled) setError(toAppError(thrown));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken, now]);

  const grid = useMemo<HolidayGrid>(
    () => buildHolidayGrid({ today, calendarResponse }),
    [today, calendarResponse],
  );

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          节假日日历 · 当前周起 4 周窗口（28 格,周一..周日）
        </p>
        <span className="text-muted-foreground text-xs tabular-nums">
          {grid[0]?.[0]?.date} ~ {grid[3]?.[6]?.date}
        </span>
      </header>

      {error && (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm"
        >
          {error.message}
        </div>
      )}

      <div
        role="grid"
        aria-label="节假日日历（4 周窗口,周一..周日）"
        className="grid grid-cols-7 gap-1"
      >
        {WEEKDAY_HEADERS.map((name) => (
          <div
            key={name}
            role="columnheader"
            className="text-muted-foreground px-1 py-0.5 text-center text-[11px] font-medium"
          >
            {name}
          </div>
        ))}
        {grid.flat().map((cell) => {
          const style = cellStyleOf(cell.kind, cell.source);
          return (
            <button
              key={cell.date}
              role="gridcell"
              type="button"
              data-date={cell.date}
              data-source={cell.source}
              aria-label={`${cell.date} ${cell.kind}${cell.name ? ` · ${cell.name}` : ""}${cell.source === "override" ? " · app 内覆盖" : ""}`}
              title={
                cell.source === "override"
                  ? "app 内覆盖 — 后续 ticket #63 会加菜单"
                  : cell.name ?? undefined
              }
              className={`relative flex aspect-square min-h-16 flex-col items-stretch justify-between rounded-md border p-1.5 text-xs transition-colors hover:brightness-95 disabled:opacity-60 ${style.backgroundClass}`}
              disabled={busy}
            >
              <span className="flex items-start justify-between gap-1">
                {cell.name && style.showNameChip ? (
                  <span className="bg-background/70 truncate rounded px-1 py-0.5 text-[10px] leading-none">
                    {cell.name}
                  </span>
                ) : (
                  <span />
                )}
                {style.showOverrideBadge && (
                  <span
                    className="bg-background/80 text-foreground shrink-0 rounded px-1 py-0.5 text-[10px] leading-none font-medium"
                    title="app 内覆盖"
                  >
                    <ShieldAlert className="mr-0.5 inline size-2.5" />
                    覆盖
                  </span>
                )}
              </span>
              <span className="flex items-end justify-between">
                <span className="text-base font-semibold tabular-nums">
                  {cell.dayOfMonth}
                </span>
                {cell.source === "override" && (
                  <Pencil
                    className="text-foreground/70 size-3"
                    aria-hidden="true"
                  />
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}