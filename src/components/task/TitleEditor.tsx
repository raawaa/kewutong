import { useEffect, useRef, useState } from "react";
import type { AssigneeCandidate } from "@/lib/ipc";
import { findMentionTrigger } from "./mention";

/**
 * 任务标题输入（ticket #19）。
 *
 * 一个 contenteditable：直接打字写标题，打 `@` 内联挑人。选中的人以 pill 的
 * 形式留在标题里，同时就是这条任务的负责人——一句话录完一条任务。
 *
 * 职责边界：
 * - **候选是什么**由命令层说了算。本组件只把 `@` 后面打出的词交给
 *   `fetchCandidates`，再渲染返回的列表，不自己过滤、不自己排序，也不知道
 *   "离岗的人要排除"这条规则（ticket #19 验收点：前端不含业务逻辑）。
 * - **光标与 DOM** 归本组件自己管。contenteditable 的子节点交给浏览器，
 *   React 只在挂载时铺一次初值；换任务时由父组件用 `key` 重新挂载。
 */
export function TitleEditor({
  initialTitle,
  initialAssignee,
  onChange,
  fetchCandidates,
  onSubmit,
  disabled = false,
  autoFocus = false,
}: {
  /** 挂载时的标题文本（编辑态用已有标题开场）。 */
  initialTitle: string;
  /** 挂载时已选的负责人。 */
  initialAssignee: AssigneeCandidate | null;
  onChange: (value: { title: string; assignee: AssigneeCandidate | null }) => void;
  /** 取候选——权威在命令层的 `list_assignee_candidates`。 */
  fetchCandidates: (query: string) => Promise<AssigneeCandidate[]>;
  /** 下拉关着时按回车触发。 */
  onSubmit?: () => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [candidates, setCandidates] = useState<AssigneeCandidate[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  // 输入快、命令慢时，晚发早归的响应不能盖掉新响应
  const requestSeq = useRef(0);

  // 只在挂载时铺初值：之后 contenteditable 的内容归浏览器管，React 再插手
  // 会把光标顶掉。换任务 = 父组件换 `key` 重新挂载。
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    box.replaceChildren();
    if (initialAssignee) {
      box.append(createPill(initialAssignee), document.createTextNode(" "));
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
    setCandidates([]);
    setActiveIndex(0);
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
    const results = await fetchCandidates(trigger.query);
    if (seq !== requestSeq.current) return;
    setCandidates(results);
    setActiveIndex(0);
  }

  function selectCandidate(candidate: AssigneeCandidate) {
    const box = boxRef.current;
    if (!box) return;
    insertMention(box, candidate);
    closeCandidates();
    emitChange();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (candidates.length > 0) {
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          setActiveIndex((index) => (index + 1) % candidates.length);
          return;
        case "ArrowUp":
          event.preventDefault();
          setActiveIndex(
            (index) => (index - 1 + candidates.length) % candidates.length,
          );
          return;
        case "Enter":
        case "Tab":
          event.preventDefault();
          selectCandidate(candidates[activeIndex]);
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
        aria-expanded={candidates.length > 0}
        contentEditable={!disabled}
        suppressContentEditableWarning
        data-placeholder="任务标题，输入 @ 选人员…"
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

      {candidates.length > 0 && (
        <ul
          role="listbox"
          aria-label="人员候选"
          className="bg-popover absolute top-[calc(100%+4px)] left-0 z-10 max-h-60 min-w-70 overflow-y-auto rounded-lg border p-1 shadow-lg"
        >
          {candidates.map((candidate, index) => (
            <li
              key={candidate.personId}
              role="option"
              aria-selected={index === activeIndex}
              onMouseDown={(event) => {
                // 别让点击把光标从 contenteditable 上抢走——插 pill 还要用它
                event.preventDefault();
                selectCandidate(candidate);
              }}
              onMouseEnter={() => setActiveIndex(index)}
              className={`flex cursor-pointer items-center gap-2.5 rounded px-2.5 py-1.5 text-sm ${
                index === activeIndex ? "bg-muted" : ""
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// contenteditable 的读写
// ---------------------------------------------------------------------------

/** pill 用 `data-person-id` 标记；读回负责人时就靠它认。 */
const PILL_SELECTOR = "[data-person-id]";

function createPill(candidate: AssigneeCandidate): HTMLSpanElement {
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

/**
 * 从 DOM 读回当前值。
 *
 * 标题是**不含 pill** 的那部分文本——负责人已经单独存成 `owner_person_id`，
 * 再把 `@张三` 留在标题里只是噪声。
 */
function readValue(box: HTMLElement): {
  title: string;
  assignee: AssigneeCandidate | null;
} {
  const pill = box.querySelector<HTMLElement>(PILL_SELECTOR);
  const assignee: AssigneeCandidate | null = pill
    ? {
        personId: Number(pill.dataset.personId),
        name: pill.dataset.personName ?? "",
        subTeamName: pill.dataset.subTeamName ?? "",
      }
    : null;

  let title = "";
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (!node.parentElement?.closest(PILL_SELECTOR)) {
      title += node.textContent ?? "";
    }
    node = walker.nextNode();
  }

  // 摘掉 pill 会在原地留下空档，顺手抹平
  return { title: title.replace(/\s+/g, " ").trim(), assignee };
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
function insertMention(box: HTMLElement, candidate: AssigneeCandidate) {
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

  const pill = createPill(candidate);
  const trailingSpace = document.createTextNode(" ");
  // `insertNode` 插在 range 起点，因此后插的排在前面：先空格后 pill = pill 在前
  replaced.insertNode(trailingSpace);
  replaced.insertNode(pill);

  for (const stale of box.querySelectorAll(PILL_SELECTOR)) {
    if (stale !== pill) stale.remove();
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
