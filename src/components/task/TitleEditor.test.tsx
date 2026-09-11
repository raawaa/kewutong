/**
 * contenteditable 标题 + `@` 内联选人的组件级验证（ticket #19 验收点：
 * 「前端组件级测试覆盖 chip 选值与 `@` autocomplete 候选过滤」）。
 *
 * 候选过滤的**权威在命令层**——本组件只把 `@` 后面打出的词原样交给
 * `fetchCandidates`，再渲染返回的列表。测试因此断言两件事：
 * 交出去的 query 对不对，拿回来的候选渲染 / 选中对不对。
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TitleEditor } from "./TitleEditor";
import type { AssigneeCandidate, ProjectCandidate } from "@/lib/ipc";

const 张三: AssigneeCandidate = { personId: 1, name: "张三", subTeamName: "暖通" };
const 张小五: AssigneeCandidate = { personId: 2, name: "张小五", subTeamName: "暖通" };
const 王五: AssigneeCandidate = { personId: 3, name: "王五", subTeamName: "电气" };

const 综合楼: ProjectCandidate = { projectId: 11, name: "综合楼改造", subTeamName: "暖通" };
const 管网: ProjectCandidate = { projectId: 12, name: "管网普查", subTeamName: "电气" };

/** 站在命令层的位置：按 query 过滤的是它，不是组件。 */
function 命令层候选(all: AssigneeCandidate[] = [张三, 张小五, 王五]) {
  return vi.fn(async (query: string) =>
    all.filter((candidate) => candidate.name.includes(query)),
  );
}

function 命令层项目候选(all: ProjectCandidate[] = [综合楼, 管网]) {
  return vi.fn(async (query: string) =>
    all.filter((candidate) => candidate.name.includes(query)),
  );
}

function setup(
  overrides: Partial<Parameters<typeof TitleEditor>[0]> = {},
) {
  const onChange = vi.fn();
  const fetchAssigneeCandidates =
    overrides.fetchAssigneeCandidates ?? 命令层候选();
  const fetchProjectCandidates =
    overrides.fetchProjectCandidates ?? 命令层项目候选();
  const user = userEvent.setup();
  render(
    <TitleEditor
      initialTitle=""
      initialAssignee={null}
      initialProject={null}
      onChange={onChange}
      fetchAssigneeCandidates={fetchAssigneeCandidates}
      fetchProjectCandidates={fetchProjectCandidates}
      {...overrides}
    />,
  );
  return {
    onChange,
    fetchAssigneeCandidates,
    fetchProjectCandidates,
    user,
    box: screen.getByRole("textbox"),
  };
}

describe("TitleEditor · 纯标题", () => {
  it("打字上报标题文本", async () => {
    const { onChange, user, box } = setup();

    await user.click(box);
    await user.type(box, "整理季度报表");

    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith({
        title: "整理季度报表",
        assignee: null,
        project: null,
      }),
    );
  });

  it("编辑态用已有标题与负责人开场", () => {
    setup({ initialTitle: "整理季度报表", initialAssignee: 张三 });

    const box = screen.getByRole("textbox");
    expect(box).toHaveTextContent("整理季度报表");
    expect(box).toHaveTextContent("@张三");
  });

  it("编辑态用已有项目开场", () => {
    setup({ initialTitle: "整理季度报表", initialProject: 综合楼 });

    const box = screen.getByRole("textbox");
    expect(box).toHaveTextContent("#综合楼改造");
  });
});

