/**
 * `@` 内联选人的**编辑器机制**——光标前的哪一段算「正在输入的候选词」。
 *
 * 注意边界：这里只管「触发词是什么」，不管「候选有哪些」。候选的过滤与
 * 排序是业务规则，权威在 Rust 的 `list_assignee_candidates`（ticket #19
 * 验收点：前端不含业务逻辑）。
 */

/** 正在输入中的 `@` 触发词。`index` 是 `@` 本身在光标前文本中的下标。 */
export type MentionTrigger = {
  index: number;
  query: string;
};

/**
 * `@` 与候选词之间最多容得下几个字。
 *
 * 没有上限的话，一段话里早先打过的 `@`（比如邮箱、外文缩写）会在几十个字
 * 之后突然把下拉重新拉起来。
 */
const MAX_QUERY_LENGTH = 20;

/**
 * 从光标前的文本里找出正在输入的 `@` 触发词，没有则返回 `null`。
 *
 * 取**最后一个**仍然"开着"的 `@`：其后不含空白、长度没超上限。
 */
export function findMentionTrigger(textBeforeCaret: string): MentionTrigger | null {
  for (let index = textBeforeCaret.length - 1; index >= 0; index -= 1) {
    if (textBeforeCaret[index] !== "@") continue;

    const query = textBeforeCaret.slice(index + 1);
    if (query.length > MAX_QUERY_LENGTH) return null;
    // 打了空白就说明科长放弃了这次 `@`，改在写正文
    if (/\s/.test(query)) return null;
    return { index, query };
  }
  return null;
}
