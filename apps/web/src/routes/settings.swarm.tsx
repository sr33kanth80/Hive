import { createFileRoute } from "@tanstack/react-router";

import { SwarmPanel } from "../components/hive/SwarmPanel";

export const Route = createFileRoute("/settings/swarm")({
  component: SwarmPanel,
});
