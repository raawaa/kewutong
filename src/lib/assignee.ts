/**
 * `Person` → `AssigneeCandidate` 收口（#82 T2 顺手抽出来）。
 *
 * 这两个 DTO 的字段名刻意不同：`Person.id` 是档案主键，
 * `AssigneeCandidate.personId` 是「@ 候选里的下拉编号」；
 * `Person.subTeamId` → `AssigneeCandidate.subTeamName` 需要
 * catalog 二次查询。
 *
 * App 层 (`openCreateWithAssignee`) 与 `PersonDetailView` 都按
 * `{personId, name, subTeamName}` 三件套构造——抽到一处避免两处
 * 漂移（catalog 兜底空串 vs 子组徽章"未知子组 (id=...)"两套兜
 * 底语义，本文件兜底策略：catalog 缺失 → 空串——上层若有更精细的
 * 兜底，可自行包一层）。
 */
import type { AssigneeCandidate, Person, SubTeam } from "@/lib/api";

export function toAssigneeCandidate(
  person: Person,
  subTeams: SubTeam[],
): AssigneeCandidate {
  const team = subTeams.find((t) => t.id === person.subTeamId);
  return {
    personId: person.id,
    name: person.name,
    subTeamName: team?.name ?? "",
  };
}