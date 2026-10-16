// @vitest-environment jsdom
/**
 * 「人员」管理视图（tickets #17 / #86 T6）的组件级验证。
 *
 * 范围：
 * - 列表 / 编辑 / 离岗 / 复岗 / 录人员 / 删除 / 子组重排 等 CRUD 不再本
 *   ticket 范围——旧版测试本就缺,本期只在需要的 seam 上加 case。
 * - **#86 T6 入口②：人员行整行可点 → onOpenPerson(personId)**。
 *   行内按钮(离岗 / 复岗 / 编辑 / 删除)用 stopPropagation 阻断了冒泡,
 *   点行空白仍是 onOpenPerson。这条 case 收住所有手势。
 *
 * 命令层覆盖在 `src/main/personnel/personnel.test.ts`。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PersonnelView } from "./PersonnelView";
import {
  listPeople,
  listSubTeams,
  reactivatePerson,
  type Person,
  type SubTeam,
} from "@/lib/api";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  listSubTeams: vi.fn(),
  listPeople: vi.fn(),
  reactivatePerson: vi.fn(),
}));

const TEAMS: SubTeam[] = [
  {
    id: 1,
    name: "暖通",
    description: null,
    sortOrder: 0,
    createdAt: "2026-09-01 09:00:00",
  },
];

function makePerson(overrides: Partial<Person>): Person {
  return {
    id: 0,
    name: "",
    subTeamId: 1,
    contact: "13800000000",
    deactivatedAt: null,
    createdAt: "2026-09-01 09:00:00",
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(listSubTeams).mockResolvedValue(TEAMS);
});

describe("PersonnelView · 入口② #86 T6 人员行可点", () => {
  it("列表为空时显示子组提示,不报错", async () => {
    vi.mocked(listPeople).mockResolvedValue([]);
    render(<PersonnelView onOpenPerson={vi.fn()} />);

    expect(
      await screen.findByText(/子组内还没有人员/),
    ).toBeInTheDocument();
  });

  it("点人员行 = onOpenPerson(personId)", async () => {
    const onOpenPerson = vi.fn();
    const user = userEvent.setup();
    vi.mocked(listPeople).mockResolvedValue([
      makePerson({ id: 7, name: "张三" }),
      makePerson({ id: 8, name: "李四" }),
    ]);

    render(<PersonnelView onOpenPerson={onOpenPerson} />);

    const zhangRow = await screen.findByRole("button", {
      name: /打开 张三 的详情/,
    });
    await user.click(zhangRow);

    expect(onOpenPerson).toHaveBeenCalledWith(7);
  });

  it("点离岗人员的「复岗」按钮不触发 onOpenPerson(stopPropagation)", async () => {
    // 行内按钮的 stopPropagation 阻断冒泡——点操作行按钮不会顺带
    // openPerson。这是 #86 T6 的可测合约:行空白 = openPerson,
    // 行内按钮 = CRUD,两条手势不互相误触。
    const onOpenPerson = vi.fn();
    vi.mocked(reactivatePerson).mockResolvedValue({
      id: 9,
      name: "王五",
      subTeamId: 1,
      contact: "13800000000",
      deactivatedAt: null,
      createdAt: "2026-09-01 09:00:00",
    });
    vi.mocked(listPeople).mockResolvedValue([
      makePerson({
        id: 9,
        name: "王五",
        deactivatedAt: "2026-08-01 09:00:00",
      }),
    ]);

    const user = userEvent.setup();
    render(<PersonnelView onOpenPerson={onOpenPerson} />);

    const 复岗 = await screen.findByRole("button", { name: "复岗" });
    await user.click(复岗);

    expect(onOpenPerson).not.toHaveBeenCalled();
  });

  it("不同人员各自命中自己的 personId", async () => {
    const onOpenPerson = vi.fn();
    const user = userEvent.setup();
    vi.mocked(listPeople).mockResolvedValue([
      makePerson({ id: 11, name: "甲" }),
      makePerson({ id: 22, name: "乙" }),
    ]);

    render(<PersonnelView onOpenPerson={onOpenPerson} />);

    await user.click(
      await screen.findByRole("button", { name: /打开 甲 的详情/ }),
    );
    expect(onOpenPerson).toHaveBeenLastCalledWith(11);

    await user.click(
      await screen.findByRole("button", { name: /打开 乙 的详情/ }),
    );
    expect(onOpenPerson).toHaveBeenLastCalledWith(22);

    expect(onOpenPerson).toHaveBeenCalledTimes(2);
  });
});
