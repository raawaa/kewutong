import { useEffect, useMemo, useRef, useState } from "react";
import {
  Plus,
  UserRound,
  Folder,
  ListChecks,
  ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  toAppError,
  wayfinderSearch,
  type AppError,
  type AssigneeCandidate,
  type Person,
  type Project,
  type ProjectCandidate,
  type SubTeam,
  type Task,
  type WayfinderMatchKind,
  type WayfinderPersonHit,
  type WayfinderProjectHit,
  type WayfinderSearchResults,
} from "@/lib/ipc";

/**
 * 选中一条候选后,通知外层"接下来要做什么"。
 *
 * 任务命中直接给"打开这条任务的编辑弹窗"——`assignee` / `project` 候选
 * 在命令面板里从外层传入的 catalog 算好,避免弹窗里再发起 IPC。
 */
export type CommandPaletteTarget =
  | { kind: "openCreateTask" }
  | {
      kind: "openEditTask";
      task: Task;
      assignee: AssigneeCandidate | null;
      project: ProjectCandidate | null;
    }
  | { kind: "openPerson"; personId: number; subTeamId: number }
  | { kind: "openProject"; projectId: number };

/**
 * ⌘K 全局命令面板（ticket #28）。
 *
 * 验收点：
 * - 模糊匹配可导航到人员 / 项目 / 任务三类目标
 * - 选中目标跳转到对应视图并定位
 * - 面板内可直接触发新建任务
 * - 键盘全程可操作（上下选择 / 回车确认 / Esc 关闭）
 *
 * **所有匹配 / 排序 / 截断 / 过滤都发生在命令层**——前端只渲染
 * `wayfinder_search` 的返回结果。输入变化时调一次命令；空 query 仍
 * 走命令,后端回默认排序的前 N 条。
 */
