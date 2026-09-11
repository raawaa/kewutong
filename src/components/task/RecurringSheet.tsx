import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  byday,
  toAppError,
  type AppError,
  type RecurringEnds,
  type RecurringFreq,
  type RecurringHolidayBehavior,
  type StructuredRule,
} from "@/lib/ipc";

/**
 * 侧抽屉：周期性规则编辑器（ticket #24，决策变体 A「频率向导」）。
 *
 * 5 节固定顺序：① 频率 → ② 哪几天 / 哪几天 / 哪些月（按 freq 切换）→
 * ③ 时间 → ④ 终止条件 → ⑤ 节假日。**科长永远不读写 RRULE 字符串**。
 *
 * 父组件传入 `initialRule`（新建时为默认值，编辑时为已存规则），
 * `onConfirm` 收走 `StructuredRule`；`onCancel` 退出不保存。
 */
export function RecurringSheet({
  initialRule,
  templateName,
  onConfirm,
  onCancel,
}: {
  initialRule: StructuredRule;
  templateName: string;
  onConfirm: (rule: StructuredRule) => void;
  onCancel: () => void;
}) {
  const [rule, setRule] = useState<StructuredRule>(initialRule);
  const [error, setError] = useState<AppError | null>(null);

  // Esc 关抽屉——和 TaskDialog 一样,内部优先吞
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  const preview = useMemo(() => buildPreviewLine(rule), [rule]);

  return (
    <div
      className="fixed inset-0 z-60 flex justify-end bg-black/30"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="配置周期性规则"
        className="bg-background flex w-full max-w-[480px] flex-col border-l shadow-lg"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b px-4 py-3">
          <h3 className="text-sm font-semibold">
            配置周期性规则
            {templateName ? (
              <span className="text-muted-foreground ml-2 font-normal">
                · {templateName}
              </span>
            ) : null}
          </h3>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onCancel}
            aria-label="关闭"
          >
            ×
          </Button>
        </header>

        <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-4 py-4 text-sm">
          {/* ① 频率 */}
          <section>
            <SectionTitle>① 频率</SectionTitle>
            <div className="grid grid-cols-4 gap-1.5">
              {(
                [
                  { id: "daily", label: "每天", icon: "📅" },
                  { id: "weekly", label: "每周", icon: "🗓️" },
                  { id: "monthly", label: "每月", icon: "📆" },
                  { id: "yearly", label: "每年", icon: "🎂" },
                ] as { id: RecurringFreq; label: string; icon: string }[]
              ).map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  data-checked={rule.freq === entry.id}
                  onClick={() => setRule((prev) => switchFreq(prev, entry.id))}
                  className="flex flex-col items-center justify-center gap-0.5 rounded-md border py-2.5 text-xs font-medium hover:bg-muted data-[checked=true]:border-primary data-[checked=true]:bg-muted"
                >
                  <span className="text-base leading-none">{entry.icon}</span>
                  <span>{entry.label}</span>
                </button>
              ))}
            </div>
          </section>

          {/* ② 子句 */}
          {rule.freq === "weekly" && (
            <section>
              <SectionTitle>② 哪几天</SectionTitle>
              <DayChips
                mask={rule.bydayMask}
                onChange={(mask) =>
                  setRule((prev) => ({ ...prev, bydayMask: mask }))
                }
              />
            </section>
          )}
          {rule.freq === "monthly" && (
            <section>
              <SectionTitle>② 哪几天</SectionTitle>
              <MonthdayInput
                value={rule.bymonthday ?? []}
                onChange={(days) =>
                  setRule((prev) => ({ ...prev, bymonthday: days }))
                }
              />
            </section>
          )}
          {rule.freq === "yearly" && (
            <section>
              <SectionTitle>② 哪些月</SectionTitle>
              <MonthChips
                value={rule.bymonth ?? []}
                onChange={(months) =>
                  setRule((prev) => ({ ...prev, bymonth: months }))
                }
              />
              <div className="mt-3">
                <SectionTitle small>哪一天（可选,默认 1 号）</SectionTitle>
                <MonthdayInput
                  value={rule.bymonthday ?? []}
                  onChange={(days) =>
                    setRule((prev) => ({ ...prev, bymonthday: days }))
                  }
                  allowZero={false}
                />
              </div>
            </section>
          )}

          {/* ③ 时间 */}
          <section>
            <SectionTitle>③ 时间</SectionTitle>
            <input
              type="time"
              aria-label="小时:分钟"
              value={timeString(rule.byhour, rule.byminute)}
              onChange={(event) => {
                const [h, m] = parseTime(event.target.value);
                setRule((prev) => ({ ...prev, byhour: h, byminute: m }));
              }}
              className="border-input bg-background rounded-md border px-2.5 py-1.5 text-sm"
            />
          </section>

          {/* ④ 终止条件 */}
          <section>
            <SectionTitle>④ 终止</SectionTitle>
            <EndsEditor
              value={rule.ends}
              onChange={(ends) => setRule((prev) => ({ ...prev, ends }))}
            />
          </section>

          {/* ⑤ 节假日 */}
          <section>
            <SectionTitle>⑤ 节假日</SectionTitle>
            <div className="flex flex-col gap-1.5 text-sm">
              {(
                [
                  { id: "skip", label: "跳过（默认）" },
                  { id: "shift", label: "顺延到下一个工作日" },
                ] as { id: RecurringHolidayBehavior; label: string }[]
              ).map((entry) => (
                <label
                  key={entry.id}
                  className="flex cursor-pointer items-center gap-2"
                >
                  <input
                    type="radio"
                    name="recurring-holiday"
                    checked={rule.holidayBehavior === entry.id}
                    onChange={() =>
                      setRule((prev) => ({
                        ...prev,
                        holidayBehavior: entry.id,
                      }))
                    }
                  />
                  <span>{entry.label}</span>
                </label>
              ))}
            </div>
          </section>

          <div className="bg-muted rounded-md border border-dashed px-3 py-2 text-sm">
            <div className="font-semibold">{preview.summary}</div>
            <div className="text-muted-foreground mt-1 text-xs leading-relaxed">
              {preview.meta}
            </div>
          </div>

          {error && (
            <p
              role="alert"
              className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm"
            >
              {error.message}
            </p>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t px-4 py-3">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button
            size="sm"
            onClick={async () => {
              try {
                // 客户端轻校验——服务层会再校验一遍,这里给提示。
                validateClient(rule);
                onConfirm(rule);
              } catch (thrown) {
                setError(toAppError(thrown));
              }
            }}
          >
            确认 →
          </Button>
        </footer>
      </aside>
    </div>
  );
}

