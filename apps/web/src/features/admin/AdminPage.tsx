import { FormEvent, useState } from "react";
import { Checkbox } from "@base-ui-components/react/checkbox";
import { Dialog } from "@base-ui-components/react/dialog";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { UserResponse } from "@docbridge/contracts";
import { ApiError } from "../../lib/api";
import { Button } from "../../components/Button";
import { Input } from "../../components/Input";
import {
  createUser,
  disableUser,
  listUsers,
  replaceTeams,
  useTeams,
} from "./api";

interface TeamOption {
  id: string;
  name: string;
}

function TeamCheckboxes({
  teams,
  selected,
  onToggle,
}: {
  teams: TeamOption[];
  selected: Set<string>;
  onToggle: (id: string, checked: boolean) => void;
}) {
  if (teams.length === 0) {
    return <p className="text-sm text-muted">No teams available.</p>;
  }
  return (
    <div className="flex flex-wrap gap-3">
      {teams.map((team) => (
        <label
          key={team.id}
          className="flex items-center gap-1.5 text-sm text-ink"
        >
          <Checkbox.Root
            checked={selected.has(team.id)}
            onCheckedChange={(checked) => onToggle(team.id, checked === true)}
            aria-label={team.name}
            className="flex h-4 w-4 items-center justify-center rounded border border-line bg-surface data-[checked]:border-accent-fill data-[checked]:bg-accent-fill"
          >
            <Checkbox.Indicator className="text-accent-ink">✓</Checkbox.Indicator>
          </Checkbox.Root>
          {team.name}
        </label>
      ))}
    </div>
  );
}

function TeamEditor({
  user,
  teams,
  onClose,
}: {
  user: UserResponse;
  teams: TeamOption[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set(user.teamIds));
  const mutation = useMutation({
    mutationFn: () => replaceTeams(user.id, [...selected]),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["users"] });
      onClose();
    },
  });
  return (
    <div className="space-y-2 py-2">
      <TeamCheckboxes
        teams={teams}
        selected={selected}
        onToggle={(id, checked) =>
          setSelected((prev) => {
            const next = new Set(prev);
            if (checked) {
              next.add(id);
            } else {
              next.delete(id);
            }
            return next;
          })
        }
      />
      {mutation.isError && (
        <p className="text-sm text-rose-600 dark:text-rose-300" role="alert">
          {mutation.error instanceof ApiError
            ? mutation.error.message
            : "Failed to update teams."}
        </p>
      )}
      <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
        Save teams
      </Button>
    </div>
  );
}

function NewUserDialog({
  open,
  onOpenChange,
  teams,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teams: TeamOption[];
}) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [teamIds, setTeamIds] = useState<Set<string>>(new Set());
  const mutation = useMutation({
    mutationFn: () =>
      createUser({ email, displayName, password, teamIds: [...teamIds] }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["users"] });
      onOpenChange(false);
      setEmail("");
      setDisplayName("");
      setPassword("");
      setTeamIds(new Set());
    },
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    mutation.mutate();
  };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/40" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-surface p-6 shadow-[0_24px_60px_rgba(0,0,0,0.35)]">
          <Dialog.Title className="mb-4 text-lg font-semibold text-ink">
            New user
          </Dialog.Title>
          <form onSubmit={onSubmit} className="space-y-4">
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-ink">
                Email
              </span>
              <Input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-ink">
                Display name
              </span>
              <Input
                required
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-ink">
                Password
              </span>
              <Input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <div>
              <span className="mb-1 block text-sm font-medium text-ink">
                Teams
              </span>
              <TeamCheckboxes
                teams={teams}
                selected={teamIds}
                onToggle={(id, checked) =>
                  setTeamIds((prev) => {
                    const next = new Set(prev);
                    if (checked) {
                      next.add(id);
                    } else {
                      next.delete(id);
                    }
                    return next;
                  })
                }
              />
            </div>
            {mutation.isError && (
              <p className="text-sm text-rose-600 dark:text-rose-300" role="alert">
                {mutation.error instanceof ApiError &&
                mutation.error.code === "email_already_exists"
                  ? "A user with this email already exists."
                  : mutation.error instanceof ApiError
                    ? mutation.error.message
                    : "Failed to create user."}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Dialog.Close
                render={
                  <Button variant="secondary" type="button">
                    Cancel
                  </Button>
                }
              />
              <Button type="submit" disabled={mutation.isPending}>
                Create user
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function AdminPage() {
  const teams = useTeams();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const users = useInfiniteQuery({
    queryKey: ["users"],
    queryFn: ({ pageParam }) => listUsers(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const disableMutation = useMutation({
    mutationFn: (id: string) => disableUser(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["users"] });
    },
  });
  const teamName = (id: string) =>
    teams.data?.find((t) => t.id === id)?.name ?? id.slice(0, 8);
  const allUsers = users.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-ink">Users</h1>
        <Button onClick={() => setDialogOpen(true)}>New user</Button>
      </div>
      {users.isPending ? (
        <p className="text-sm text-muted">Loading users…</p>
      ) : users.isError ? (
        <p className="text-sm text-rose-600 dark:text-rose-300" role="alert">
          {users.error instanceof ApiError
            ? users.error.message
            : "Failed to load users."}
        </p>
      ) : (
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-line text-muted">
              <th className="py-2 pr-4 font-medium">Email</th>
              <th className="py-2 pr-4 font-medium">Name</th>
              <th className="py-2 pr-4 font-medium">Teams</th>
              <th className="py-2 pr-4 font-medium">Admin</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {allUsers.map((user) => (
              <tr
                key={user.id}
                className="border-b border-line align-top text-ink"
              >
                <td className="py-2 pr-4">{user.email}</td>
                <td className="py-2 pr-4">{user.displayName}</td>
                <td className="py-2 pr-4">
                  {user.teamIds.length > 0
                    ? user.teamIds.map(teamName).join(", ")
                    : "—"}
                  {editingUserId === user.id && (
                    <TeamEditor
                      user={user}
                      teams={teams.data ?? []}
                      onClose={() => setEditingUserId(null)}
                    />
                  )}
                </td>
                <td className="py-2 pr-4">
                  {user.isAdmin && (
                    <span className="rounded-md bg-accent-soft px-1.5 py-0.5 text-xs font-medium text-accent">
                      admin
                    </span>
                  )}
                </td>
                <td className="py-2 pr-4">
                  {user.disabledAt ? "Disabled" : "Active"}
                </td>
                <td className="space-x-2 py-2">
                  <Button
                    variant="secondary"
                    onClick={() =>
                      setEditingUserId((prev) =>
                        prev === user.id ? null : user.id,
                      )
                    }
                  >
                    Edit teams
                  </Button>
                  <Button
                    variant="danger"
                    disabled={
                      Boolean(user.disabledAt) || disableMutation.isPending
                    }
                    onClick={() => disableMutation.mutate(user.id)}
                  >
                    Disable
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {users.hasNextPage && (
        <Button
          variant="secondary"
          onClick={() => void users.fetchNextPage()}
          disabled={users.isFetchingNextPage}
        >
          {users.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      )}
      <NewUserDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        teams={teams.data ?? []}
      />
    </div>
  );
}
