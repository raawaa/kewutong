import { useEffect, useMemo, useState } from "react";
import { Pencil, ShieldAlert } from "lucide-react";
import {
  clearHolidayOverride,
  holidayCalendar,
  setHolidayOverride,
  toAppError,
  type AppError,
  type HolidayCalendarDay,
} from "@/lib/api";
import type { DayKind } from "@/main/holiday/index";
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
 * 「节假日日历」视图（tickets #62 / #63）。
 *
 * 布局：
 * - 顶部说明 + 4 周窗口信息（Mon 起 → 27 天后周日,共 28 格）。
 * - 主体 4 行 × 7 列日历,周一..周日列头。
 * - 每格按 `cellStyleOf(kind, source)` 涂底；带 name 的格子在左上挂
 *   节日名 chip；source=override 的格子右上挂「app 内覆盖」小徽章。
 *
 * 覆盖菜单（ticket #63）：
 * - 点任意一格弹出小菜单,3 个动作：切换为节假日 / 切换为工作日 /
 *   清除覆盖。前两个永远可用；清除覆盖仅在该日已有 override 时启用。
 * - 动作成功后走本地 `localRevision` 触发整屏重拉,与 PersonnelMatrixView
 *   的 `localRevision` 节奏一致；不向父层冒泡 refreshToken。
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
  // 菜单锚点：当前打开菜单的那一格日期；null = 菜单关闭。
  const [menuDate, setMenuDate] = useState<string | null>(null);
  // 本地写入成功后 +1,触发重拉——与 PersonnelMatrixView 的 `localRevision`
  // 同节奏；不向父层冒泡 refreshToken。
  const [localRevision, setLocalRevision] = useState(0);

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
  }, [refreshToken, localRevision, now]);

  const grid = useMemo<HolidayGrid>(
    () => buildHolidayGrid({ today, calendarResponse }),
    [today, calendarResponse],
  );

  // 菜单 open 时挂全局点击外部 / Esc 监听——参考 TaskStatusMenu 模式。
  useEffect(() => {
    if (menuDate == null) return;
    function onDocClick(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      // 菜单 DOM（id 锚定）以外的点击都算"外部"。
      if (target?.closest('[data-holiday-menu="true"]')) return;
      setMenuDate(null);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuDate(null);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuDate]);

  // 父层 refreshToken +1 时,把可能已开着的菜单关掉——避免重拉后菜单锚
  // 到了一格已不再渲染的 DOM 上。
  useEffect(() => {
    setMenuDate(null);
  }, [refreshToken]);

  async function runAction(invoke: () => Promise<void>): Promise<void> {
    try {
      await invoke();
      setMenuDate(null);
      setError(null);
      setLocalRevision((value) => value + 1);
    } catch (thrown) {
      setError(toAppError(thrown));
    }
  }

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
          const open = menuDate === cell.date;
          return (
            <div key={cell.date} className="relative">
              <button
                role="gridcell"
                type="button"
                data-date={cell.date}
                data-source={cell.source}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={`${cell.date} ${cell.kind}${cell.name ? ` · ${cell.name}` : ""}${cell.source === "override" ? " · app 内覆盖" : ""}`}
                title={
                  cell.source === "override"
                    ? "app 内覆盖"
                    : cell.name ?? undefined
                }
                onClick={() => setMenuDate(open ? null : cell.date)}
                className={`relative flex aspect-square min-h-16 w-full flex-col items-stretch justify-between rounded-md border p-1.5 text-xs transition-colors hover:brightness-95 disabled:opacity-60 ${style.backgroundClass}`}
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

              {open && (
                <HolidayDayMenu
                  date={cell.date}
                  hasOverride={cell.source === "override"}
                  disabled={busy}
                  onSet={(kind: DayKind) =>
                    runAction(() =>
                      setHolidayOverride({ date: cell.date, kind }),
                    )
                  }
                  onClear={() =>
                    runAction(() =>
                      clearHolidayOverride({ date: cell.date }),
                    )
                  }
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 「点格子弹 3 项菜单」——覆盖菜单（ticket #63）。
 *
 * 故意抽成独立小组件,便于后续如要把同一菜单复用到"任务日历"等视图
 * 时按 `@/components/holiday/HolidayDayMenu` 提走。3 个动作 + 锚定弹
 * 层的定位 + 关闭由父视图通过 `data-holiday-menu` 标记外部点击拦截。
 */
function HolidayDayMenu({
  date,
  hasOverride,
  disabled,
  onSet,
  onClear,
}: {
  date: string;
  /** 该日是否已有 override——决定「清除覆盖」是否禁用。 */
  hasOverride: boolean;
  /** 父视图正在拉数据时按 true,所有动作禁用。 */
  disabled?: boolean;
  onSet: (kind: DayKind) => void;
  onClear: () => void;
}) {
  return (
    <div
      role="menu"
      aria-label={`修改 ${date} 的覆盖`}
      data-holiday-menu="true"
      className="bg-popover text-popover-foreground absolute left-0 top-full z-20 mt-1 w-44 rounded-md border p-1 shadow-md"
    >
      <button
        type="button"
        role="menuitem"
        disabled={disabled}
        onClick={() => onSet("holiday")}
        className="hover:bg-muted flex w-full cursor-pointer items-center rounded-sm px-2 py-1.5 text-left text-xs disabled:opacity-50"
      >
        切换为节假日
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={disabled}
        onClick={() => onSet("workday")}
        className="hover:bg-muted flex w-full cursor-pointer items-center rounded-sm px-2 py-1.5 text-left text-xs disabled:opacity-50"
      >
        切换为工作日
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={disabled || !hasOverride}
        onClick={onClear}
        className="hover:bg-muted flex w-full cursor-pointer items-center rounded-sm px-2 py-1.5 text-left text-xs disabled:cursor-not-allowed disabled:opacity-50"
      >
        清除覆盖
      </button>
    </div>
  );
}