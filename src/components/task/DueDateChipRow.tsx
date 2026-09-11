import type { DueDateOption } from "@/lib/ipc";

/**
 * 截止 chip 行（ticket #19）。
 *
 * 「今天 / 明天 / 一周后 / 无」有哪几格、各是哪一天，全由命令层
 * (`list_due_date_options`) 算好后经 `options` 传进来——本组件只负责渲染与
 * 上报选值，不碰日期运算。chip 覆盖不到的日子走右侧日历精确选。
 *
 * 新建与编辑用的是同一个组件：改期的手势与新建时一致（ticket #19 验收点）。
 */
export function DueDateChipRow({
  options,
  value,
  onChange,
  disabled = false,
  noneHighlighted = true,
}: {
  /** 命令层给的 chip 行。 */
  options: DueDateOption[];
  /** 当前截止日；`null` = 无截止。 */
  value: string | null;
  onChange: (dueDate: string | null) => void;
  disabled?: boolean;
  /**
   * `value` 为 `null` 时是否把「无」chip 标成选中。默认 `true`：value=null
   * 与「无」chip 的 `dueDate` 同值，按相等判定「无」就是选中。
   *
   * 新建弹窗的留空默认态会传 `false`——四格都不高亮，提示"还没设"。
   */
  noneHighlighted?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {options.map((option) => {
        // 选态两条路径：
        // - 普通 chip：与 value 相等即选中
        // - 「无」chip（dueDate 为空）：仅在 value 也为 null、且父组件同意
        //   高亮时（默认 true）才选中。value 非 null 时永远不高亮。
        // 「新建弹窗的留空默认」也是 value=null，硬比对会替科长"选"了无
        // 截止——传 `noneHighlighted=false` 显式声明"还没设"就不亮。
        const selected =
          option.dueDate == null
            ? value == null && noneHighlighted
            : option.dueDate === value;
        return (
          <button
            key={option.chip}
            type="button"
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => onChange(option.dueDate)}
            className={`cursor-pointer rounded-full border px-2.5 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              selected
                ? "bg-primary text-primary-foreground border-primary"
                : option.chip === "none"
                  ? "border-border bg-background text-muted-foreground hover:bg-muted"
                  : "border-border bg-background hover:bg-muted"
            }`}
          >
            {option.label}
          </button>
        );
      })}
      <input
        type="date"
        aria-label="精确选日"
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || null)}
        className="border-input bg-background ml-1 rounded-md border px-2 py-1 text-xs disabled:opacity-50"
      />
    </div>
  );
}