describe("TitleEditor · @ autocomplete", () => {
  it("打 @ 唤起候选下拉", async () => {
    const { user, box } = setup();

    await user.click(box);
    await user.type(box, "@");

    expect(await screen.findByRole("listbox")).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: /张三/ })).toBeInTheDocument();
  });

  it("把 @ 后面打出的词原样交给命令层过滤", async () => {
    const { fetchAssigneeCandidates, user, box } = setup();

    await user.click(box);
    await user.type(box, "整理@张");

    await waitFor(() => expect(fetchAssigneeCandidates).toHaveBeenLastCalledWith("张"));
  });

  it("只渲染命令层给回来的候选", async () => {
    const { user, box } = setup();

    await user.click(box);
    await user.type(box, "@张");

    await waitFor(() => {
      const names = screen
        .getAllByRole("option")
        .map((option) => option.textContent);
      expect(names).toHaveLength(2);
      expect(names[0]).toContain("张三");
      expect(names[1]).toContain("张小五");
    });
    expect(screen.queryByRole("option", { name: /王五/ })).not.toBeInTheDocument();
  });

  it("候选副行显示子组名——跨组重名时科长才选得准", async () => {
    const { user, box } = setup();

    await user.click(box);
    await user.type(box, "@王");

    expect(await screen.findByRole("option", { name: /王五/ })).toHaveTextContent(
      "电气",
    );
  });

  it("命令层给空列表时不显示下拉", async () => {
    const { user, box } = setup({ fetchAssigneeCandidates: 命令层候选([]) });

    await user.click(box);
    await user.type(box, "@不存在");

    await waitFor(() =>
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument(),
    );
  });

  it("@ 后面打了空格就不再是候选输入", async () => {
    const { user, box } = setup();

    await user.click(box);
    await user.type(box, "@ 开会");

    await waitFor(() =>
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument(),
    );
  });

  it("点候选把人员插进标题并上报负责人", async () => {
    const { onChange, user, box } = setup();

    await user.click(box);
    await user.type(box, "整理季度报表 @张");
    await user.click(await screen.findByRole("option", { name: /张小五/ }));

    expect(box).toHaveTextContent("@张小五");
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith({
        title: "整理季度报表",
        assignee: 张小五,
        project: null,
      }),
    );
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("回车选中当前高亮的候选", async () => {
    const { onChange, user, box } = setup();

    await user.click(box);
    await user.type(box, "@张");
    await screen.findByRole("option", { name: /张三/ });
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith({ title: "", assignee: 张三, project: null }),
    );
  });

  it("上下键移动高亮", async () => {
    const { onChange, user, box } = setup();

    await user.click(box);
    await user.type(box, "@张");
    await screen.findByRole("option", { name: /张三/ });
    await user.keyboard("{ArrowDown}{Enter}");

    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith({ title: "", assignee: 张小五, project: null }),
    );
  });

  it("上下键在两端回环", async () => {
    const { onChange, user, box } = setup();

    await user.click(box);
    await user.type(box, "@张");
    await screen.findByRole("option", { name: /张三/ });
    await user.keyboard("{ArrowUp}{Enter}");

    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith({ title: "", assignee: 张小五, project: null }),
    );
  });

  it("Esc 只关下拉，不清标题", async () => {
    const { user, box } = setup();

    await user.click(box);
    await user.type(box, "开会@张");
    await screen.findByRole("listbox");
    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument(),
    );
    expect(box).toHaveTextContent("开会@张");
  });

  it("一条任务只有一个负责人：再选一个人会换掉前一个", async () => {
    const { onChange, user, box } = setup();

    await user.click(box);
    await user.type(box, "@张");
    await user.click(await screen.findByRole("option", { name: /张三/ }));
    await user.type(box, "@王");
    await user.click(await screen.findByRole("option", { name: /王五/ }));

    expect(box).toHaveTextContent("@王五");
    expect(box).not.toHaveTextContent("@张三");
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith({ title: "", assignee: 王五, project: null }),
    );
  });

  it("候选下拉开着时回车不提交表单", async () => {
    const onSubmit = vi.fn();
    const { user, box } = setup({ onSubmit });

    await user.click(box);
    await user.type(box, "@张");
    await screen.findByRole("option", { name: /张三/ });
    await user.keyboard("{Enter}");

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("候选下拉关着时回车提交表单", async () => {
    const onSubmit = vi.fn();
    const { user, box } = setup({ onSubmit });

    await user.click(box);
    await user.type(box, "整理季度报表");
    await user.keyboard("{Enter}");

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("TitleEditor · # autocomplete", () => {
  it("打 # 唤起项目候选下拉", async () => {
    const { user, box } = setup();

    await user.click(box);
    await user.type(box, "#");

    const lists = await screen.findAllByRole("listbox");
    // 项目候选的下拉用 aria-label 标记
    const projectList = lists.find(
      (list) => list.getAttribute("aria-label") === "项目候选",
    );
    expect(projectList).toBeDefined();
    expect(
      await screen.findByRole("option", { name: /综合楼改造/ }),
    ).toBeInTheDocument();
  });

  it("把 # 后面打出的词原样交给命令层", async () => {
    const { fetchProjectCandidates, user, box } = setup();

    await user.click(box);
    await user.type(box, "#综合");

    await waitFor(() =>
      expect(fetchProjectCandidates).toHaveBeenLastCalledWith("综合"),
    );
  });

  it("点 # 候选把项目 pill 插进标题并上报 project", async () => {
    const { onChange, user, box } = setup();

    await user.click(box);
    await user.type(box, "改造 #综");
    await user.click(await screen.findByRole("option", { name: /综合楼改造/ }));

    expect(box).toHaveTextContent("#综合楼改造");
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith({
        title: "改造",
        assignee: null,
        project: 综合楼,
      }),
    );
  });

  it("项目和负责人共存", async () => {
    const { onChange, user, box } = setup();

    await user.click(box);
    await user.type(box, "#综");
    await user.click(await screen.findByRole("option", { name: /综合楼改造/ }));
    await user.type(box, "@张");
    await user.click(await screen.findByRole("option", { name: /张三/ }));

    expect(box).toHaveTextContent("#综合楼改造");
    expect(box).toHaveTextContent("@张三");
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith({
        title: "",
        assignee: 张三,
        project: 综合楼,
      }),
    );
  });

  it("# 后面打了空格就不再是候选输入", async () => {
    const { user, box } = setup();

    await user.click(box);
    await user.type(box, "# 开会");

    await waitFor(() =>
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument(),
    );
  });
});
