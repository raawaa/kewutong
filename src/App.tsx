import { useEffect, useMemo, useState } from "react";
import { Activity, Pencil, Plus, Trash2, ArrowUp, ArrowDown, PowerOff, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  createPerson,
  createSubTeam,
  deactivatePerson,
  deletePerson,
  deleteSubTeam,
  listPeople,
  listSubTeams,
  ping,
  reactivatePerson,
  reorderSubTeams,
  toAppError,
  updatePerson,
  updateSubTeam,
  type AppError,
  type Person,
  type PingReply,
  type SubTeam,
} from "@/lib/ipc";

/**
 * 人员管理界面（ticket #17）。
 *
 * 左侧：子组列表——增删改、按上下箭头重排。
 * 右侧：所选子组下的人员——增删改、离岗 / 复岗。
 *
 * 业务规则一律在后端命令层实现；前端只负责展示与触发。
 */
export default function App() {
  // —— 数据 ——
  const [subTeams, setSubTeams] = useState<SubTeam[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [selectedSubTeamId, setSelectedSubTeamId] = useState<number | null>(null);

  // —— 表单 / 编辑状态 ——
  const [editingSubTeam, setEditingSubTeam] = useState<
    | { kind: "new" }
    | { kind: "edit"; subTeam: SubTeam }
    | null
  >(null);
  const [editingPerson, setEditingPerson] = useState<
    | { kind: "new" }
    | { kind: "edit"; person: Person }
    | null
  >(null);

  // —— 全局状态 ——
  const [pingReply, setPingReply] = useState<PingReply | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);

  // —— 副作用：进入页面拉一次 ——
  useEffect(() => {
    void refreshAll();
  }, []);

  // 默认选中第一个子组
  useEffect(() => {
    if (selectedSubTeamId == null && subTeams.length > 0) {
      setSelectedSubTeamId(subTeams[0].id);
    }
  }, [subTeams, selectedSubTeamId]);

  // —— 当前选中子组的人员计数（含离岗） ——
  const peopleBySubTeam = useMemo(() => {
    const map = new Map<number, number>();
    for (const person of people) {
      map.set(person.subTeamId, (map.get(person.subTeamId) ?? 0) + 1);
    }
    return map;
  }, [people]);

  async function refreshAll() {
    setBusy(true);
    try {
      const [teams, roster] = await Promise.all([
        listSubTeams(),
        listPeople({ includeDeactivated: true, subTeamId: null }),
      ]);
      setSubTeams(teams);
      setPeople(roster);
      setError(null);
    } catch (thrown) {
      setError(toAppError(thrown));
    } finally {
      setBusy(false);
    }
  }

  async function selfCheck() {
    setBusy(true);
    try {
      setPingReply(await ping());
      setError(null);
    } catch (thrown) {
      setPingReply(null);
      setError(toAppError(thrown));
    } finally {
      setBusy(false);
    }
  }

  async function runCommand<T>(thunk: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    try {
      const result = await thunk();
      setError(null);
      return result;
    } catch (thrown) {
      setError(toAppError(thrown));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function moveSubTeam(index: number, delta: -1 | 1) {
    const next = index + delta;
    if (next < 0 || next >= subTeams.length) return;
    const ordered = [...subTeams];
    const [moved] = ordered.splice(index, 1);
    ordered.splice(next, 0, moved);
    setSubTeams(ordered);
    // 乐观更新：先动 UI 让拖拽响应即时；后端拒绝时回滚到 DB 真值。
    const result = await runCommand(() =>
      reorderSubTeams({ orderedIds: ordered.map((s) => s.id) }),
    );
    if (result == null) {
      await refreshAll();
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">科室任务管理</h1>
          <p className="text-muted-foreground text-sm">
            人员管理 · 分子组、调岗、离岗 / 复岗
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={selfCheck} disabled={busy}>
          <Activity />
          自检
        </Button>
      </header>

      {pingReply && (
        <p className="text-muted-foreground text-xs">
          命令层已就绪（{pingReply.message}）· 服务端时间 {pingReply.now} · 数据库版本{" "}
          {pingReply.schemaVersion ?? "空库"}
        </p>
      )}

      {error && (
        <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
          {error.message}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        {/* ========== 子组面板 ========== */}
        <section className="bg-card text-card-foreground rounded-lg border p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">子组</h2>
            <Button
              size="xs"
              variant="outline"
              onClick={() => setEditingSubTeam({ kind: "new" })}
              disabled={busy}
            >
              <Plus />
              新建
            </Button>
          </div>

          {subTeams.length === 0 ? (
            <p className="text-muted-foreground text-xs">还没有子组。先创建一个开始录人。</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {subTeams.map((team, index) => {
                const selected = team.id === selectedSubTeamId;
                const headcount = peopleBySubTeam.get(team.id) ?? 0;
                return (
                  <li
                    key={team.id}
                    className={`hover:bg-muted/60 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
                      selected ? "bg-muted" : ""
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedSubTeamId(team.id)}
                      className="flex-1 cursor-pointer text-left"
                    >
                      <div className="font-medium">{team.name}</div>
                      <div className="text-muted-foreground text-xs">
                        {headcount} 人 · {team.description ?? "无描述"}
                      </div>
                    </button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      onClick={() => moveSubTeam(index, -1)}
                      disabled={busy || index === 0}
                      aria-label="上移"
                    >
                      <ArrowUp />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      onClick={() => moveSubTeam(index, 1)}
                      disabled={busy || index === subTeams.length - 1}
                      aria-label="下移"
                    >
                      <ArrowDown />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      onClick={() => setEditingSubTeam({ kind: "edit", subTeam: team })}
                      disabled={busy}
                      aria-label="编辑"
                    >
                      <Pencil />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      onClick={async () => {
                        // 不在前端预判非空——后端命令会返回明确中文错误,避免业务逻辑分散。
                        await runCommand(() => deleteSubTeam({ id: team.id }));
                        if (selectedSubTeamId === team.id) {
                          setSelectedSubTeamId(null);
                        }
                        await refreshAll();
                      }}
                      disabled={busy}
                      aria-label="删除"
                    >
                      <Trash2 />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* ========== 人员面板 ========== */}
        <section className="bg-card text-card-foreground rounded-lg border p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">
              {selectedSubTeamId == null
                ? "人员"
                : `人员 · ${subTeams.find((s) => s.id === selectedSubTeamId)?.name ?? ""}`}
            </h2>
            <Button
              size="xs"
              variant="outline"
              onClick={() => setEditingPerson({ kind: "new" })}
              disabled={busy || selectedSubTeamId == null}
            >
              <Plus />
              录人员
            </Button>
          </div>

          {selectedSubTeamId == null ? (
            <p className="text-muted-foreground text-xs">先在左侧选一个子组。</p>
          ) : (
            <PeopleList
              people={people.filter((p) => p.subTeamId === selectedSubTeamId)}
              subTeams={subTeams}
              busy={busy}
              onEdit={(person) => setEditingPerson({ kind: "edit", person })}
              onDeactivate={async (person) => {
                await runCommand(() => deactivatePerson({ id: person.id }));
                await refreshAll();
              }}
              onReactivate={async (person) => {
                await runCommand(() => reactivatePerson({ id: person.id }));
                await refreshAll();
              }}
              onDelete={async (person) => {
                await runCommand(() => deletePerson({ id: person.id }));
                await refreshAll();
              }}
            />
          )}
        </section>
      </div>

      {/* ========== 子组表单 ========== */}
      {editingSubTeam && (
        <SubTeamForm
          initial={editingSubTeam.kind === "edit" ? editingSubTeam.subTeam : null}
          busy={busy}
          onCancel={() => setEditingSubTeam(null)}
          onSubmit={async (values) => {
            const result = await runCommand(() =>
              editingSubTeam.kind === "edit"
                ? updateSubTeam({ id: editingSubTeam.subTeam.id, ...values })
                : createSubTeam(values),
            );
            if (result) {
              setEditingSubTeam(null);
              await refreshAll();
            }
          }}
        />
      )}

      {/* ========== 人员表单 ========== */}
      {editingPerson && (
        <PersonForm
          initial={editingPerson.kind === "edit" ? editingPerson.person : null}
          subTeams={subTeams}
          defaultSubTeamId={selectedSubTeamId}
          busy={busy}
          onCancel={() => setEditingPerson(null)}
          onSubmit={async (values) => {
            const result = await runCommand(() =>
              editingPerson.kind === "edit"
                ? updatePerson({ id: editingPerson.person.id, ...values })
                : createPerson(values),
            );
            if (result) {
              setEditingPerson(null);
              await refreshAll();
            }
          }}
        />
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// 子组件
// ---------------------------------------------------------------------------

function PeopleList({
  people,
  subTeams,
  busy,
  onEdit,
  onDeactivate,
  onReactivate,
  onDelete,
}: {
  people: Person[];
  subTeams: SubTeam[];
  busy: boolean;
  onEdit: (person: Person) => void;
  onDeactivate: (person: Person) => void;
  onReactivate: (person: Person) => void;
  onDelete: (person: Person) => void;
}) {
  if (people.length === 0) {
    return <p className="text-muted-foreground text-xs">子组内还没有人员。</p>;
  }
  // 直接信任后端 list_people 的顺序：在岗的在前,离岗的紧随其后,各自子组内按 id 升序。
  return (
    <ul className="flex flex-col gap-1">
      {people.map((person) => {
        const off = person.deactivatedAt != null;
        const team = subTeams.find((t) => t.id === person.subTeamId);
        return (
          <li
            key={person.id}
            className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${
              off ? "bg-muted/40 text-muted-foreground" : ""
            }`}
          >
            <div className="flex-1">
              <div className="font-medium">
                {person.name}
                {off && (
                  <span className="text-muted-foreground ml-2 text-xs">
                    （离岗 · {person.deactivatedAt}）
                  </span>
                )}
              </div>
              <div className="text-muted-foreground text-xs">
                {team?.name ?? "?"} · {person.contact}
              </div>
            </div>
            {!off && (
              <Button
                size="icon-xs"
                variant="ghost"
                onClick={() => onDeactivate(person)}
                disabled={busy}
                aria-label="离岗"
                title="离岗"
              >
                <PowerOff />
              </Button>
            )}
            {off && (
              <Button
                size="icon-xs"
                variant="ghost"
                onClick={() => onReactivate(person)}
                disabled={busy}
                aria-label="复岗"
                title="复岗"
              >
                <RotateCcw />
              </Button>
            )}
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() => onEdit(person)}
              disabled={busy}
              aria-label="编辑"
            >
              <Pencil />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() => onDelete(person)}
              disabled={busy}
              aria-label="删除"
            >
              <Trash2 />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

function SubTeamForm({
  initial,
  busy,
  onCancel,
  onSubmit,
}: {
  initial: SubTeam | null;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (values: { name: string; description: string | null }) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");

  return (
    <div className="bg-card text-card-foreground fixed inset-0 z-10 flex items-center justify-center bg-black/30 p-4">
      <form
        className="bg-background w-full max-w-sm space-y-3 rounded-lg border p-4 shadow-lg"
        onSubmit={async (event) => {
          event.preventDefault();
          await onSubmit({
            name: name.trim(),
            description: description.trim() ? description.trim() : null,
          });
        }}
      >
        <h3 className="text-sm font-semibold">
          {initial == null ? "新建子组" : `编辑子组 · ${initial.name}`}
        </h3>
        <label className="block text-sm">
          <span className="text-muted-foreground text-xs">子组名</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            autoFocus
            className="border-input bg-background mt-1 block w-full rounded-md border px-2 py-1 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="text-muted-foreground text-xs">描述（可空）</span>
          <input
            value={description ?? ""}
            onChange={(event) => setDescription(event.target.value)}
            className="border-input bg-background mt-1 block w-full rounded-md border px-2 py-1 text-sm"
          />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button type="submit" size="sm" disabled={busy || !name.trim()}>
            保存
          </Button>
        </div>
      </form>
    </div>
  );
}

function PersonForm({
  initial,
  subTeams,
  defaultSubTeamId,
  busy,
  onCancel,
  onSubmit,
}: {
  initial: Person | null;
  subTeams: SubTeam[];
  defaultSubTeamId: number | null;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (values: { name: string; subTeamId: number; contact: string }) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [contact, setContact] = useState(initial?.contact ?? "");
  const [subTeamId, setSubTeamId] = useState<number | "">(
    initial?.subTeamId ?? defaultSubTeamId ?? "",
  );

  return (
    <div className="bg-card text-card-foreground fixed inset-0 z-10 flex items-center justify-center bg-black/30 p-4">
      <form
        className="bg-background w-full max-w-sm space-y-3 rounded-lg border p-4 shadow-lg"
        onSubmit={async (event) => {
          event.preventDefault();
          if (subTeamId === "") return;
          await onSubmit({ name: name.trim(), subTeamId, contact: contact.trim() });
        }}
      >
        <h3 className="text-sm font-semibold">
          {initial == null ? "录人员" : `编辑 · ${initial.name}`}
        </h3>
        <label className="block text-sm">
          <span className="text-muted-foreground text-xs">姓名</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            autoFocus
            className="border-input bg-background mt-1 block w-full rounded-md border px-2 py-1 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="text-muted-foreground text-xs">子组</span>
          <select
            value={subTeamId}
            onChange={(event) =>
              setSubTeamId(event.target.value === "" ? "" : Number(event.target.value))
            }
            required
            className="border-input bg-background mt-1 block w-full rounded-md border px-2 py-1 text-sm"
          >
            <option value="">请选择</option>
            {subTeams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-muted-foreground text-xs">联系方式</span>
          <input
            value={contact}
            onChange={(event) => setContact(event.target.value)}
            required
            className="border-input bg-background mt-1 block w-full rounded-md border px-2 py-1 text-sm"
          />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button type="submit" size="sm" disabled={busy || !name.trim() || !contact.trim() || subTeamId === ""}>
            保存
          </Button>
        </div>
      </form>
    </div>
  );
}