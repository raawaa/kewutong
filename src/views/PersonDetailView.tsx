import { useEffect, useMemo, useState } from "react";
import { getPersonDetail, listSubTeams, toAppError, type AppError, type PersonDetail, type SubTeam } from "@/lib/api";

/**
 * 「人员详情」视图（ticket #80 / #81 T1）。
 *
 * T1 本期只渲染 header（详情档案 + 计数）：
 * - 姓名 + 子组徽章 + 联系方式
 * - 离岗时间（如有）
 * - 录入时间
 * - 在飞任务数（Open / In-progress / Blocked / Waiting-on 总和）
 * - 阻塞任务数（Blocked + Waiting-on）
 *
 * 后续 T2~T5 ticket 会按父 issue #80 的「5 段聚合」顺序在本组件下方叠
 * 加「在飞任务 6 状态分段」「负责项目」「等待本人推动」「所属子组的周期模板」
 * 四段。本期 spec 不涉及。
 *
 * 业务语义全在主进程 `getPersonDetail`——前端拿到就渲染,不二次聚合。
 * 子组徽章的 `name` 复用父层 catalog,避免详情页单独发一次 IPC——若
 * catalog 里没有,回退到 "未知子组 (id=n)"。
 */
export function PersonDetailView({
  personId,
  subTeams,
  refreshToken,
}: {
  personId: number;
  /** 父层 catalog 里的子组缓存——详情视图借此展示子组徽章,不发 IPC。 */
  subTeams: SubTeam[];
  /** 父层保存后 +1,触发本视图重拉。 */
  refreshToken: number;
}) {
  const [detail, setDetail] = useState<PersonDetail | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    getPersonDetail({ id: personId })
      .then((dto) => {
        if (cancelled) return;
        setDetail(dto);
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
  }, [personId, refreshToken]);

  // 父层 catalog 优先;若该 person 的 sub_team 不在 catalog 里(罕见,父层刚
  // 刷新或人员刚被调岗),拉一次兜底——子组徽章不该是 "?"。这里单独
  // 调 listSubTeams 而不是给整个 catalog 加 fallback,因为详情页是
  // 被动打开,不主动维护全局缓存。
  const fallbackSubTeams: SubTeam[] | null = useMissingSubTeams(detail, subTeams);
  const allSubTeams: SubTeam[] = fallbackSubTeams ?? subTeams;

  const subTeamName = useMemo(() => {
    if (detail == null) return null;
    const found = allSubTeams.find((t) => t.id === detail.person.subTeamId);
    return found?.name ?? `未知子组 (id=${detail.person.subTeamId})`;
  }, [detail, allSubTeams]);

  if (error) {
    return (
      <section
        role="alert"
        className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm"
      >
        {error.message}
      </section>
    );
  }

  if (detail == null) {
    return (
      <p className="text-muted-foreground text-sm">
        {busy ? "载入中…" : "暂无数据。"}
      </p>
    );
  }

  const inFlightCount =
    detail.inFlight.open.length +
    detail.inFlight.inProgress.length +
    detail.inFlight.blocked.length +
    detail.inFlight.waitingOn.length;
  const blockedCount =
    detail.inFlight.blocked.length + detail.inFlight.waitingOn.length;
  const off = detail.person.deactivatedAt != null;

  return (
    <header
      data-person-id={detail.person.id}
      className={`bg-card text-card-foreground flex flex-col gap-3 rounded-lg border p-4 ${
        off ? "bg-muted/40 text-muted-foreground" : ""
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-lg font-semibold">{detail.person.name}</h2>
        {subTeamName != null && (
          <span
            className="rounded-md bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700"
            title="所属子组"
          >
            {subTeamName}
          </span>
        )}
        {off && (
          <span
            className="rounded-md bg-muted px-2 py-0.5 text-xs font-medium"
            title="已离岗"
          >
            离岗 · {detail.person.deactivatedAt}
          </span>
        )}
      </div>

      <dl className="text-muted-foreground grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
        <div className="flex gap-1.5">
          <dt className="shrink-0">联系方式</dt>
          <dd className="text-foreground truncate font-mono">{detail.person.contact}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="shrink-0">录入时间</dt>
          <dd className="text-foreground">{detail.person.createdAt}</dd>
        </div>
        {off && (
          <div className="flex gap-1.5">
            <dt className="shrink-0">离岗时间</dt>
            <dd className="text-foreground">{detail.person.deactivatedAt}</dd>
          </div>
        )}
      </dl>

      <div className="text-muted-foreground flex items-baseline gap-4 text-xs tabular-nums">
        <span title="在飞任务数(Open / In-progress / Blocked / Waiting-on)">
          在飞 <span className="text-foreground font-medium">{inFlightCount}</span>
        </span>
        {blockedCount > 0 ? (
          <span className="text-orange-600" title="阻塞任务数(Blocked + Waiting-on)">
            阻塞 <span className="font-medium">{blockedCount}</span>
          </span>
        ) : (
          <span title="阻塞任务数(Blocked + Waiting-on)">
            阻塞 <span className="text-foreground font-medium">{blockedCount}</span>
          </span>
        )}
      </div>
    </header>
  );
}

/**
 * 父层 catalog 缺失时,兜底拉一次 sub_team——给详情页能正常显示子组徽章。
 *
 * 「仅缺一个就发 IPC」很轻——`listSubTeams` 全表查,UI 上每人详情页
 * 至多触发一次（person 切换后 effect 跑、refreshToken 变化时也跑）。
 * 这层 fallback 只在 catalog 缺的子组 id 出现在当前 detail 时触发,平
 * 时返回 null（不发 IPC）。
 */
function useMissingSubTeams(
  detail: PersonDetail | null,
  subTeams: SubTeam[],
): SubTeam[] | null {
  const [fallback, setFallback] = useState<SubTeam[] | null>(null);
  const targetId = detail?.person.subTeamId ?? null;
  const inCatalog = targetId == null
    || subTeams.some((t) => t.id === targetId);

  useEffect(() => {
    if (inCatalog) {
      setFallback(null);
      return;
    }
    let cancelled = false;
    listSubTeams()
      .then((all) => {
        if (!cancelled) setFallback(all);
      })
      .catch(() => {
        // 拉失败 → 详情页回退到「未知子组 (id=n)」,不阻塞渲染。
      });
    return () => {
      cancelled = true;
    };
  }, [targetId, inCatalog]);

  return fallback;
}
