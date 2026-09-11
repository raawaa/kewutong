import { useEffect, useRef, useState } from "react";
import type { AssigneeCandidate, ProjectCandidate } from "@/lib/ipc";
import { findMentionTrigger } from "./mention";

/**
 * 项目内联候选的展示形态：补上 `projectId` 让 pill 读得回来。
 *
 * 命令层给的 [`ProjectCandidate`] 已经够用（`projectId` + `name` + `subTeamName`），
 * 这里只是起一个**类型别名**让标题输入层的代码更短。
 */
type ProjectOption = ProjectCandidate;

/**
 * 任务标题输入（ticket #19 / #20）。
 *
 * 一个 contenteditable：直接打字写标题，打 `@` 内联挑负责人 / 打 `#` 内联挑
 * 项目。选中的以 pill 形式留在标题里，同时就是这条任务的负责人 / 所属
 * 项目——一句话录完一条任务。
 *
 * 职责边界：
 * - **候选是什么**由命令层说了算。本组件只把触发符后面打出的词交给
 *   `fetchAssigneeCandidates` / `fetchProjectCandidates`，再渲染返回的列表，
 *   不自己过滤、不自己排序，也不知道 "离岗的人要排除" 这条规则。
 * - **光标与 DOM** 归本组件自己管。contenteditable 的子节点交给浏览器，
 *   React 只在挂载时铺一次初值；换任务时由父组件用 `key` 重新挂载。
 */
