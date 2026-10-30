/**
 * @jest-environment jsdom
 */
import { describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TreeResponse } from "@docbridge/contracts";
import { TreeView } from "../src/features/tree/TreeView";

const tree: TreeResponse = {
  teams: [
    {
      id: "t1",
      name: "Alpha Team",
      binders: [
        {
          id: "b1",
          name: "Invoices",
          folders: [
            {
              id: "f1",
              name: "2024",
              folders: [{ id: "f2", name: "Archive", folders: [] }],
            },
            { id: "f3", name: "Inbox", folders: [] },
          ],
        },
      ],
    },
    {
      id: "t2",
      name: "Beta Team",
      binders: [
        {
          id: "b2",
          name: "Legal",
          folders: [{ id: "f4", name: "Contracts", folders: [] }],
        },
      ],
    },
  ],
};

describe("TreeView", () => {
  it("renders teams collapsed and reveals folders on click", async () => {
    const user = userEvent.setup();
    render(<TreeView tree={tree} />);
    expect(screen.getByText("Alpha Team")).toBeDefined();
    expect(screen.queryByText("Invoices")).toBeNull();

    await user.click(screen.getByText("Alpha Team"));
    expect(screen.getByText("Invoices")).toBeDefined();
    expect(screen.queryByText("2024")).toBeNull();

    await user.click(screen.getByText("Invoices"));
    expect(screen.getByText("2024")).toBeDefined();
    expect(screen.queryByText("Archive")).toBeNull();

    await user.click(screen.getByText("2024"));
    expect(screen.getByText("Archive")).toBeDefined();
  });

  it("filters to the matching folder's chain", async () => {
    const user = userEvent.setup();
    render(<TreeView tree={tree} />);
    await user.type(screen.getByLabelText("Filter destinations"), "archive");
    expect(screen.getByText("Alpha Team")).toBeDefined();
    expect(screen.getByText("Archive")).toBeDefined();
    expect(screen.queryByText("Beta Team")).toBeNull();
    expect(screen.queryByText("Inbox")).toBeNull();
  });

  it("expand all reveals everything", async () => {
    const user = userEvent.setup();
    render(<TreeView tree={tree} />);
    await user.click(screen.getByRole("button", { name: "Expand all" }));
    expect(screen.getByText("Archive")).toBeDefined();
    expect(screen.getByText("Contracts")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.queryByText("Invoices")).toBeNull();
  });

  it("selection mode toggles folders without expanding them", async () => {
    const user = userEvent.setup();
    const onToggle = jest.fn();
    const { rerender } = render(
      <TreeView
        tree={tree}
        selection={{
          selected: new Set(["f1"]),
          onToggle,
          limitReached: false,
        }}
      />,
    );
    await user.click(screen.getByText("Alpha Team"));
    await user.click(screen.getByText("Invoices"));
    const inbox = screen.getByRole("checkbox", { name: "Inbox" });
    await user.click(inbox);
    expect(onToggle).toHaveBeenCalledWith("f3");
    expect(screen.getByRole("checkbox", { name: "2024" })).toBeDefined();
    expect(screen.queryByText("Archive")).toBeNull();

    rerender(
      <TreeView
        tree={tree}
        selection={{
          selected: new Set(["f1"]),
          onToggle,
          limitReached: true,
        }}
      />,
    );
    const checked = screen.getByRole("checkbox", { name: "2024" });
    const disabled = screen.getByRole("checkbox", { name: "Inbox" });
    expect(checked.getAttribute("aria-checked")).toBe("true");
    expect(checked.getAttribute("aria-disabled")).toBeNull();
    expect(disabled.getAttribute("aria-disabled")).toBe("true");
    await user.click(disabled);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("shows the assigned-destinations empty state", () => {
    render(<TreeView tree={{ teams: [] }} />);
    expect(
      screen.getByText("No destinations are assigned to your account."),
    ).toBeDefined();
  });
});
