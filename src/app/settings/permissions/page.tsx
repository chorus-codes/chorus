import { PermissionsForm } from "./permissions-form";
import { getPermissions } from "@/lib/api/settings";

export const dynamic = "force-dynamic";

export default async function PermissionsPage() {
  const settings = await getPermissions();

  return (
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">Permissions & sandbox</h1>
          <p className="text-sm text-muted-foreground">
            Controls what chorus-spawned reviewers can do on your machine. Settings here apply
            to every reviewer launched by every chat — they don&apos;t override per-template config.
          </p>
        </header>

        <PermissionsForm initial={settings} />
      </div>
  );
}