export function TitleEditor({
  initialTitle,
  initialAssignee,
  initialProject,
  onChange,
  fetchAssigneeCandidates,
  fetchProjectCandidates,
  onSubmit,
  disabled = false,
  autoFocus = false,
}: {
  /** 挂载时的标题文本（编辑态用已有标题开场）。 */
  initialTitle: string;
  /** 挂载时已选的负责人。 */
  initialAssignee: AssigneeCandidate | null;
  /** 挂载时已选的项目（编辑态用）。 */
  initialProject: ProjectOption | null;
  onChange: (value: {
    title: string;
    assignee: AssigneeCandidate | null;
    project: ProjectOption | null;
  }) => void;
  /** 取 `@` 候选——权威在命令层的 `list_assignee_candidates`。 */
  fetchAssigneeCandidates: (query: string) => Promise<AssigneeCandidate[]>;
  /** 取 `#` 候选——权威在命令层的 `list_project_candidates`。 */
  fetchProjectCandidates: (query: string) => Promise<ProjectOption[]>;
  /** 下拉关着时按回车触发。 */
  onSubmit?: () => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [assigneeCandidates, setAssigneeCandidates] = useState<AssigneeCandidate[]>([]);
  const [projectCandidates, setProjectCandidates] = useState<ProjectOption[]>([]);
  const [activeAssigneeIndex, setActiveAssigneeIndex] = useState(0);
  const [activeProjectIndex, setActiveProjectIndex] = useState(0);
  // 输入快、命令慢时，晚发早归的响应不能盖掉新响应
  const requestSeq = useRef(0);

  // 只在挂载时铺初值：之后 contenteditable 的内容归浏览器管，React 再插手
  // 会把光标顶掉。换任务 = 父组件换 `key` 重新挂载。
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    box.replaceChildren();
    if (initialAssignee) {
      box.append(createAssigneePill(initialAssignee), document.createTextNode(" "));
    }
    if (initialProject) {
      box.append(createProjectPill(initialProject), document.createTextNode(" "));
    }
    if (initialTitle) {
      box.append(document.createTextNode(initialTitle));
    }
    if (autoFocus) {
      box.focus();
      placeCaretAtEnd(box);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function closeCandidates() {
    // 让在途响应作废——否则 Esc 关掉的下拉会被慢一拍的响应重新拉起来
    requestSeq.current += 1;
    setAssigneeCandidates([]);
    setProjectCandidates([]);
    setActiveAssigneeIndex(0);
    setActiveProjectIndex(0);
  }

  function emitChange() {
    const box = boxRef.current;
    if (box) onChange(readValue(box));
  }

  async function refreshCandidates() {
    const box = boxRef.current;
    if (!box) return;
    const before = textBeforeCaret(box);
    const trigger = before == null ? null : findMentionTrigger(before);
    if (!trigger) {
      closeCandidates();
      return;
    }
    const seq = (requestSeq.current += 1);
    if (trigger.char === "@") {
      const results = await fetchAssigneeCandidates(trigger.query);
      if (seq !== requestSeq.current) return;
      setAssigneeCandidates(results);
      setProjectCandidates([]);
      setActiveAssigneeIndex(0);
    } else {
      const results = await fetchProjectCandidates(trigger.query);
      if (seq !== requestSeq.current) return;
      setProjectCandidates(results);
      setAssigneeCandidates([]);
      setActiveProjectIndex(0);
    }
  }

  function selectAssignee(candidate: AssigneeCandidate) {
    const box = boxRef.current;
    if (!box) return;
    insertAssignee(box, candidate);
    closeCandidates();
    emitChange();
  }

  function selectProject(candidate: ProjectOption) {
    const box = boxRef.current;
    if (!box) return;
    insertProject(box, candidate);
    closeCandidates();
    emitChange();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const hasAssignee = assigneeCandidates.length > 0;
    const hasProject = projectCandidates.length > 0;
    if (hasAssignee || hasProject) {
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          if (hasAssignee) {
            setActiveAssigneeIndex((index) => (index + 1) % assigneeCandidates.length);
          }
          return;
        case "ArrowUp":
          event.preventDefault();
          if (hasAssignee) {
            setActiveAssigneeIndex(
              (index) => (index - 1 + assigneeCandidates.length) % assigneeCandidates.length,
            );
          }
          return;
        case "Enter":
        case "Tab":
          event.preventDefault();
          if (hasAssignee) {
            selectAssignee(assigneeCandidates[activeAssigneeIndex]);
          } else if (hasProject) {
            selectProject(projectCandidates[activeProjectIndex]);
          }
          return;
        case "Escape":
          event.preventDefault();
          // 别让弹窗跟着一起关——这一下 Esc 只是收起下拉
          event.stopPropagation();
          closeCandidates();
          return;
      }
    }
    if (event.key === "Enter") {
      // 标题是单行的：回车提交，不换行
      event.preventDefault();
      onSubmit?.();
    }
  }

  return (
    <div className="relative">
      <div
        ref={boxRef}
        role="textbox"
        aria-label="任务标题"
        aria-multiline="false"
        aria-autocomplete="list"
        aria-expanded={assigneeCandidates.length > 0 || projectCandidates.length > 0}
        contentEditable={!disabled}
        suppressContentEditableWarning
        data-placeholder="任务标题，输入 @ 选人员，# 选项目…"
        onInput={() => {
          emitChange();
          void refreshCandidates();
        }}
        onKeyDown={handleKeyDown}
        onBlur={closeCandidates}
        onPaste={(event) => {
          // 粘进来的富文本会把 pill 的结构搅乱，一律降级成纯文本
          event.preventDefault();
          const text = event.clipboardData.getData("text/plain");
          insertPlainText(text);
          emitChange();
          void refreshCandidates();
        }}
        className="border-input bg-background focus:border-primary min-h-11 w-full rounded-md border px-3 py-2 text-base leading-relaxed break-words whitespace-pre-wrap focus:outline-none empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)]"
      />

      {assigneeCandidates.length > 0 && (
        <ul
          role="listbox"
          aria-label="人员候选"
          className="bg-popover absolute top-[calc(100%+4px)] left-0 z-10 max-h-60 min-w-70 overflow-y-auto rounded-lg border p-1 shadow-lg"
        >
          {assigneeCandidates.map((candidate, index) => (
            <li
              key={candidate.personId}
              role="option"
              aria-selected={index === activeAssigneeIndex}
              onMouseDown={(event) => {
                // 别让点击把光标从 contenteditable 上抢走——插 pill 还要用它
                event.preventDefault();
                selectAssignee(candidate);
              }}
              onMouseEnter={() => setActiveAssigneeIndex(index)}
              className={`flex cursor-pointer items-center gap-2.5 rounded px-2.5 py-1.5 text-sm ${
                index === activeAssigneeIndex ? "bg-muted" : ""
              }`}
            >
              <span className="flex-1">
                <span className="text-muted-foreground">@</span>
                {candidate.name}
              </span>
              <span className="text-muted-foreground text-xs">
                {candidate.subTeamName}
              </span>
            </li>
          ))}
        </ul>
      )}

      {projectCandidates.length > 0 && (
        <ul
          role="listbox"
          aria-label="项目候选"
          className="bg-popover absolute top-[calc(100%+4px)] left-0 z-10 max-h-60 min-w-70 overflow-y-auto rounded-lg border p-1 shadow-lg"
        >
          {projectCandidates.map((candidate, index) => (
            <li
              key={candidate.projectId}
              role="option"
              aria-selected={index === activeProjectIndex}
              onMouseDown={(event) => {
                event.preventDefault();
                selectProject(candidate);
              }}
              onMouseEnter={() => setActiveProjectIndex(index)}
              className={`flex cursor-pointer items-center gap-2.5 rounded px-2.5 py-1.5 text-sm ${
                index === activeProjectIndex ? "bg-muted" : ""
              }`}
            >
              <span className="flex-1">
                <span className="text-muted-foreground">#</span>
                {candidate.name}
              </span>
              <span className="text-muted-foreground text-xs">
                {candidate.subTeamName}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// contenteditable 的读写
// ---------------------------------------------------------------------------

/** 负责人 pill 用 `data-person-id` 标记；项目 pill 用 `data-project-id`。 */
const ASSIGNEE_PILL_SELECTOR = "[data-person-id]";
const PROJECT_PILL_SELECTOR = "[data-project-id]";

function createAssigneePill(candidate: AssigneeCandidate): HTMLSpanElement {
  const pill = document.createElement("span");
  // 整体不可编辑：退格一下删掉整个 pill，而不是啃掉一个字变成半个名字
  pill.contentEditable = "false";
  pill.dataset.personId = String(candidate.personId);
  pill.dataset.personName = candidate.name;
  pill.dataset.subTeamName = candidate.subTeamName;
  pill.textContent = `@${candidate.name}`;
  pill.className =
    "rounded bg-blue-100 px-1 py-0.5 text-blue-800 dark:bg-blue-950 dark:text-blue-200";
  return pill;
}

function createProjectPill(candidate: ProjectOption): HTMLSpanElement {
  const pill = document.createElement("span");
  pill.contentEditable = "false";
  pill.dataset.projectId = String(candidate.projectId);
  pill.dataset.projectName = candidate.name;
  pill.dataset.subTeamName = candidate.subTeamName;
  pill.textContent = `#${candidate.name}`;
  pill.className =
    "rounded bg-emerald-100 px-1 py-0.5 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200";
  return pill;
}

/**
 * 从 DOM 读回当前值。
 *
 * 标题是**不含 pill** 的那部分文本——负责人 / 项目已经单独存成 ID，
 * 再把 `@张三` / `#综合楼改造` 留在标题里只是噪声。
 */
function readValue(box: HTMLElement): {
  title: string;
  assignee: AssigneeCandidate | null;
  project: ProjectOption | null;
} {
  const assigneePill = box.querySelector<HTMLElement>(ASSIGNEE_PILL_SELECTOR);
  const assignee: AssigneeCandidate | null = assigneePill
    ? {
        personId: Number(assigneePill.dataset.personId),
        name: assigneePill.dataset.personName ?? "",
        subTeamName: assigneePill.dataset.subTeamName ?? "",
      }
    : null;

  const projectPill = box.querySelector<HTMLElement>(PROJECT_PILL_SELECTOR);
  const project: ProjectOption | null = projectPill
    ? {
        projectId: Number(projectPill.dataset.projectId),
        name: projectPill.dataset.projectName ?? "",
        subTeamName: projectPill.dataset.subTeamName ?? "",
      }
    : null;

  let title = "";
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const parent = node.parentElement;
    const inAssignee = parent?.closest(ASSIGNEE_PILL_SELECTOR);
    const inProject = parent?.closest(PROJECT_PILL_SELECTOR);
    if (!inAssignee && !inProject) {
      title += node.textContent ?? "";
    }
    node = walker.nextNode();
  }

  // 摘掉 pill 会在原地留下空档，顺手抹平
  return { title: title.replace(/\s+/g, " ").trim(), assignee, project };
}

/** 光标前的全部文本（含 pill 的文字，与 `findMentionTrigger` 的口径一致）。 */
function textBeforeCaret(box: HTMLElement): string | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const caret = selection.getRangeAt(0);
  if (!box.contains(caret.endContainer)) return null;
  const before = document.createRange();
  before.selectNodeContents(box);
  before.setEnd(caret.endContainer, caret.endOffset);
  return before.toString();
}

/**
 * 把「`@` 触发词到光标」这一段替换成人员 pill，并把光标落到 pill 之后。
 *
 * 一条任务只有一个负责人（`task.owner_person_id` 非空且单值），所以插新
 * pill 的同时把旧的摘掉——再选一个人 = 改派，而不是加一个人。
 */
function insertAssignee(box: HTMLElement, candidate: AssigneeCandidate) {
  insertPillAndClearOthers(
    box,
    createAssigneePill(candidate),
    [ASSIGNEE_PILL_SELECTOR],
  );
}

/** 与 [`insertAssignee`] 同构,但插的是项目 pill;摘掉的是另一个项目 pill。 */
function insertProject(box: HTMLElement, candidate: ProjectOption) {
  insertPillAndClearOthers(
    box,
    createProjectPill(candidate),
    [PROJECT_PILL_SELECTOR],
  );
}

/**
 * 在「触发符到光标」这一段上把当前触发符词替换掉,插上新 pill,并把同
 * 类型（assignee / project）的旧 pill 摘掉。不同类型的 pill（assignee vs
 * project）保留——一个负责人加一个项目是合法的。
 */
function insertPillAndClearOthers(
  box: HTMLElement,
  pill: HTMLSpanElement,
  clearSelectors: string[],
) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const caret = selection.getRangeAt(0);
  if (!box.contains(caret.endContainer)) return;

  const before = document.createRange();
  before.selectNodeContents(box);
  before.setEnd(caret.endContainer, caret.endOffset);
  const trigger = findMentionTrigger(before.toString());
  if (!trigger) return;

  // 注意顺序：`trigger.index` 是按「含旧 pill」的文本算的，所以先定位、
  // 再替换，最后才摘旧 pill。反过来做偏移就全错位了。
  const start = locateTextOffset(box, trigger.index);
  if (!start) return;

  const replaced = document.createRange();
  replaced.setStart(start.node, start.offset);
  replaced.setEnd(caret.endContainer, caret.endOffset);
  replaced.deleteContents();

  const trailingSpace = document.createTextNode(" ");
  // `insertNode` 插在 range 起点,因此后插的排在前面：先空格后 pill = pill 在前
  replaced.insertNode(trailingSpace);
  replaced.insertNode(pill);

  for (const selector of clearSelectors) {
    for (const stale of box.querySelectorAll(selector)) {
      if (stale !== pill) stale.remove();
    }
  }

  const after = document.createRange();
  after.setStartAfter(trailingSpace);
  after.collapse(true);
  selection.removeAllRanges();
  selection.addRange(after);
}

/** 把「整个 box 里第 n 个字符」换算成具体文本节点上的位置。 */
function locateTextOffset(
  box: HTMLElement,
  offset: number,
): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let node = walker.nextNode() as Text | null;
  while (node) {
    const length = node.textContent?.length ?? 0;
    if (seen + length > offset) return { node, offset: offset - seen };
    seen += length;
    node = walker.nextNode() as Text | null;
  }
  return null;
}

function insertPlainText(text: string) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function placeCaretAtEnd(box: HTMLElement) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(box);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}