function SectionTitle({
  children,
  small = false,
}: {
  children: React.ReactNode;
  small?: boolean;
}) {
  return (
    <h4
      className={`mb-2 font-semibold ${
        small ? "text-muted-foreground text-xs" : "text-sm"
      }`}
    >
      {children}
    </h4>
  );
}

function DayChips({
  mask,
  onChange,
}: {
  mask: number;
  onChange: (next: number) => void;
}) {
  const entries: { id: number; label: string }[] = [
    { id: byday.MO, label: "一" },
    { id: byday.TU, label: "二" },
    { id: byday.WE, label: "三" },
    { id: byday.TH, label: "四" },
    { id: byday.FR, label: "五" },
    { id: byday.SA, label: "六" },
    { id: byday.SU, label: "日" },
  ];
  return (
    <div className="flex gap-1.5">
      {entries.map((entry) => {
        const checked = (mask & entry.id) !== 0;
        return (
          <button
            key={entry.id}
            type="button"
            data-checked={checked}
            onClick={() => onChange(mask ^ entry.id)}
            className="border-input flex size-8 items-center justify-center rounded-md border text-xs hover:bg-muted data-[checked=true]:bg-primary data-[checked=true]:text-primary-foreground"
            aria-pressed={checked}
          >
            {entry.label}
          </button>
        );
      })}
    </div>
  );
}