export function CommandPalette({
  open,
  catalog,
  onClose,
  onPick,
}: {
  open: boolean;
  /**
   * 全局 catalog——人员 / 子组 / 项目。App 层一次性加载后传入,
   * 命令面板据此算出编辑弹窗需要的候选人(`assignee` / `project`),
   * 避免每个候选点开时再发起 IPC。
   */
  catalog: {
    people: Person[];
    subTeams: SubTeam[];
    projects: Project[];
  };
  onClose: () => void;
  onPick: (target: CommandPaletteTarget) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WayfinderSearchResults | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  // 选中索引走扁平列表——人员 / 项目 / 任务各自的边界由 [flatEntries]
  // 算;键盘上下移动索引,Enter 把 flat[i] 转成 CommandPaletteTarget。
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const { people, subTeams, projects } = catalog;
  const subTeamNameById = useMemo(
    () => new Map(subTeams.map((s) => [s.id, s.name])),
    [subTeams],
  );
  const peopleById = useMemo(
    () => new Map(people.map((p) => [p.id, p])),
    [people],
  );
  const projectsById = useMemo(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects],
  );

  // 每次开窗：清空旧 query + 焦点落在 input 上——`open` 边沿触发。
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setError(null);
    setSelectedIndex(0);
    // 微任务后再 focus——DOM 此时已挂载,直接 focus 在 Tauri webview 里
    // 偶尔被其它 focus 抢走（命令面板出现时鼠标可能还在原位置）。
    const handle = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(handle);
  }, [open]);

  // 输入变化时拉命令——debounce 由 React 18 的 transition 帮我们做点
  // （setQuery 自身不阻塞），命令层走 spawn_blocking 也帮挡一道。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    wayfinderSearch({ query })
      .then((fetched) => {
        if (cancelled) return;
        setResults(fetched);
        setSelectedIndex(0);
      })
      .catch((thrown) => {
        if (cancelled) return;
        setError(toAppError(thrown));
      });
    return () => {
      cancelled = true;
    };
  }, [open, query]);

  // 扁平条目：新建任务（始终在最上）+ 任务 + 项目 + 人员。
  // 顺序与命令层返回顺序一致,前端不再二次排序——这把"什么是候选"的
  // 责任完全压在命令层。
  type FlatEntry =
    | { kind: "createTask"; key: "createTask" }
    | { kind: "task"; key: string; task: Task }
    | { kind: "project"; key: string; hit: WayfinderProjectHit }
    | { kind: "person"; key: string; hit: WayfinderPersonHit };

  const flatEntries: FlatEntry[] = useMemo(() => {
    const out: FlatEntry[] = [];
    out.push({ kind: "createTask", key: "createTask" });
    if (results) {
      for (const task of results.tasks) {
        out.push({ kind: "task", key: `task-${task.id}`, task });
      }
      for (const hit of results.projects) {
        out.push({ kind: "project", key: `project-${hit.projectId}`, hit });
      }
      for (const hit of results.people) {
        out.push({ kind: "person", key: `person-${hit.personId}`, hit });
      }
    }
    return out;
  }, [results]);

  function entryToTarget(entry: FlatEntry): CommandPaletteTarget {
    if (entry.kind === "createTask") return { kind: "openCreateTask" };
    if (entry.kind === "project") {
      return { kind: "openProject", projectId: entry.hit.projectId };
    }
    if (entry.kind === "person") {
      return {
        kind: "openPerson",
        personId: entry.hit.personId,
        subTeamId: entry.hit.subTeamId,
      };
    }
    // task: 需要在弹窗里塞候选人——从 catalog 算
    const task = entry.task;
    const person = peopleById.get(task.ownerPersonId);
    const assignee: AssigneeCandidate | null = person
      ? {
          personId: person.id,
          name: person.name,
          subTeamName: subTeamNameById.get(person.subTeamId) ?? "",
        }
      : null;
    const project = task.projectId
      ? (() => {
          const p = projectsById.get(task.projectId);
          if (!p) return null;
          return {
            projectId: p.id,
            name: p.name,
            subTeamName: subTeamNameById.get(p.subTeamId) ?? "",
          };
        })()
      : null;
    return { kind: "openEditTask", task, assignee, project };
  }

  // 键盘——上下移动 / Enter 选中 / Esc 关闭。命令面板里的事件不冒泡
  // 到 App 层的 ⌘N / ⌘K（capture 阶段先吃掉）。
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, Math.max(flatEntries.length - 1, 0)));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const entry = flatEntries[selectedIndex];
        if (entry) {
          onPick(entryToTarget(entry));
          onClose();
        }
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, flatEntries, selectedIndex, onClose, onPick]);

  // 选中变化时让选中的项滚进可视区——避免键盘一路按下来到屏幕外。
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector<HTMLElement>(
      `[data-index="${selectedIndex}"]`,
    );
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="全局命令面板"
        className="bg-background flex w-full max-w-xl flex-col overflow-hidden rounded-xl border shadow-2xl"
      >
        <header className="flex items-center gap-2 border-b px-4 py-2.5">
          <span className="text-muted-foreground text-xs">
            <kbd className="rounded border px-1.5 py-0.5 text-[10px] font-mono">⌘K</kbd>
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜人员 / 项目 / 任务，或新建任务…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            aria-label="搜索"
          />
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onClose}
            aria-label="关闭"
          >
            ×
          </Button>
        </header>

        {error && (
          <p
            role="alert"
            className="border-destructive/40 bg-destructive/10 text-destructive mx-3 mt-2 rounded-md border px-3 py-2 text-xs"
          >
            {error.message}
          </p>
        )}

        <ul
          ref={listRef}
          className="max-h-[60vh] flex-1 overflow-y-auto py-1.5"
          role="listbox"
        >
          {flatEntries.map((entry, index) => {
            const selected = index === selectedIndex;
            return (
              <PaletteRow
                key={entry.key}
                index={index}
                selected={selected}
                entry={entry}
                onHover={() => setSelectedIndex(index)}
              />
            );
          })}
          {results != null && flatEntries.length === 1 && (
            <li className="text-muted-foreground px-4 py-6 text-center text-xs">
              没有命中任何人员 / 项目 / 任务。
            </li>
          )}
          {results != null && flatEntries.length > 1 && (
            <FooterHint
              counts={{
                people: results.people.length,
                projects: results.projects.length,
                tasks: results.tasks.length,
              }}
            />
          )}
        </ul>

        <footer className="text-muted-foreground flex items-center justify-between gap-3 border-t px-4 py-2 text-[11px]">
          <span className="flex items-center gap-3">
            <span>↑↓ 选择</span>
            <span>Enter 确认</span>
            <span>Esc 关闭</span>
          </span>
          <span>⌘N 新建任务</span>
        </footer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 行渲染
