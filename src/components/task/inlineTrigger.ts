/**
 * 内联触发的**编辑器机制**——光标前的哪一段算「正在输入的候选词」。
 *
 * 触发符有两种：`@` 选人、`#` 选项目。规则一致——所以共用一个通用入口，
 * `findInlineTrigger`。具体给哪个触发符用、候选渲染成什么,由调用方决定。
 *
 * 注意边界：这里只管「触发词是什么」,不管「候选有哪些」。候选的过滤与
 * 排序是业务规则,权威在 Rust 的 `list_assignee_candidates` /
 * `list_project_candidates`(ticket #19 / #20 验收点:前端不含业务逻辑)。
 */

/** 内联触发的字符：`@` 选人、`#` 选项目。 */
export type InlineTriggerChar = "@" | "#";

/** 正在输入中的触发词。`index` 是触发符本身在光标前文本中的下标。 */
export type InlineTrigger = {
  char: InlineTriggerChar;
  index: number;
  query: string;
};

/**
 * `@` 与候选词之间最多容得下几个字。
 *
 * 没有上限的话,一段话里早先打过的 `@`(比如邮箱、外文缩写)会在几十个字
 * 之后突然把下拉重新拉起来。`#` 与 `@` 走同一上限。
 */
const MAX_QUERY_LENGTH = 20;

/**
 * 从光标前的文本里找出正在输入的 `@` / `#` 触发词,没有则返回 `null`。
 *
 * 取**最后一个**仍然"开着"的触发符:其后不含空白、长度没超上限。
 */
export function findInlineTrigger(
  textBeforeCaret: string,
): InlineTrigger | null {
  for (let index = textBeforeCaret.length - 1; index >= 0; index -= 1) {
    const char = textBeforeCaret[index];
    if (char !== "@" && char !== "#") continue;

    const query = textBeforeCaret.slice(index + 1);
    if (query.length > MAX_QUERY_LENGTH) return null;
    // 打了空白就说明科长放弃了这次触发,改在写正文
    if (/\s/.test(query)) return null;
    return { char, index, query };
  }
  return null;
}