import { PageHeader } from "@/components/page-header";
import { RunsTable } from "@/components/runs-table";
import { listChats, DaemonError } from "@/lib/api";

export const dynamic = "force-dynamic";


async function getChats() {
  try {
    const chats = await listChats({ limit: 200 });
    return { chats, error: null };
  } catch (err) {
    return {
      chats: [],
      error:
        err instanceof DaemonError ? err.message : "Failed to load chats",
    };
  }
}

export default async function RunsListPage() {
  const { chats, error } = await getChats();

  return (
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8 md:px-8 md:py-10">
        <PageHeader
          eyebrow="History"
          title="All chats"
          subtitle="Browse previous runs and their outcomes."
        />

        {error && (
          <div className="mb-4 rounded-lg border border-destructive/50 bg-destructive/10 p-4">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        <RunsTable chats={chats} />
      </div>
  );
}