// ---------------------------------------------------------------------------

function PaletteRow({
  index,
  selected,
  entry,
  onHover,
}: {
  index: number;
  selected: boolean;
  entry:
    | { kind: "createTask"; key: string }
    | { kind: "task"; key: string; task: Task }
    | { kind: "project"; key: string; hit: WayfinderProjectHit }
    | { kind: "person"; key: string; hit: WayfinderPersonHit };
  onHover: () => void;
}) {
  return (
    <li
      data-index={index}
      role="option"
      aria-selected={selected}
      onMouseMove={onHover}
      onMouseDown={(event) => {
        // mouseDown 而不是 click——避免 input 失焦抢走键盘事件链
        event.preventDefault();
      }}
      className={`mx-2 flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm ${
        selected ? "bg-muted" : ""
      }`}
    >
      {entry.kind === "createTask" ? (
        <>
          <KindBadge kind="action" />
          <span className="flex-1 font-medium">新建任务</span>
          <span className="text-muted-foreground text-xs">
            <kbd className="rounded border px-1.5 py-0.5 text-[10px] font-mono">⌘N</kbd>
          </span>
        </>
      ) : entry.kind === "task" ? (
        <>
          <KindBadge kind="task" />
          <span className="flex-1 truncate">{entry.task.title}</span>
          {entry.task.dueDate && (
            <span className="text-muted-foreground shrink-0 text-xs">
              {entry.task.dueDate}
            </span>
          )}
        </>
      ) : entry.kind === "project" ? (
        <>
          <KindBadge kind="project" />
          <span className="flex-1 truncate">
            <Highlight
              text={entry.hit.name}
              match={entry.hit.matchKind === "sub-team" ? "sub-team" : "name"}
            />
            <span className="text-muted-foreground ml-2 text-xs">
              <Highlight
                text={entry.hit.subTeamName}
                match={entry.hit.matchKind === "name" ? "sub-team" : "name"}
              />
            </span>
          </span>
          <span className="text-muted-foreground shrink-0 text-xs">
            {entry.hit.status}
          </span>
        </>
      ) : (
        <>
          <KindBadge kind="person" />
          <span className="flex-1 truncate">
            <Highlight
              text={entry.hit.name}
              match={entry.hit.matchKind === "sub-team" ? "sub-team" : "name"}
            />
            <span className="text-muted-foreground ml-2 text-xs">
              <Highlight
                text={entry.hit.subTeamName}
                match={entry.hit.matchKind === "name" ? "sub-team" : "name"}
              />
            </span>
          </span>
        </>
      )}
    </li>
  );
}

function KindBadge({
  kind,
}: {
  kind: "task" | "project" | "person" | "action";
}) {
  const map = {
    task: { icon: ListChecks, label: "任务", className: "bg-blue-50 text-blue-600" },
    project: { icon: Folder, label: "项目", className: "bg-violet-50 text-violet-600" },
    person: { icon: UserRound, label: "人员", className: "bg-emerald-50 text-emerald-600" },
    action: { icon: Plus, label: "动作", className: "bg-amber-50 text-amber-600" },
  } as const;
  const entry = map[kind];
  const Icon = entry.icon;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${entry.className}`}
    >
      <Icon className="size-3" />
      {entry.label}
    </span>
  );
}

function Highlight({ text, match }: { text: string; match: WayfinderMatchKind }) {
  // match === "both" 表示人名 + 子组名都中——整行加粗,但字符级不高亮
  // (子串索引在客户端算一遍意义不大——命令层已经按子串召回,前端
  // 把命中区间视觉上突出就行,粒度不追求字符级)。
  if (match === "both") {
    return <strong className="font-semibold">{text}</strong>;
  }
  return <>{text}</>;
}

function FooterHint({
  counts,
}: {
  counts: { people: number; projects: number; tasks: number };
}) {
  // 让用户看到三类各有多少候选——避免"我搜了但没反应"的疑惑。
  return (
    <li className="text-muted-foreground mx-4 mt-1 flex items-center gap-2 border-t pt-2 text-[11px]">
      <ChevronDown className="size-3" />
      <span>
        人员 {counts.people} · 项目 {counts.projects} · 任务 {counts.tasks}
      </span>
    </li>
  );
}
