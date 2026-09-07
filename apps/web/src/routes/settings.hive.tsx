import { createFileRoute } from "@tanstack/react-router";

import { ConflictsPanel } from "../components/hive/ConflictsPanel";

export const Route = createFileRoute("/settings/hive")({
  component: ConflictsPanel,
});