function MonthChips({
  value,
  onChange,
}: {
  value: number[];
  onChange: (next: number[]) => void;
}) {
  const labels = [
    "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12",
  ];
  return (
    <div className="grid grid-cols-6 gap-1.5">
      {labels.map((label, idx) => {
        const month = idx + 1;
        const checked = value.includes(month);
        return (
          <button
            key={month}
            type="button"
            data-checked={checked}
            onClick={() =>
              onChange(
                checked
                  ? value.filter((m) => m !== month)
                  : [...value, month].sort((a, b) => a - b),
              )
            }
            className="border-input rounded-md border py-1.5 text-xs hover:bg-muted data-[checked=true]:bg-primary data-[checked=true]:text-primary-foreground"
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function MonthdayInput({
  value,
  onChange,
  allowZero = true,
}: {
  value: number[];
  onChange: (next: number[]) => void;
  allowZero?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {value.length === 0 ? (
          <span className="text-muted-foreground text-xs">还没选日子</span>
        ) : (
          value.map((day) => (
            <span
              key={day}
              className="bg-muted inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs"
            >
              {day === 0 ? "月末" : `${day} 号`}
              <button
                type="button"
                aria-label={`移除 ${day === 0 ? "月末" : day + "号"}`}
                onClick={() => onChange(value.filter((d) => d !== day))}
                className="text-muted-foreground hover:text-foreground"
              >
                ×
              </button>
            </span>
          ))
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          min={1}
          max={31}
          placeholder="1-31"
          aria-label="添加日期"
          className="border-input bg-background w-24 rounded-md border px-2 py-1 text-sm"
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            const input = event.currentTarget;
            const num = Number(input.value);
            input.value = "";
            if (!Number.isInteger(num) || num < 1 || num > 31) return;
            if (value.includes(num)) return;
            onChange([...value, num].sort((a, b) => a - b));
          }}
        />
        {allowZero && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (value.includes(0)) return;
              onChange([0]);
            }}
          >
            每月末
          </Button>
        )}
      </div>
    </div>
  );
}

function EndsEditor({
  value,
  onChange,
}: {
  value: RecurringEnds;
  onChange: (next: RecurringEnds) => void;
}) {
  const kind = value.kind;
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <label className="flex items-center gap-2">
        <input
          type="radio"
          name="recurring-ends"
          checked={kind === "on"}
          onChange={() => onChange({ kind: "on", date: defaultEndsDate() })}
        />
        <span>持续到</span>
        {kind === "on" ? (
          <input
            type="date"
            aria-label="终止日"
            value={value.date}
            onChange={(event) =>
              onChange({ kind: "on", date: event.target.value })
            }
            className="border-input bg-background w-40 rounded-md border px-2 py-1 text-sm"
          />
        ) : (
          <input
            type="date"
            aria-label="终止日"
            value={defaultEndsDate()}
            disabled
            className="border-input bg-background w-40 rounded-md border px-2 py-1 text-sm opacity-60"
          />
        )}
      </label>
      <label className="flex items-center gap-2">
        <input
          type="radio"
          name="recurring-ends"
          checked={kind === "after"}
          onChange={() => onChange({ kind: "after", n: 12 })}
        />
        <span>共出现</span>
        {kind === "after" ? (
          <input
            type="number"
            min={1}
            aria-label="出现次数"
            value={value.n}
            onChange={(event) =>
              onChange({
                kind: "after",
                n: Math.max(1, Number(event.target.value) || 1),
              })
            }
            className="border-input bg-background w-20 rounded-md border px-2 py-1 text-sm"
          />
        ) : (
          <input
            type="number"
            min={1}
            aria-label="出现次数"
            value={12}
            disabled
            className="border-input bg-background w-20 rounded-md border px-2 py-1 text-sm opacity-60"
          />
        )}
        <span>次</span>
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function switchFreq(prev: StructuredRule, freq: RecurringFreq): StructuredRule {
  // 切频率时,把"对不上 freq"的子句重置——保证向导步骤都对得上当前 freq。
  switch (freq) {
    case "daily":
      return { ...prev, freq, bydayMask: 0, bymonthday: null, bymonth: null };
    case "weekly":
      return { ...prev, freq, bymonthday: null, bymonth: null };
    case "monthly":
      return { ...prev, freq, bydayMask: 0, bymonth: null };
    case "yearly":
      return {
        ...prev,
        freq,
        bydayMask: 0,
        bymonthday: prev.bymonthday && prev.bymonthday.length > 0 ? prev.bymonthday : [1],
        bymonth: prev.bymonth && prev.bymonth.length > 0 ? prev.bymonth : [1],
      };
  }
}

function buildPreviewLine(rule: StructuredRule): {
  summary: string;
  meta: string;
} {
  const time = `${pad2(rule.byhour)}:${pad2(rule.byminute)}`;
  let summary: string;
  switch (rule.freq) {
    case "daily":
      summary = `每天 ${time}`;
      break;
    case "weekly":
      summary = `每周${formatDays(rule.bydayMask)} ${time}`;
      break;
    case "monthly":
      summary = `每月${formatMonthdays(rule.bymonthday ?? [])} ${time}`;
      break;
    case "yearly":
      summary = `每年 ${formatMonths(rule.bymonth ?? [])} ${formatMonthdays(
        rule.bymonthday ?? [],
      )} ${time}`;
      break;
  }
  const ends =
    rule.ends.kind === "on"
      ? `持续到 ${rule.ends.date}`
      : `共出现 ${rule.ends.n} 次`;
  const holiday =
    rule.holidayBehavior === "skip" ? "节假日跳过" : "节假日顺延";
  return {
    summary,
    meta: `${ends} · 时区 ${rule.ianaZone} · ${holiday}`,
  };
}

function formatDays(mask: number): string {
  const labels = ["一", "二", "三", "四", "五", "六", "日"];
  const bits = [byday.MO, byday.TU, byday.WE, byday.TH, byday.FR, byday.SA, byday.SU];
  const out: string[] = [];
  for (let i = 0; i < bits.length; i += 1) {
    if ((mask & bits[i]) !== 0) out.push(labels[i]);
  }
  return out.length === 0 ? "（无）" : " " + out.join("、");
}

function formatMonthdays(days: number[]): string {
  if (days.length === 0) return "（未指定）";
  return (
    " " +
    days
      .map((d) => (d === 0 ? "末" : `${d}号`))
      .join("、")
  );
}

function formatMonths(months: number[]): string {
  if (months.length === 0) return "（未指定月）";
  return " " + months.map((m) => `${m}月`).join("、");
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function timeString(h: number, m: number): string {
  return `${pad2(h)}:${pad2(m)}`;
}

function parseTime(text: string): [number, number] {
  const match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return [9, 0];
  const h = Math.max(0, Math.min(23, Number(match[1])));
  const m = Math.max(0, Math.min(59, Number(match[2])));
  return [h, m];
}

function defaultEndsDate(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// 暴露给 TaskDialog 共用——同一份"今年 +1 年"的逻辑不再两边各写一遍。
export { defaultEndsDate };

function validateClient(rule: StructuredRule) {
  if (rule.freq === "weekly" && rule.bydayMask === 0) {
    throw {
      code: "INVALID_ARGUMENT",
      message: "每周规则必须至少选一天。",
      detail: null,
    };
  }
  if (rule.freq === "monthly" && (rule.bymonthday ?? []).length === 0) {
    throw {
      code: "INVALID_ARGUMENT",
      message: "每月规则必须指定日期。",
      detail: null,
    };
  }
  if (
    rule.freq === "monthly" &&
    (rule.bymonthday ?? []).includes(0) &&
    (rule.bymonthday ?? []).length !== 1
  ) {
    throw {
      code: "INVALID_ARGUMENT",
      message: "「月末」只能单独使用,不能与其它日期混填。",
      detail: null,
    };
  }
  if (rule.freq === "yearly" && (rule.bymonth ?? []).length === 0) {
    throw {
      code: "INVALID_ARGUMENT",
      message: "每年规则必须指定月份。",
      detail: null,
    };
  }
  if (rule.ends.kind === "on" && !/^\d{4}-\d{2}-\d{2}$/.test(rule.ends.date)) {
    throw {
      code: "INVALID_ARGUMENT",
      message: "终止日格式应为 YYYY-MM-DD。",
      detail: null,
    };
  }
  if (rule.ends.kind === "after" && rule.ends.n < 1) {
    throw {
      code: "INVALID_ARGUMENT",
      message: "出现次数须 ≥ 1。",
      detail: null,
    };
  }
}
