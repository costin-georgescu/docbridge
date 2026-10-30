/**
 * @jest-environment jsdom
 */
import { describe, expect, it, jest } from "@jest/globals";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TreeResponse } from "@docbridge/contracts";
import { JobComposer } from "../src/features/jobs/JobComposer";
import { UploadItem } from "../src/features/uploads/upload-manager";
import { ApiError } from "../src/lib/api";

const FILE_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const FILE_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const F_2024 = "11111111-0000-4000-8000-000000000001";
const F_CONTRACTS = "22222222-0000-4000-8000-000000000002";
const JOB_ID = "33333333-0000-4000-8000-000000000003";

const tree: TreeResponse = {
  teams: [
    {
      id: "t1",
      name: "Alpha Team",
      binders: [
        {
          id: "b1",
          name: "Invoices",
          folders: [{ id: F_2024, name: "2024", folders: [] }],
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
          folders: [{ id: F_CONTRACTS, name: "Contracts", folders: [] }],
        },
      ],
    },
  ],
};

function item(overrides: Partial<UploadItem>): UploadItem {
  return {
    id: "i1",
    name: "a.pdf",
    sizeBytes: 2048,
    contentType: "application/pdf",
    phase: "staged",
    progress: 1,
    fileId: FILE_A,
    error: null,
    ...overrides,
  };
}

const twoItems = [
  item({ id: "i1", name: "a.pdf", fileId: FILE_A }),
  item({ id: "i2", name: "b.pdf", fileId: FILE_B }),
];

function renderComposer(
  props: Partial<Parameters<typeof JobComposer>[0]> = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const submit =
    props.submit ?? jest.fn(() => Promise.resolve({ jobId: JOB_ID }));
  const onSubmitted = props.onSubmitted ?? jest.fn();
  render(
    <QueryClientProvider client={client}>
      <JobComposer
        items={props.items ?? twoItems}
        tree={props.tree ?? tree}
        submit={submit}
        onSubmitted={onSubmitted}
      />
    </QueryClientProvider>,
  );
  return { submit, onSubmitted };
}

async function expandAll(user: ReturnType<typeof userEvent.setup>) {
  for (const name of ["Alpha Team", "Invoices", "Beta Team", "Legal"]) {
    const el = screen.queryByText(name);
    if (el) {
      await user.click(el);
    }
  }
}

describe("JobComposer", () => {
  it("maps files to folders and submits the job", async () => {
    const user = userEvent.setup();
    const { submit, onSubmitted } = renderComposer();
    await expandAll(user);

    await user.click(screen.getByRole("checkbox", { name: "2024" }));
    await user.click(screen.getByRole("checkbox", { name: "Contracts" }));

    expect(screen.getByText("Folders 2/20")).toBeDefined();
    expect(screen.getByRole("columnheader", { name: /2024/ })).toBeDefined();
    expect(
      screen.getByRole("columnheader", { name: /Contracts/ }),
    ).toBeDefined();

    const submitButton = screen.getByRole("button", { name: "Submit" });
    expect(submitButton).toHaveProperty("disabled", true);
    expect(screen.getByText("2 file(s) have no destination.")).toBeDefined();

    await user.click(
      screen.getByRole("checkbox", {
        name: "Assign Alpha Team / Invoices / 2024 to all files",
      }),
    );
    await user.click(
      screen.getByRole("checkbox", {
        name: "b.pdf: Beta Team / Legal / Contracts",
      }),
    );
    // header + one chip per row
    expect(screen.getAllByTitle("Alpha Team / Invoices / 2024")).toHaveLength(
      3,
    );

    // Remove the Contracts chip from b.pdf, then re-check the cell.
    await user.click(
      screen.getByRole("button", {
        name: "Remove Beta Team / Legal / Contracts from b.pdf",
      }),
    );
    expect(
      screen
        .getByRole("checkbox", {
          name: "b.pdf: Beta Team / Legal / Contracts",
        })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      screen.queryByRole("button", {
        name: "Remove Beta Team / Legal / Contracts from b.pdf",
      }),
    ).toBeNull();
    await user.click(
      screen.getByRole("checkbox", {
        name: "b.pdf: Beta Team / Legal / Contracts",
      }),
    );

    await user.click(submitButton);
    await waitFor(() => {
      expect(submit).toHaveBeenCalledWith({
        mappings: [
          { fileId: FILE_A, folderIds: [F_2024] },
          { fileId: FILE_B, folderIds: [F_2024, F_CONTRACTS] },
        ],
      });
    });
    await waitFor(() => {
      expect(onSubmitted).toHaveBeenCalledWith(["i1", "i2"], JOB_ID);
    });
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Job submitted.");
    expect(status.textContent).toContain(JOB_ID);
  });

  it("keeps Submit disabled while a file is uploading", async () => {
    renderComposer({
      items: [
        item({ id: "u1", phase: "uploading", fileId: null, progress: 0.4 }),
        twoItems[1],
      ],
    });
    expect(
      screen.getByText("Waiting for 1 file(s) to finish uploading."),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Submit" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("disables the remaining tree checkboxes at 20 folders", async () => {
    const user = userEvent.setup();
    const folders = Array.from({ length: 21 }, (_, i) => ({
      id: `f${String(i).padStart(3, "0")}-0000-4000-8000-000000000000`,
      name: `Folder ${String(i + 1).padStart(2, "0")}`,
      folders: [],
    }));
    const bigTree: TreeResponse = {
      teams: [
        {
          id: "t1",
          name: "Alpha Team",
          binders: [{ id: "b1", name: "Invoices", folders }],
        },
      ],
    };
    renderComposer({ items: [twoItems[0]], tree: bigTree });
    await user.click(screen.getByText("Alpha Team"));
    await user.click(screen.getByText("Invoices"));
    for (let i = 1; i <= 20; i++) {
      await user.click(
        screen.getByRole("checkbox", {
          name: `Folder ${String(i).padStart(2, "0")}`,
        }),
      );
    }
    expect(screen.getByText("Folders 20/20")).toBeDefined();
    const last = screen.getByRole("checkbox", { name: "Folder 21" });
    expect(last.getAttribute("aria-disabled")).toBe("true");
    await user.click(last);
    expect(screen.getByText("Folders 20/20")).toBeDefined();
  });

  it("shows the API error with the offending file name", async () => {
    const user = userEvent.setup();
    const submit = jest.fn(() =>
      Promise.reject(
        new ApiError(
          409,
          "file_already_submitted",
          "Files were already submitted",
          {
            fileIds: [FILE_A],
          },
        ),
      ),
    );
    renderComposer({ submit });
    await expandAll(user);
    await user.click(screen.getByRole("checkbox", { name: "2024" }));
    await user.click(
      screen.getByRole("checkbox", {
        name: "Assign Alpha Team / Invoices / 2024 to all files",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Submit" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Files were already submitted");
    expect(alert.textContent).toContain("a.pdf");
    expect(alert.textContent).not.toContain("b.pdf");
  });
});
